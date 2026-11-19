//! One source's page (its newest items, a page at a time, and a search of it) and the reader that shows one item.

use std::{cell::RefCell, collections::VecDeque, rc::Rc};

use gtk::{gdk, gio, glib, prelude::*};
use serde_json::Value;

use crate::{
    api::segment,
    ui::{App, SourceInfo, route_of, when},
};

const PAGE: usize = 50;
/// A grid picture's side, and how many are fetched at once (each may be a download by the product).
const TILE: i32 = 168;
const FETCHES: usize = 4;

/// The picture ghostd serves for an item, or nothing when it has none.
async fn picture_of(app: &App, source: &str, id: &str) -> Option<gdk::Texture> {
    let bytes = app.api.bytes(format!("/api/sources/{}/items/{}/picture", segment(source), segment(id))).await.ok()?;
    gdk::Texture::from_bytes(&glib::Bytes::from_owned(bytes)).ok()
}

/// A grid tile for one item with a picture, which arrives later. A spacer fixes the tile's size (a picture would ask
/// for its own), and the picture overlays it, cropped to fill.
fn tile(item: &Value) -> (gtk::FlowBoxChild, gtk::Picture) {
    let spacer = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    spacer.set_size_request(TILE, TILE);
    spacer.add_css_class("tile");
    let picture = gtk::Picture::new();
    picture.set_content_fit(gtk::ContentFit::Cover);
    picture.set_can_shrink(true);
    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(&spacer));
    overlay.add_overlay(&picture);
    overlay.set_overflow(gtk::Overflow::Hidden);
    let child = gtk::FlowBoxChild::new();
    child.set_halign(gtk::Align::Start);
    child.set_child(Some(&overlay));
    let title = item["title"].as_str().unwrap_or_default();
    let time = when(&item["at"]);
    child.set_tooltip_text(Some(&if time.is_empty() { title.to_string() } else { format!("{title} · {time}") }));
    (child, picture)
}

/// A list row for one item: its title, when it is from, and its snippet.
pub fn item_row(item: &Value) -> gtk::ListBoxRow {
    let row = gtk::ListBoxRow::new();
    row.add_css_class("result");
    let content = gtk::Box::new(gtk::Orientation::Vertical, 2);
    let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let title = gtk::Label::new(item["title"].as_str());
    title.add_css_class("result-title");
    title.set_xalign(0.0);
    title.set_hexpand(true);
    title.set_ellipsize(gtk::pango::EllipsizeMode::End);
    head.append(&title);
    let time = when(&item["at"]);
    if !time.is_empty() {
        let meta = gtk::Label::new(Some(&time));
        meta.add_css_class("meta");
        head.append(&meta);
    }
    content.append(&head);
    if let Some(snippet) = item["snippet"].as_str().filter(|text| !text.is_empty()) {
        let label = gtk::Label::new(Some(snippet));
        label.add_css_class("snippet");
        label.add_css_class("dim");
        label.set_xalign(0.0);
        label.set_wrap(true);
        label.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        label.set_lines(2);
        label.set_ellipsize(gtk::pango::EllipsizeMode::End);
        content.append(&label);
    }
    row.set_child(Some(&content));
    row
}

pub struct SourcePage {
    pub root: gtk::Box,
    app: Rc<App>,
    info: SourceInfo,
    list: gtk::ListBox,
    /// Used instead of the list by a source whose items have pictures.
    grid: gtk::FlowBox,
    /// Tiles still waiting for their picture, with the listing they belong to.
    waiting: RefCell<VecDeque<(u64, String, gtk::Picture)>>,
    fetching: RefCell<usize>,
    more: gtk::Button,
    status: gtk::Label,
    items: RefCell<Vec<Value>>,
    cursor: RefCell<Option<String>>,
    /// Bumped by each new listing or search, so a slower earlier reply is dropped.
    generation: RefCell<u64>,
}

impl SourcePage {
    pub fn build(app: &Rc<App>, info: &SourceInfo) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 10);
        root.set_margin_top(14);
        root.set_margin_bottom(14);
        root.set_margin_start(18);
        root.set_margin_end(18);

        let entry = gtk::SearchEntry::new();
        entry.add_css_class("search-large");
        entry.set_placeholder_text(Some(&format!("Search {}", info.label)));
        entry.set_visible(info.search);
        root.append(&entry);

        let list = gtk::ListBox::new();
        list.add_css_class("results");
        list.set_selection_mode(gtk::SelectionMode::None);
        list.set_visible(!info.pictures);
        let grid = gtk::FlowBox::new();
        grid.add_css_class("tiles");
        grid.set_selection_mode(gtk::SelectionMode::None);
        grid.set_max_children_per_line(12);
        grid.set_row_spacing(4);
        grid.set_column_spacing(4);
        grid.set_valign(gtk::Align::Start);
        grid.set_visible(info.pictures);
        let status = gtk::Label::new(None);
        status.add_css_class("empty-state");
        status.set_wrap(true);
        status.set_margin_top(18);
        let more = gtk::Button::with_label("Load more");
        more.add_css_class("chip");
        more.set_halign(gtk::Align::Center);
        more.set_visible(false);
        let column = gtk::Box::new(gtk::Orientation::Vertical, 8);
        column.append(&list);
        column.append(&grid);
        column.append(&status);
        column.append(&more);
        let scroll = gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&column).build();
        root.append(&scroll);

        let page = Rc::new(Self {
            root,
            app: app.clone(),
            info: info.clone(),
            list,
            grid,
            waiting: RefCell::new(VecDeque::new()),
            fetching: RefCell::new(0),
            more,
            status,
            items: RefCell::new(Vec::new()),
            cursor: RefCell::new(None),
            generation: RefCell::new(0),
        });

        let this = page.clone();
        page.list.connect_row_activated(move |_, row| {
            let item = this.items.borrow().get(row.index() as usize).cloned();
            if let Some(item) = item {
                this.app.navigate(route_of(&item));
            }
        });
        let this = page.clone();
        page.grid.connect_child_activated(move |_, child| {
            let item = this.items.borrow().get(child.index() as usize).cloned();
            if let Some(item) = item {
                this.app.navigate(route_of(&item));
            }
        });
        let this = page.clone();
        page.more.connect_clicked(move |_| this.load(false));
        let this = page.clone();
        entry.connect_search_changed(move |entry| {
            let query = entry.text().trim().to_string();
            if query.is_empty() { this.load(true) } else { this.search(query) }
        });
        page.load(true);
        page
    }

    fn reset(&self) -> u64 {
        while let Some(child) = self.list.first_child() {
            self.list.remove(&child);
        }
        while let Some(child) = self.grid.first_child() {
            self.grid.remove(&child);
        }
        self.waiting.borrow_mut().clear();
        self.items.borrow_mut().clear();
        *self.cursor.borrow_mut() = None;
        self.more.set_visible(false);
        *self.generation.borrow_mut() += 1;
        *self.generation.borrow()
    }

    fn append(self: &Rc<Self>, items: &[Value]) {
        let generation = *self.generation.borrow();
        for item in items {
            if self.info.pictures {
                let (child, picture) = tile(item);
                self.grid.append(&child);
                self.waiting.borrow_mut().push_back((generation, item["id"].as_str().unwrap_or_default().to_string(), picture));
            } else {
                self.list.append(&item_row(item));
            }
            self.items.borrow_mut().push(item.clone());
        }
        self.fetch_pictures();
    }

    /// Fill the waiting tiles, a few at a time, in the order they are shown.
    fn fetch_pictures(self: &Rc<Self>) {
        while *self.fetching.borrow() < FETCHES {
            let Some((generation, id, picture)) = self.waiting.borrow_mut().pop_front() else { return };
            *self.fetching.borrow_mut() += 1;
            let this = self.clone();
            glib::spawn_future_local(async move {
                // A tile of a listing since replaced is no longer shown.
                if *this.generation.borrow() == generation
                    && let Some(texture) = picture_of(&this.app, &this.info.id, &id).await
                {
                    picture.set_paintable(Some(&texture));
                }
                *this.fetching.borrow_mut() -= 1;
                this.fetch_pictures();
            });
        }
    }

    /// The newest items, or the next page of them.
    fn load(self: &Rc<Self>, fresh: bool) {
        if !self.info.list {
            self.reset();
            self.status.set_text(&format!("Search {} above.", self.info.label));
            return;
        }
        let generation = if fresh { self.reset() } else { *self.generation.borrow() };
        let cursor = self.cursor.borrow().clone();
        let mut path = format!("/api/sources/{}/items?limit={PAGE}", segment(&self.info.id));
        if let Some(cursor) = cursor {
            path.push_str(&format!("&cursor={}", segment(&cursor)));
        }
        self.status.set_text(if fresh { "Loading…" } else { "" });
        self.more.set_sensitive(false);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let reply = this.app.api.get(path).await;
            if *this.generation.borrow() != generation {
                return;
            }
            this.more.set_sensitive(true);
            match reply {
                Ok(body) => {
                    let items = body["items"].as_array().cloned().unwrap_or_default();
                    this.append(&items);
                    *this.cursor.borrow_mut() = body["next"].as_str().map(String::from);
                    this.more.set_visible(this.cursor.borrow().is_some());
                    this.status.set_text(if this.items.borrow().is_empty() { "Nothing here yet." } else { "" });
                }
                Err(error) => this.status.set_text(&error.message),
            }
        });
    }

    fn search(self: &Rc<Self>, query: String) {
        let generation = self.reset();
        self.status.set_text("Searching…");
        let path = format!("/api/search?q={}&sources={}&limit=30", segment(&query), segment(&self.info.id));
        let this = self.clone();
        glib::spawn_future_local(async move {
            let reply = this.app.api.get(path).await;
            if *this.generation.borrow() != generation {
                return;
            }
            match reply {
                Ok(body) => {
                    let items = body["items"].as_array().cloned().unwrap_or_default();
                    this.append(&items);
                    let failed = body["failed"].as_array().and_then(|failed| failed.first()).and_then(|failure| failure["message"].as_str());
                    this.status.set_text(failed.unwrap_or(if items.is_empty() { "Nothing found." } else { "" }));
                }
                Err(error) => this.status.set_text(&error.message),
            }
        });
    }
}

/// One item, read through `GET /api/sources/:source/items/:item`.
pub struct ReaderPage {
    pub root: gtk::Box,
    app: Rc<App>,
    heading: gtk::Label,
    meta: gtk::Label,
    open: gtk::Button,
    picture: gtk::Picture,
    scroll: gtk::ScrolledWindow,
    text: gtk::TextView,
    path: RefCell<Option<String>>,
    generation: RefCell<u64>,
}

impl ReaderPage {
    pub fn build(app: &Rc<App>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 6);
        root.set_margin_top(14);
        root.set_margin_bottom(14);
        root.set_margin_start(18);
        root.set_margin_end(18);
        let head = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        let heading = gtk::Label::new(None);
        heading.add_css_class("page-title");
        heading.set_xalign(0.0);
        heading.set_hexpand(true);
        heading.set_wrap(true);
        heading.set_selectable(true);
        let open = gtk::Button::with_label("Open");
        open.add_css_class("chip");
        open.set_valign(gtk::Align::Center);
        open.set_tooltip_text(Some("Open the file in its own app"));
        open.set_visible(false);
        head.append(&heading);
        head.append(&open);
        let meta = gtk::Label::new(None);
        meta.add_css_class("meta");
        meta.set_xalign(0.0);
        meta.set_wrap(true);
        meta.set_selectable(true);
        let picture = gtk::Picture::new();
        picture.set_content_fit(gtk::ContentFit::Contain);
        picture.set_can_shrink(true);
        picture.set_halign(gtk::Align::Start);
        picture.set_visible(false);
        let text = gtk::TextView::new();
        text.add_css_class("composer");
        text.set_editable(false);
        text.set_cursor_visible(false);
        text.set_wrap_mode(gtk::WrapMode::WordChar);
        text.set_top_margin(8);
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .vexpand(true)
            .child(&text)
            .build();
        root.append(&head);
        root.append(&meta);
        // The picture takes the room and the item's few lines sit under it.
        picture.set_vexpand(true);
        root.append(&picture);
        root.append(&scroll);

        let page = Rc::new(Self {
            root,
            app: app.clone(),
            heading,
            meta,
            open,
            picture,
            scroll,
            text,
            path: RefCell::new(None),
            generation: RefCell::new(0),
        });
        let this = page.clone();
        page.open.connect_clicked(move |_| {
            if let Some(path) = this.path.borrow().as_ref() {
                let _ = gio::AppInfo::launch_default_for_uri(&gio::File::for_path(path).uri(), gio::AppLaunchContext::NONE);
            }
        });
        page
    }

    pub fn open(self: &Rc<Self>, source: &str, id: &str, title: &str, page: Option<u64>, line: Option<u64>) {
        *self.generation.borrow_mut() += 1;
        let generation = *self.generation.borrow();
        self.heading.set_text(title);
        self.meta.set_text(&self.app.source_label(source));
        self.text.buffer().set_text("Loading…");
        self.open.set_visible(false);
        *self.path.borrow_mut() = None;
        self.picture.set_visible(false);
        self.scroll.set_vexpand(true);
        if self.app.has_pictures(source) {
            let this = self.clone();
            let (source, id) = (source.to_string(), id.to_string());
            glib::spawn_future_local(async move {
                let texture = picture_of(&this.app, &source, &id).await;
                if *this.generation.borrow() == generation
                    && let Some(texture) = texture
                {
                    this.picture.set_paintable(Some(&texture));
                    this.picture.set_visible(true);
                    this.scroll.set_vexpand(false);
                }
            });
        }
        let mut path = format!("/api/sources/{}/items/{}", segment(source), segment(id));
        let query: Vec<String> = [page.map(|page| format!("page={page}")), line.map(|line| format!("line={line}"))].into_iter().flatten().collect();
        if !query.is_empty() {
            path.push_str(&format!("?{}", query.join("&")));
        }
        let label = self.app.source_label(source);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let reply = this.app.api.get(path).await;
            if *this.generation.borrow() != generation {
                return;
            }
            match reply {
                Ok(document) => {
                    if let Some(title) = document["title"].as_str().filter(|title| !title.is_empty()) {
                        this.heading.set_text(title);
                    }
                    let part = document["part"].as_str().unwrap_or_default();
                    let file = document["path"].as_str();
                    let mut meta = vec![label];
                    if !part.is_empty() && part != "whole" {
                        meta.push(part.to_string());
                    }
                    if let Some(file) = file {
                        meta.push(file.to_string());
                    }
                    this.meta.set_text(&meta.join(" · "));
                    this.text.buffer().set_text(document["text"].as_str().unwrap_or_default());
                    *this.path.borrow_mut() = file.map(String::from);
                    this.open.set_visible(file.is_some());
                }
                Err(error) => this.text.buffer().set_text(&error.message),
            }
        });
    }
}
