//! Connect: what the owner can connect (`GET /api/connections`), each product with its state and its own next
//! step. A step is the product's command, run in a terminal on this desktop, because each asks the owner something.

use std::{cell::RefCell, process::Command, rc::Rc};

use gtk::{glib, prelude::*};
use serde_json::Value;

use crate::ui::App;

/// Run a product's command where the owner can answer it: Omarchy's floating terminal, else the desktop's terminal.
fn run_in_terminal(command: &str) -> std::io::Result<()> {
    let omarchy = "omarchy-launch-floating-terminal-with-presentation";
    let found = std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(omarchy).is_file()));
    let mut launch = if found {
        let mut launch = Command::new(omarchy);
        launch.arg(command);
        launch
    } else {
        let mut launch = Command::new("xdg-terminal-exec");
        launch.args(["-e", "bash", "-c", command]);
        launch
    };
    launch.spawn().map(|_| ())
}

pub struct ConnectPage {
    pub root: gtk::Box,
    app: Rc<App>,
    list: gtk::Box,
    status: gtk::Label,
    generation: RefCell<u64>,
}

impl ConnectPage {
    pub fn build(app: &Rc<App>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 6);
        root.set_margin_top(14);
        root.set_margin_bottom(14);
        root.set_margin_start(18);
        root.set_margin_end(18);
        let heading = omui::label("Connect your data", "page-title");
        let about = omui::label(
            "Ghost answers from what is connected here. Each step opens a terminal, where the app itself asks for what it needs. \
             Notes and Reminders work without any of them.",
            "dim-label",
        );
        let status = gtk::Label::builder().label("Loading…").css_classes(["status-line"]).wrap(true).build();
        let list = gtk::Box::new(gtk::Orientation::Vertical, 8);
        list.set_margin_top(10);
        let column = gtk::Box::new(gtk::Orientation::Vertical, 8);
        column.append(&list);
        column.append(&status);
        let scroll = gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&column).build();
        root.append(&heading);
        root.append(&about);
        root.append(&scroll);
        Rc::new(Self { root, app: app.clone(), list, status, generation: RefCell::new(0) })
    }

    /// Read the connections again; what is shown stays until the answer arrives.
    pub fn refresh(self: &Rc<Self>) {
        *self.generation.borrow_mut() += 1;
        let generation = *self.generation.borrow();
        let this = self.clone();
        glib::spawn_future_local(async move {
            let reply = this.app.api.get("/api/connections".into()).await;
            if *this.generation.borrow() != generation {
                return;
            }
            match reply {
                Ok(body) => {
                    omui::clear(&this.list);
                    for connection in body["connections"].as_array().into_iter().flatten() {
                        this.list.append(&this.card(connection));
                    }
                    this.status.set_text("");
                }
                Err(error) => this.status.set_text(&error.message),
            }
        });
    }

    fn card(self: &Rc<Self>, connection: &Value) -> gtk::Box {
        let state = connection["state"].as_str().unwrap_or_default();
        let card = gtk::Box::new(gtk::Orientation::Vertical, 4);
        card.add_css_class("result");
        let head = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        head.append(&omui::label(connection["label"].as_str().unwrap_or_default(), "section-title"));
        head.append(&match state {
            "connected" => omui::badge("Connected", ""),
            other => {
                let state = omui::label(if other == "disconnected" { "Not connected" } else { "Not installed" }, "meta");
                state.set_valign(gtk::Align::Center);
                state
            }
        });
        card.append(&head);
        for (text, class) in [(connection["brings"].as_str(), "dim-label"), (connection["detail"].as_str(), "snippet")] {
            if let Some(text) = text.filter(|text| !text.is_empty()) {
                let label = omui::label(text, class);
                label.set_selectable(class == "snippet");
                card.append(&label);
            }
        }
        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        actions.set_margin_top(4);
        for (index, action) in connection["actions"].as_array().into_iter().flatten().enumerate() {
            let Some(command) = action["command"].as_str().map(String::from) else { continue };
            let button = gtk::Button::with_label(action["label"].as_str().unwrap_or("Run"));
            // The step that connects something not yet connected stands out.
            button.add_css_class(if index == 0 && state != "connected" { "suggested-action" } else { "chip" });
            button.set_tooltip_text(Some(&format!("Runs in a terminal: {command}")));
            let this = self.clone();
            button.connect_clicked(move |_| {
                if let Err(error) = run_in_terminal(&command) {
                    this.status.set_text(&format!("Could not open a terminal ({error}). Run this yourself: {command}"));
                }
            });
            actions.append(&button);
        }
        if actions.first_child().is_some() {
            card.append(&actions);
        }
        card
    }
}
