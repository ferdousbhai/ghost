//! Ghost's window: the owner's own data (CONTRACTS.md "Sources") and the ghost that answers from it, in one
//! GTK 4 app. It is a client of ghostd's API, like the HUD and the `ghost` CLI; it keeps no data of its own.
//! The stack and the look are lastbook-for-omarchy's, which follows Strata (github.com/lgse/strata).

mod api;
mod ask;
mod md;
mod source;
mod theme;
mod ui;

use gtk::{gdk, gio, glib, prelude::*};

pub const APP_ID: &str = "io.github.ferdousbhai.Ghost";

fn main() -> glib::ExitCode {
    if std::env::args().any(|arg| arg == "--version") {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../package.json")).expect("the workspace manifest");
        println!("{}", manifest["version"].as_str().expect("its version"));
        return glib::ExitCode::SUCCESS;
    }
    glib::set_prgname(Some(APP_ID));
    // One window: a second launch activates the first.
    let app = gtk::Application::builder().application_id(APP_ID).flags(gio::ApplicationFlags::empty()).build();
    app.connect_activate(|app| {
        if let Some(window) = app.active_window() {
            window.present();
            return;
        }
        let display = gdk::Display::default().expect("a display");
        let theme = theme::Theme::install(&display);
        match api::Api::connect() {
            Ok(api) => {
                let ui = ui::App::build(app, api, theme);
                // The window and the theme it holds live as long as the application does.
                unsafe { app.set_data("ghost-ui", ui) };
            }
            Err(message) => {
                let window = gtk::ApplicationWindow::builder().application(app).title("Ghost").default_width(560).default_height(200).build();
                let label = gtk::Label::new(Some(&message));
                label.add_css_class("empty-state");
                label.set_wrap(true);
                label.set_margin_top(24);
                label.set_margin_bottom(24);
                label.set_margin_start(24);
                label.set_margin_end(24);
                window.set_child(Some(&label));
                unsafe { app.set_data("ghost-theme", theme) };
                window.present();
            }
        }
    });
    app.run()
}
