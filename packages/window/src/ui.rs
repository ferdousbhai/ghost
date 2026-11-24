//! The window shell: omui's header bar and sidebar, with Ask and one row per source that is set up on this
//! computer, and a stack of pages with browser-style history.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

use gtk::{gdk, glib, prelude::*};
use omui::icons::name as icon;
use serde_json::Value;

use crate::{
    api::Api,
    ask::AskPage,
    connect::ConnectPage,
    source::{ReaderPage, SourcePage},
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
        "notes" | "keep" => icon::DOCUMENT,
        "reminders" => icon::CHECKED,
        "whatsapp" => icon::CHAT,
        "mail" => icon::MAIL,
        "contacts" => icon::USER,
        "calendar" => icon::CALENDAR,
        "photos" | "google-photos" => icon::IMAGE,
        "drive" | "google-drive" => icon::CLOUD,
        "lastbook" => icon::BOOK,
        _ => icon::FOLDER,
    }
}

pub struct App {
    pub api: Api,
    pub window: gtk::ApplicationWindow,
    stack: gtk::Stack,
    sidebar: gtk::ListBox,
    /// The sidebar's pane: the list and the footer under it.
    pane: gtk::Box,
    title: omui::Title,
    back: gtk::Button,
    forward: gtk::Button,
    history: RefCell<Vec<Route>>,
    pos: Cell<usize>,
    syncing: Cell<bool>,
    sources: RefCell<Vec<SourceInfo>>,
    pages: RefCell<HashMap<String, Rc<SourcePage>>>,
    reader: RefCell<Option<Rc<ReaderPage>>>,
    ask: RefCell<Option<Rc<AskPage>>>,
    connect: RefCell<Option<Rc<ConnectPage>>>,
}

impl App {
    /// Builds the window and presents it. It lives as long as the application: its handlers hold it.
    pub fn build(app: &gtk::Application, api: Api) {
        let window = gtk::ApplicationWindow::builder().application(app).title("Ghost").default_width(1280).default_height(820).build();

        let toggle = omui::icon_button(icon::SIDEBAR, "Show or hide the sidebar (Ctrl+B)");
        toggle.add_css_class("sidebar-toggle");
        let back = omui::icon_button(icon::BACK, "Back (Alt+Left)");
        let forward = omui::icon_button(icon::FORWARD, "Forward (Alt+Right)");
        let title = omui::Title::new("Ask", "");
        let header = omui::header(Some(title.widget.upcast_ref()));
        header.pack_start(&toggle);
        header.pack_start(&back);
        header.pack_start(&forward);
        window.set_titlebar(Some(&header));

        let sidebar = gtk::ListBox::new();
        sidebar.set_selection_mode(gtk::SelectionMode::Single);
        // The gap between the icon and the text is the stylesheet's, as in any button that holds both.
        let footer_content = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        footer_content.append(&omui::icon(icon::ADD));
        footer_content.append(&gtk::Label::new(Some("Connect your data")));
        let footer = gtk::Button::new();
        footer.set_child(Some(&footer_content));
        footer.add_css_class("sidebar-footer");
        let pane = gtk::Box::new(gtk::Orientation::Vertical, 0);
        pane.add_css_class("sidebar");
        pane.set_size_request(200, -1);
        let scroll = gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&sidebar).build();
        pane.append(&scroll);
        pane.append(&footer);

        let stack = gtk::Stack::new();
        stack.set_hexpand(true);
        stack.set_transition_type(gtk::StackTransitionType::Crossfade);
        stack.set_transition_duration(120);
        stack.set_hhomogeneous(false);
        stack.set_vhomogeneous(false);
        let body = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        body.append(&pane);
        body.append(&stack);
        window.set_child(Some(&body));

        let app = Rc::new(Self {
            api,
            window,
            stack,
            sidebar,
            pane,
            title,
            back,
            forward,
            history: RefCell::new(Vec::new()),
            pos: Cell::new(0),
            syncing: Cell::new(false),
            sources: RefCell::new(Vec::new()),
            pages: RefCell::new(HashMap::new()),
            reader: RefCell::new(None),
            ask: RefCell::new(None),
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
        app.add_row("ask", "Ask", icon::CHAT);
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
        toggle.connect_clicked(move |_| this.pane.set_visible(!this.pane.is_visible()));
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
                gdk::Key::b if ctrl => this.pane.set_visible(!this.pane.is_visible()),
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
    }

    fn add_row(&self, id: &str, label: &str, icon: &str) {
        self.sidebar.append(&omui::sidebar_row(id, Some(icon), label, None));
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

    fn ask(&self) -> Rc<AskPage> {
        self.ask.borrow().clone().expect("the ask page")
    }

    fn connect(&self) -> Rc<ConnectPage> {
        self.connect.borrow().clone().expect("the connect page")
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
        self.title.set_title(&title);
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
        if matches!(route, Route::Ask) {
            self.ask().focus();
        }
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
