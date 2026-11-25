//! Ghost's window: the owner's own data (CONTRACTS.md "Sources") and the ghost that answers from it, in one
//! GTK 4 app. It is a client of ghostd's API, like the `ghost` CLI; it keeps no data of its own.
//! The look, the icons and the shared widgets are omui's; `style.css` holds only what is Ghost's own.

mod api;
mod ask;
mod connect;
mod md;
mod source;
mod ui;

use gtk::{glib, prelude::*};

pub const APP_ID: &str = "io.github.ferdousbhai.Ghost";

fn main() -> glib::ExitCode {
    if std::env::args().any(|arg| arg == "--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return glib::ExitCode::SUCCESS;
    }
    // One window: a second launch activates the first.
    omui::application(APP_ID, APP_ID, "Ghost", include_str!("style.css"), |app| match api::Api::connect() {
        Ok(api) => ui::App::build(app, api),
        Err(message) => {
            let window = gtk::ApplicationWindow::builder().application(app).title("Ghost").default_width(560).default_height(200).build();
            let label = gtk::Label::builder().label(&message).css_classes(["status-line"]).wrap(true).build();
            label.set_margin_top(24);
            label.set_margin_bottom(24);
            label.set_margin_start(24);
            label.set_margin_end(24);
            window.set_child(Some(&label));
            window.present();
        }
    })
    .run()
}
