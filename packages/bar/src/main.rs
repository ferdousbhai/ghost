//! Ghost's bar: the conversation with the ghost as a prompt near the bottom of the screen and the answer above it,
//! with no window. It is a client of ghostd's API, like the `ghost` CLI; it keeps no data of its own.
//! The look and the shared widgets are omui's; `style.css` holds only what is Ghost's own.
//!
//!   ghost-bar            summon the bar: started if it is not running, shown and given the keyboard if it is
//!   ghost-bar --listen   the same, and toggle Omarchy's dictation, so one key opens the bar and listens

mod api;
mod bar;
mod md;

use gtk::{gio, glib, prelude::*};

const APP_ID: &str = "io.github.ferdousbhai.Ghost";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The version of the bar that is running, when one is: the state of its `version` action, asked over the session
/// bus as GApplication exports it (`org.gtk.Actions`). A launch cannot ask through GApplication itself until it has
/// registered, and by then it can no longer ask to replace.
fn running_version() -> Option<String> {
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).ok()?;
    let path = format!("/{}", APP_ID.replace('.', "/"));
    let name = ("version",).to_variant();
    let flags = gio::DBusCallFlags::NO_AUTO_START;
    let described = bus.call_sync(Some(APP_ID), &path, "org.gtk.Actions", "Describe", Some(&name), None, flags, 1000, gio::Cancellable::NONE).ok()?;
    // `((bgav))`: enabled, its parameter's type, and its state.
    let (_, _, state) = described.child_value(0).get::<(bool, glib::variant::Signature, Vec<glib::Variant>)>()?;
    state.first()?.str().map(str::to_string)
}

fn main() -> glib::ExitCode {
    if std::env::args().any(|arg| arg == "--version") {
        println!("{VERSION}");
        return glib::ExitCode::SUCCESS;
    }
    // Dictation types where the keyboard is once it has heard the owner out, and by then the bar has it. Without
    // Omarchy's dictation there is nothing to toggle.
    if std::env::args().any(|arg| arg == "--listen") {
        let _ = std::process::Command::new("omarchy-dictation").arg("toggle").spawn();
    }
    // GApplication would refuse the flag as an option of its own.
    let arguments: Vec<String> = std::env::args().filter(|arg| arg != "--listen").collect();
    // One bar: a second launch shows the first, unless the first is another version (the package was upgraded under
    // it): that one ends, and this launch is the bar.
    let app = omui::application(APP_ID, APP_ID, "Ghost", include_str!("style.css"), bar::Bar::build);
    let mut flags = gio::ApplicationFlags::ALLOW_REPLACEMENT;
    if running_version().is_some_and(|running| running != VERSION) {
        flags |= gio::ApplicationFlags::REPLACE;
    }
    app.set_flags(flags);
    app.add_action(&gio::SimpleAction::new_stateful("version", None, &VERSION.to_variant()));
    app.run_with_args(&arguments)
}
