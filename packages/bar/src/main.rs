//! Ghost's bar: the conversation with the ghost as a prompt near the bottom of the screen and the answer above it,
//! with no window. It is a client of ghostd's API, like the `ghost` CLI; it keeps no data of its own.
//! The look and the shared widgets are omui's; `style.css` holds only what is Ghost's own.
//!
//!   ghost-bar            summon the bar: started if it is not running, shown and given the keyboard if it is
//!   ghost-bar --listen   the same, and toggle Omarchy's dictation, so one key opens the bar and listens

mod api;
mod bar;
mod md;

use gtk::{glib, prelude::*};

pub const APP_ID: &str = "io.github.ferdousbhai.Ghost";

fn main() -> glib::ExitCode {
    if std::env::args().any(|arg| arg == "--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return glib::ExitCode::SUCCESS;
    }
    // Dictation types where the keyboard is once it has heard the owner out, and by then the bar has it. Without
    // Omarchy's dictation there is nothing to toggle.
    if std::env::args().any(|arg| arg == "--listen") {
        let _ = std::process::Command::new("omarchy-dictation").arg("toggle").spawn();
    }
    // GApplication would refuse the flag as an option of its own.
    let arguments: Vec<String> = std::env::args().filter(|arg| arg != "--listen").collect();
    // One bar: a second launch shows the first.
    omui::application(APP_ID, APP_ID, "Ghost", include_str!("style.css"), |app| match api::Api::connect() {
        Ok(api) => bar::Bar::build(app, api),
        Err(message) => bar::unavailable(app, &message),
    })
    .run_with_args(&arguments)
}
