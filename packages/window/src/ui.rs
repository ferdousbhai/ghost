//! The window shell, as lastbook-for-omarchy's: a header bar, a sidebar with Ask and one row per source that is
//! set up on this computer, and a stack of pages with browser-style history.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

use gtk::{gdk, glib, prelude::*};
use serde_json::Value;

use crate::{
    api::Api,
    ask::AskPage,
    connect::ConnectPage,
    source::{ReaderPage, SourcePage},
    theme::Theme,
};

/// Where the window can be.
#[derive(Clone, Debug, PartialEq)]
pub enum Route {
    Ask,
    /// What the owner can connect, and how.
    Connect,
    Source(String),
    /// One item of a source, with a search hit's page or line.
    Item {
        source: String,
        id: String,
        title: String,
        page: Option<u64>,
        line: Option<u64>,
    },
}

/// A source as `GET /api/sources` lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceInfo {
    pub id: String,
    pub label: String,
    pub list: bool,
    pub search: bool,
    /// Its items have pictures: shown as a grid.
    pub pictures: bool,
}

fn icon_of(source: &str) -> &'static str {
    match source {
        "notes" => "accessories-text-editor-symbolic",
        "reminders" => "checkbox-checked-symbolic",
        "whatsapp" => "user-available-symbolic",
        "mail" => "mail-unread-symbolic",
        "contacts" => "avatar-default-symbolic",
        "calendar" => "x-office-calendar-symbolic",
        "photos" => "image-x-generic-symbolic",
        "drive" => "folder-remote-symbolic",
        "lastbook" => "accessories-dictionary-symbolic",
        _ => "folder-documents-symbolic",
    }
}

pub fn header_button(icon: &str, tooltip: &str) -> gtk::Button {
    let button = gtk::Button::from_icon_name(icon);
    button.add_css_class("header-action");
    button.set_tooltip_text(Some(tooltip));
    button
}

pub struct App {
    pub api: Api,
    pub window: gtk::ApplicationWindow,
    #[allow(dead_code)]
    theme: Rc<Theme>,
    stack: gtk::Stack,
    sidebar: gtk::ListBox,
    sidebar_shell: gtk::Box,
    title: gtk::Label,
    back: gtk::Button,
    forward: gtk::Button,
    history: RefCell<Vec<Route>>,
    pos: Cell<usize>,
    syncing: Cell<bool>,
    sources: RefCell<Vec<SourceInfo>>,
    pages: RefCell<HashMap<String, Rc<SourcePage>>>,
    ask: RefCell<Option<Rc<AskPage>>>,
    reader: RefCell<Option<Rc<ReaderPage>>>,
    connect: RefCell<Option<Rc<ConnectPage>>>,
}

impl App {
    pub fn build(app: &gtk::Application, api: Api, theme: Rc<Theme>) -> Rc<Self> {
        let window = gtk::ApplicationWindow::builder().application(app).title("Ghost").default_width(1280).default_height(820).build();

        let header = gtk::HeaderBar::new();
        header.set_show_title_buttons(false); // Hyprland tiles the window and Super+W closes it
        let toggle = header_button("sidebar-show-symbolic", "Show or hide the sidebar (Ctrl+B)");
        toggle.add_css_class("sidebar-toggle");
        let back = header_button("go-previous-symbolic", "Back (Alt+Left)");
        let forward = header_button("go-next-symbolic", "Forward (Alt+Right)");
        header.pack_start(&toggle);
        header.pack_start(&back);
        header.pack_start(&forward);
        let title = gtk::Label::new(Some("Ask"));
        title.add_css_class("header-title");
        title.set_ellipsize(gtk::pango::EllipsizeMode::End);
        header.set_title_widget(Some(&title));
        window.set_titlebar(Some(&header));

        let sidebar = gtk::ListBox::new();
        sidebar.add_css_class("sidebar");
        sidebar.set_selection_mode(gtk::SelectionMode::Single);
        let footer_content = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        footer_content.append(&gtk::Image::from_icon_name("list-add-symbolic"));
        footer_content.append(&gtk::Label::new(Some("Connect your data")));
        let footer = gtk::Button::new();
        footer.set_child(Some(&footer_content));
        footer.add_css_class("sidebar-footer");
        let sidebar_shell = gtk::Box::new(gtk::Orientation::Vertical, 0);
        sidebar_shell.add_css_class("sidebar-shell");
        sidebar_shell.set_size_request(200, -1);
        let scroll = gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&sidebar).build();
        sidebar_shell.append(&scroll);
        sidebar_shell.append(&footer);

        let stack = gtk::Stack::new();
        stack.set_hexpand(true);
        stack.set_transition_type(gtk::StackTransitionType::Crossfade);
        stack.set_transition_duration(120);
        stack.set_hhomogeneous(false);
        stack.set_vhomogeneous(false);
        let body = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        body.append(&sidebar_shell);
        body.append(&stack);
        window.set_child(Some(&body));

        let app = Rc::new(Self {
            api,
            window,
            theme,
            stack,
            sidebar,
            sidebar_shell,
            title,
            back,
            forward,
            history: RefCell::new(Vec::new()),
            pos: Cell::new(0),
            syncing: Cell::new(false),
            sources: RefCell::new(Vec::new()),
            pages: RefCell::new(HashMap::new()),
            ask: RefCell::new(None),
            reader: RefCell::new(None),
            connect: RefCell::new(None),
        });

        let ask = AskPage::build(&app);
        app.stack.add_named(&ask.root, Some("ask"));
        *app.ask.borrow_mut() = Some(ask);
        let reader = ReaderPage::build(&app);
        app.stack.add_named(&reader.root, Some("item"));
        *app.reader.borrow_mut() = Some(reader);
        let connect = ConnectPage::build(&app);
        app.stack.add_named(&connect.root, Some("connect"));
        *app.connect.borrow_mut() = Some(connect);
        app.add_row("ask", "Ask", "user-idle-symbolic");
        let this = app.clone();
        footer.connect_clicked(move |_| this.navigate(Route::Connect));
        // Coming back from a product's terminal: what it connected shows without asking.
        let this = app.clone();
        app.window.connect_is_active_notify(move |window| {
            if window.is_active() && this.history.borrow().get(this.pos.get()) == Some(&Route::Connect) {
                this.connect().refresh();
                this.load_sources(None);
            }
        });

        let this = app.clone();
        app.sidebar.connect_row_selected(move |_, row| {
            if this.syncing.get() {
                return;
            }
            if let Some(row) = row {
                let id = row.widget_name().to_string();
                this.navigate(if id == "ask" { Route::Ask } else { Route::Source(id) });
            }
        });
        let this = app.clone();
        toggle.connect_clicked(move |_| this.sidebar_shell.set_visible(!this.sidebar_shell.is_visible()));
        let this = app.clone();
        app.back.connect_clicked(move |_| this.step(-1));
        let this = app.clone();
        app.forward.connect_clicked(move |_| this.step(1));

        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let this = app.clone();
        keys.connect_key_pressed(move |_, key, _, modifiers| {
            let alt = modifiers.contains(gdk::ModifierType::ALT_MASK);
            let ctrl = modifiers.contains(gdk::ModifierType::CONTROL_MASK);
            match key {
                gdk::Key::Left if alt => this.step(-1),
                gdk::Key::Right if alt => this.step(1),
                gdk::Key::b if ctrl => this.sidebar_shell.set_visible(!this.sidebar_shell.is_visible()),
                _ => return glib::Propagation::Proceed,
            }
            glib::Propagation::Stop
        });
        app.window.add_controller(keys);

        app.navigate(Route::Ask);
        app.window.present();

        let open = std::env::var("GHOST_WINDOW_OPEN").ok();
        if open.is_none() {
            // A first run, with nothing connected yet, starts where connecting is.
            let this = app.clone();
            glib::spawn_future_local(async move {
                if let Ok(body) = this.api.get("/api/connections".into()).await
                    && body["connections"].as_array().is_some_and(|rows| rows.iter().all(|row| row["state"] != "connected"))
                    && this.history.borrow().len() == 1
                {
                    this.navigate(Route::Connect);
                }
            });
        }
        app.load_sources(open);
        app
    }

    fn add_row(&self, id: &str, label: &str, icon: &str) {
        let row = gtk::ListBoxRow::new();
        row.add_css_class("sidebar-row");
        row.set_widget_name(id);
        let content = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        content.append(&gtk::Image::from_icon_name(icon));
        content.append(&gtk::Label::new(Some(label)));
        row.set_child(Some(&content));
        self.sidebar.append(&row);
    }

    /// The sources that are set up here become the sidebar's rows, after Ask. `open` is `GHOST_WINDOW_OPEN`, for
    /// scripted checks: `connect`, a source id, or `<source id>/<item id>` (`ask:<prompt>` is the Ask page's).
    fn load_sources(self: &Rc<Self>, open: Option<String>) {
        let this = self.clone();
        glib::spawn_future_local(async move {
            let body = match this.api.get("/api/sources".into()).await {
                Ok(body) => body,
                Err(error) => return this.ask().note(&error.message),
            };
            let sources: Vec<SourceInfo> = body["sources"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| row["available"].as_bool() == Some(true))
                .map(|row| SourceInfo {
                    id: row["id"].as_str().unwrap_or_default().to_string(),
                    label: row["label"].as_str().unwrap_or_default().to_string(),
                    list: row["list"].as_bool().unwrap_or(false),
                    search: row["search"].as_bool().unwrap_or(false),
                    pictures: row["pictures"].as_bool().unwrap_or(false),
                })
                .collect();
            if *this.sources.borrow() != sources {
                this.syncing.set(true);
                while let Some(row) = this.sidebar.row_at_index(1) {
                    this.sidebar.remove(&row);
                }
                this.syncing.set(false);
                for info in &sources {
                    this.add_row(&info.id, &info.label, icon_of(&info.id));
                }
                *this.sources.borrow_mut() = sources;
            }
            let Some(open) = open else { return };
            let (source, item) = open.split_once('/').unwrap_or((&open, ""));
            if open == "connect" {
                this.navigate(Route::Connect);
            } else if this.sources.borrow().iter().any(|info| info.id == source) {
                this.navigate(if item.is_empty() {
                    Route::Source(source.into())
                } else {
                    Route::Item { source: source.into(), id: item.into(), title: item.into(), page: None, line: None }
                });
            }
        });
    }

    fn connect(&self) -> Rc<ConnectPage> {
        self.connect.borrow().clone().expect("the connect page")
    }

    fn ask(&self) -> Rc<AskPage> {
        self.ask.borrow().clone().expect("the ask page")
    }

    pub fn source_label(&self, id: &str) -> String {
        self.sources.borrow().iter().find(|info| info.id == id).map(|info| info.label.clone()).unwrap_or_else(|| id.to_string())
    }

    pub fn has_pictures(&self, id: &str) -> bool {
        self.sources.borrow().iter().any(|info| info.id == id && info.pictures)
    }

    /// Go somewhere new: what lay forward in history is dropped, as in a browser.
    pub fn navigate(self: &Rc<Self>, route: Route) {
        {
            let mut history = self.history.borrow_mut();
            if history.get(self.pos.get()) == Some(&route) {
                return;
            }
            if !history.is_empty() {
                history.truncate(self.pos.get() + 1);
            }
            history.push(route.clone());
            self.pos.set(history.len() - 1);
        }
        self.show(&route);
    }

    fn step(self: &Rc<Self>, by: i64) {
        let target = self.pos.get() as i64 + by;
        let route = {
            let history = self.history.borrow();
            if target < 0 || target as usize >= history.len() {
                return;
            }
            history[target as usize].clone()
        };
        self.pos.set(target as usize);
        self.show(&route);
    }

    fn show(self: &Rc<Self>, route: &Route) {
        let (page, section, title) = match route {
            Route::Ask => ("ask".to_string(), "ask".to_string(), "Ask".to_string()),
            Route::Connect => {
                self.connect().refresh();
                ("connect".to_string(), "connect".to_string(), "Connect".to_string())
            }
            Route::Source(id) => {
                let info = self.sources.borrow().iter().find(|info| &info.id == id).cloned();
                let Some(info) = info else { return };
                let name = format!("source:{id}");
                if !self.pages.borrow().contains_key(id) {
                    let page = SourcePage::build(self, &info);
                    self.stack.add_named(&page.root, Some(&name));
                    self.pages.borrow_mut().insert(id.clone(), page);
                }
                (name, id.clone(), info.label)
            }
            Route::Item { source, id, title, page, line } => {
                if let Some(reader) = self.reader.borrow().as_ref() {
                    reader.open(source, id, title, *page, *line);
                }
                ("item".to_string(), source.clone(), title.clone())
            }
        };
        self.stack.set_visible_child_name(&page);
        self.title.set_text(&title);
        self.window.set_title(Some(&format!("{title} — Ghost")));
        self.back.set_sensitive(self.pos.get() > 0);
        self.forward.set_sensitive(self.pos.get() + 1 < self.history.borrow().len());
        // The sidebar follows the page without that selection navigating again.
        self.syncing.set(true);
        let mut index = 0;
        let mut selected = false;
        while let Some(row) = self.sidebar.row_at_index(index) {
            if row.widget_name() == section.as_str() {
                self.sidebar.select_row(Some(&row));
                selected = true;
            }
            index += 1;
        }
        if !selected {
            self.sidebar.unselect_all();
        }
        self.syncing.set(false);
    }
}

/// A source hit or list row as the API gives it, turned into where clicking it goes.
pub fn route_of(item: &Value) -> Route {
    Route::Item {
        source: item["source"].as_str().unwrap_or("files").to_string(),
        id: item["id"].as_str().unwrap_or_default().to_string(),
        title: item["title"].as_str().unwrap_or_default().to_string(),
        page: item["page"].as_u64(),
        line: item["line"].as_u64(),
    }
}

/// A day and time for a list row, from epoch milliseconds, in local time.
pub fn when(at: &Value) -> String {
    at.as_f64()
        .and_then(|ms| glib::DateTime::from_unix_local((ms / 1000.0) as i64).ok())
        .and_then(|time| time.format("%e %b %Y, %H:%M").ok())
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}
