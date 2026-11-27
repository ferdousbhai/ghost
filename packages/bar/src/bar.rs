//! The bar: a prompt near the bottom of the screen and, above it, what the owner asked with the whole of what the
//! ghost answers, over whatever else is on screen. Nothing of it stays: the prompt goes when a question is sent,
//! the answer when the owner presses Escape or turns to another window, and summoning the bar brings the prompt back.
//!
//! It is a layer-shell surface where the compositor has them, and a plain undecorated window where it has not
//! (scripted QA's broadway display). Text is typed into it by whatever types into the focused field, so Omarchy's
//! dictation fills it as it fills any other.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use gtk::{gdk, glib, prelude::*};
use gtk4_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use serde_json::{Value, json};

use crate::{
    api::{Api, Cancel, Frame, segment},
    md,
};

const WIDTH: i32 = 880;
/// The panel's border and padding on both sides (`.bar-panel` in style.css), which the answer's width is less by.
const PANEL_INSET: i32 = 2 * (1 + 18);
/// Where the prompt's lower edge is, as a share of the screen's height from its bottom. Omarchy's dictation shows
/// what it hears at 85% of the way down, so the prompt sits just above that and neither covers the other.
const RAISED: f64 = 0.16;
/// As much of the screen's height as an answer takes before it scrolls.
const TALLEST: f64 = 0.55;

/// One exchange of the conversation: what the owner asked, and all the ghost said to it.
#[derive(Clone, Debug, PartialEq)]
struct Exchange {
    asked: String,
    said: String,
}

pub struct Bar {
    api: Api,
    window: gtk::ApplicationWindow,
    panel: gtk::Box,
    asked: gtk::Label,
    scroll: gtk::ScrolledWindow,
    said: gtk::Box,
    status: gtk::Label,
    options: gtk::Box,
    entry: gtk::Entry,
    /// The conversation so far, as the log has it.
    exchanges: RefCell<Vec<Exchange>>,
    /// The exchange on screen while the owner is looking back; none at the conversation's end.
    at: Cell<Option<usize>>,
    /// What the ghost has said in the turn on screen, as Markdown.
    text: RefCell<String>,
    /// Said since the answer was last drawn.
    dirty: Cell<bool>,
    live: RefCell<Option<Cancel>>,
    /// The answer on screen ended while the owner could see it: putting the bar away puts it away for good.
    seen: Cell<bool>,
}

/// The transcript (`GET /api/conversation/transcript`) as exchanges: all the ghost said, under what it answered.
/// Its reasoning, its commands and what they printed are `ghost show`'s to list.
fn exchanges_of(transcript: &Value) -> Vec<Exchange> {
    let mut exchanges: Vec<Exchange> = Vec::new();
    for message in transcript["messages"].as_array().into_iter().flatten() {
        let parts = message["content"].as_array().into_iter().flatten();
        match message["role"].as_str() {
            Some("user") => {
                let asked = parts.filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join(" ").trim().to_string();
                exchanges.push(Exchange { asked, said: String::new() });
            }
            // A handoff is the ghost's own housekeeping, said to no one.
            Some("assistant") if message["content"].as_array().is_some_and(|parts| parts.iter().any(|part| part["type"] == "handoff")) => {}
            Some("assistant") => {
                let mut said: Vec<&str> =
                    parts.filter(|part| part["type"] == "text").filter_map(|part| part["text"].as_str()).map(str::trim).collect();
                said.extend(message["errorMessage"].as_str());
                said.retain(|text| !text.is_empty());
                match exchanges.last_mut() {
                    Some(exchange) if exchange.said.is_empty() => exchange.said = said.join("\n\n"),
                    Some(exchange) => exchange.said = format!("{}\n\n{}", exchange.said, said.join("\n\n")),
                    None => exchanges.push(Exchange { asked: String::new(), said: said.join("\n\n") }),
                }
            }
            _ => {}
        }
    }
    exchanges.retain(|exchange| !exchange.said.is_empty());
    exchanges
}

fn line(class: &str) -> gtk::Label {
    let label = gtk::Label::builder().css_classes([class]).wrap(true).wrap_mode(gtk::pango::WrapMode::WordChar).xalign(0.0).build();
    label.set_visible(false);
    label
}

/// The size of the screen the bar is on: its surface's monitor once it has one, and the first monitor before.
fn screen(window: &gtk::ApplicationWindow) -> (i32, i32) {
    let display = gdk::Display::default();
    let own = window.surface().and_then(|surface| display.as_ref().and_then(|display| display.monitor_at_surface(&surface)));
    let monitor = own.or_else(|| display.and_then(|display| display.monitors().item(0)).and_downcast::<gdk::Monitor>());
    monitor.map(|monitor| (monitor.geometry().width(), monitor.geometry().height())).unwrap_or((1920, 1080))
}

/// The bar's width: `WIDTH`, or what a narrower screen has room for.
fn width(window: &gtk::ApplicationWindow) -> i32 {
    WIDTH.min(screen(window).0 - 2 * 16)
}

/// Where the screen puts the bar: raised from its bottom edge by a share of its height. Whether that moved it.
fn place(window: &gtk::ApplicationWindow) -> bool {
    let raised = (f64::from(screen(window).1) * RAISED) as i32;
    let moved = window.is_layer_window() && window.margin(Edge::Bottom) != raised;
    if moved {
        window.set_margin(Edge::Bottom, raised);
    }
    moved
}

/// The surface: nothing of a window, near the bottom edge above everything else.
fn surface(app: &gtk::Application) -> gtk::ApplicationWindow {
    let window = gtk::ApplicationWindow::builder().application(app).title("Ghost").decorated(false).default_width(WIDTH).build();
    window.add_css_class("bar-window");
    // Asked of a Wayland display alone: the library logs a critical on any other.
    let wayland = gdk::Display::default().is_some_and(|display| display.type_().name() == "GdkWaylandDisplay");
    if wayland && gtk4_layer_shell::is_supported() {
        window.init_layer_shell();
        window.set_namespace(Some("ghost"));
        window.set_layer(Layer::Overlay);
        window.set_anchor(Edge::Bottom, true);
        // The keyboard while the bar is on screen, and back to the owner's work when they turn to it.
        window.set_keyboard_mode(KeyboardMode::OnDemand);
    }
    place(&window);
    window
}

/// The bar when ghostd cannot be reached: why, until Escape.
pub fn unavailable(app: &gtk::Application, message: &str) {
    let window = surface(app);
    let panel = gtk::Box::new(gtk::Orientation::Vertical, 4);
    panel.add_css_class("bar-panel");
    let label = line("bar-status");
    label.add_css_class("error");
    label.set_text(message);
    label.set_visible(true);
    panel.append(&label);
    window.set_child(Some(&panel));
    let keys = gtk::EventControllerKey::new();
    let closed = window.clone();
    keys.connect_key_pressed(move |_, key, _, _| {
        if key == gdk::Key::Escape {
            closed.close();
        }
        glib::Propagation::Proceed
    });
    window.add_controller(keys);
    window.present();
}

impl Bar {
    pub fn build(app: &gtk::Application, api: Api) {
        let window = surface(app);
        let root = gtk::Box::new(gtk::Orientation::Vertical, 10);
        // The keyboard's place once the prompt has gone, so Escape and Ctrl+C still reach the bar.
        root.set_focusable(true);
        let panel = gtk::Box::new(gtk::Orientation::Vertical, 8);
        panel.add_css_class("bar-panel");
        panel.set_visible(false);
        let (asked, status) = (line("bar-asked"), line("bar-status"));
        let said = gtk::Box::new(gtk::Orientation::Vertical, 6);
        said.add_css_class("bar-said");
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .child(&said)
            .visible(false)
            .build();
        let options = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        options.set_visible(false);
        panel.append(&asked);
        panel.append(&scroll);
        panel.append(&status);
        panel.append(&options);
        let entry = gtk::Entry::builder().placeholder_text("Ask your ghost").css_classes(["bar-entry"]).build();
        root.append(&panel);
        root.append(&entry);
        window.set_child(Some(&root));

        let bar = Rc::new(Self {
            api,
            window,
            panel,
            asked,
            scroll,
            said,
            status,
            options,
            entry,
            exchanges: RefCell::new(Vec::new()),
            at: Cell::new(None),
            text: RefCell::new(String::new()),
            dirty: Cell::new(false),
            live: RefCell::new(None),
            seen: Cell::new(false),
        });

        let this = bar.clone();
        bar.entry.connect_activate(move |_| this.ask());
        // Escape puts the bar away and stops nothing. Ctrl+C is a terminal's: it stops the turn that is running; with
        // none it empties the prompt; with nothing to empty it puts the bar away. Up and Down go through the
        // conversation an exchange at a time.
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let this = bar.clone();
        keys.connect_key_pressed(move |_, key, _, modifiers| {
            let control = modifiers.contains(gdk::ModifierType::CONTROL_MASK);
            match key {
                gdk::Key::Escape => this.put_away(),
                gdk::Key::c if control && this.live.borrow().is_some() => this.stop(),
                gdk::Key::c if control && !this.entry.text().is_empty() && this.entry.get_visible() => this.entry.set_text(""),
                gdk::Key::c if control => this.put_away(),
                gdk::Key::Up | gdk::Key::Page_Up => this.step(-1),
                gdk::Key::Down | gdk::Key::Page_Down => this.step(1),
                _ => return glib::Propagation::Proceed,
            }
            glib::Propagation::Stop
        });
        bar.window.add_controller(keys);
        // Turning to another window puts the bar away, as Escape does.
        let this = bar.clone();
        let was_active = Cell::new(false);
        bar.window.connect_is_active_notify(move |window| {
            if was_active.replace(window.is_active()) && !window.is_active() {
                this.put_away();
            }
        });
        // Summoned again (a second `ghost-bar`): the prompt, with the keyboard. omui's own handler shows the window.
        let this = bar.clone();
        app.connect_activate(move |_| this.summon());

        // Its screen is known once it is on one.
        let this = bar.clone();
        bar.window.connect_map(move |window| {
            // On another screen than was guessed, it is shown afresh at that screen's sizes: a layer surface resized
            // as it appears is left undrawn.
            if this.fit(window) {
                let window = window.clone();
                glib::idle_add_local_once(move || {
                    window.set_visible(false);
                    window.set_visible(true);
                });
            }
        });
        bar.fit(&bar.window);
        bar.window.present();
        bar.summon();
    }

    /// The bar's width, its distance from the bottom edge and the height an answer scrolls at, for its screen.
    /// Whether any of them changed.
    fn fit(&self, window: &gtk::ApplicationWindow) -> bool {
        let (wide, tall) = (width(window), (f64::from(screen(window).1) * TALLEST) as i32);
        let root = window.child();
        let changed = root.as_ref().is_some_and(|root| root.width_request() != wide) || self.scroll.max_content_height() != tall;
        if let Some(root) = root {
            root.set_size_request(wide, -1);
        }
        self.scroll.set_max_content_height(tall);
        place(window) || changed
    }

    /// The prompt back with the keyboard, and the conversation as it now is (the `ghost` command and the phone's
    /// page write to the same one).
    fn summon(self: &Rc<Self>) {
        self.entry.set_visible(true);
        self.window.set_visible(true);
        self.entry.grab_focus();
        let this = self.clone();
        glib::spawn_future_local(async move { this.settle().await });
    }

    /// Off the screen. A turn that is running runs on, and is on screen again when the bar is summoned; an answer
    /// that had ended is not, though Up brings it back.
    fn put_away(&self) {
        self.window.set_visible(false);
        if self.seen.get() {
            self.clear();
        }
    }

    fn clear(&self) {
        self.at.set(None);
        self.text.borrow_mut().clear();
        self.show(&self.asked, "");
        self.say("");
        self.note("", false);
        self.options.set_visible(false);
        self.shape();
    }

    fn show(&self, label: &gtk::Label, text: &str) {
        label.set_text(text);
        label.set_visible(!text.is_empty());
        self.shape();
    }

    /// The panel is there while anything is in it.
    fn shape(&self) {
        let any = [self.asked.upcast_ref::<gtk::Widget>(), self.scroll.upcast_ref(), self.status.upcast_ref(), self.options.upcast_ref()]
            .iter()
            .any(|widget| widget.get_visible());
        self.panel.set_visible(any);
    }

    /// All the ghost has said, drawn, with its end in view.
    fn say(&self, markdown: &str) {
        md::render(&self.said, markdown);
        // A surface does not grow to what its content would like, only to what it must have: the answer's own
        // height is asked for, up to where it scrolls.
        let (_, natural, _, _) = self.said.measure(gtk::Orientation::Vertical, width(&self.window) - PANEL_INSET);
        self.scroll.set_min_content_height(natural.min(self.scroll.max_content_height()));
        self.scroll.set_visible(!markdown.trim().is_empty());
        self.shape();
        let scroll = self.scroll.clone();
        glib::idle_add_local_once(move || {
            let adjustment = scroll.vadjustment();
            adjustment.set_value(adjustment.upper());
        });
    }

    fn note(&self, text: &str, failed: bool) {
        if failed {
            self.status.add_css_class("error");
        } else {
            self.status.remove_css_class("error");
        }
        self.show(&self.status, text);
    }

    /// Back (`-1`) or on (`1`) one exchange. Past the last is the conversation's end again: nothing but the prompt.
    fn step(&self, by: isize) {
        if self.live.borrow().is_some() {
            return;
        }
        let count = self.exchanges.borrow().len();
        // From the conversation's end, back is its last exchange.
        let to = match self.at.get() {
            Some(at) => at.checked_add_signed(by),
            None if by < 0 => count.checked_sub(1),
            None => None,
        };
        match to.filter(|to| *to < count) {
            Some(to) => {
                let exchange = self.exchanges.borrow()[to].clone();
                self.at.set(Some(to));
                self.seen.set(true);
                self.options.set_visible(false);
                self.show(&self.asked, &exchange.asked);
                self.say(&exchange.said);
                self.note(&format!("{} of {count}", to + 1), false);
            }
            None if by > 0 && self.at.get().is_some() => self.clear(),
            None => {}
        }
    }

    /// The conversation as the log has it, and the ghost's open question: the last thing it said, with the
    /// answers it offers under it, the one it recommends first and marked. Any other answer is typed.
    async fn settle(self: &Rc<Self>) {
        if self.live.borrow().is_some() {
            return;
        }
        let transcript = self.api.get("/api/conversation/transcript?limit=2000".to_string()).await;
        let conversation = self.api.get("/api/conversation".to_string()).await.unwrap_or(Value::Null);
        if self.live.borrow().is_some() {
            return;
        }
        match transcript {
            Ok(transcript) => *self.exchanges.borrow_mut() = exchanges_of(&transcript),
            Err(error) => return self.note(&error.message, true),
        }
        let offered: Vec<String> = conversation["question"]["options"]
            .as_array()
            .map(|options| options.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default();
        omui::clear(&self.options);
        for (index, option) in offered.iter().enumerate() {
            let button = gtk::Button::builder().label(option).css_classes(["chip"]).build();
            if index == 0 {
                button.add_css_class("suggested-action");
            }
            let (this, answer) = (self.clone(), option.clone());
            button.connect_clicked(move |_| {
                this.entry.set_text(&answer);
                this.ask();
            });
            self.options.append(&button);
        }
        self.options.set_visible(!offered.is_empty());
        // A question waits on screen for its answer.
        if !offered.is_empty()
            && self.at.get().is_none()
            && let Some(exchange) = self.exchanges.borrow().last()
        {
            self.show(&self.asked, &exchange.asked);
            self.say(&exchange.said);
        }
        self.shape();
    }

    fn ask(self: &Rc<Self>) {
        let prompt = self.entry.text().trim().to_string();
        if prompt.is_empty() || self.live.borrow().is_some() {
            return;
        }
        self.entry.set_text("");
        self.clear();
        self.seen.set(false);
        self.show(&self.asked, &prompt);
        self.note("Thinking…", false);
        // The prompt has done its work; the answer keeps the keyboard, for Escape and Ctrl+C.
        self.entry.set_visible(false);
        if let Some(root) = self.window.child() {
            root.grab_focus();
        }

        let (frames, cancel) = self.api.stream("/api/messages".to_string(), Some(json!({ "prompt": prompt })));
        *self.live.borrow_mut() = Some(cancel);

        // Tokens arrive faster than a redraw is worth: the answer is drawn at most every 60 ms.
        let this = self.clone();
        glib::timeout_add_local(Duration::from_millis(60), move || {
            if this.dirty.replace(false) {
                this.say(&this.text.borrow());
            }
            if this.live.borrow().is_some() { glib::ControlFlow::Continue } else { glib::ControlFlow::Break }
        });

        let this = self.clone();
        glib::spawn_future_local(async move {
            let mut next = Some(frames);
            while let Some(frames) = next.take() {
                while let Ok(frame) = frames.recv().await {
                    match frame {
                        // A long turn's stream is cut; its last frame says where the rest is.
                        Frame::Event(event) if event["type"] == "resume" => {
                            let path = format!(
                                "/api/conversation/stream?turn={}&from={}",
                                segment(event["turn"].as_str().unwrap_or_default()),
                                event["from"].as_u64().unwrap_or(0)
                            );
                            let (frames, cancel) = this.api.stream(path, None);
                            *this.live.borrow_mut() = Some(cancel);
                            next = Some(frames);
                        }
                        Frame::Event(event) => this.on_event(&event),
                        Frame::Failed(error) => this.note(&error.message, true),
                        Frame::End => break,
                    }
                }
            }
            *this.live.borrow_mut() = None;
            this.dirty.set(false);
            this.say(&this.text.borrow());
            if !this.status.has_css_class("error") {
                this.note("", false);
            }
            // An answer that ended off screen is still to be seen.
            this.seen.set(this.window.is_visible());
            this.settle().await;
        });
    }

    fn on_event(&self, event: &Value) {
        match event["type"].as_str().unwrap_or_default() {
            "pass" => self.note("Thinking…", false),
            // "Loading the local model…" is a notice; the reasoning itself is `ghost show`'s to list.
            "thinking" => {
                if let Some(text) = event["delta"].as_str().filter(|text| text.trim_start().starts_with("Loading the local model")) {
                    self.note(text.trim(), false);
                }
            }
            "tool_execution_start" => {
                let shown = match event["arguments"]["command"].as_str() {
                    Some(command) => format!("$ {}", command.trim().lines().next().unwrap_or_default()),
                    None if event["toolName"] == "ask" => "Asking you".to_string(),
                    None => "Running…".to_string(),
                };
                self.note(&shown, false);
            }
            // Each thing the ghost says is a paragraph of its own under the one before.
            "text_start" => {
                let mut text = self.text.borrow_mut();
                if !text.trim().is_empty() {
                    text.push_str("\n\n");
                }
            }
            "text_delta" => {
                self.text.borrow_mut().push_str(event["delta"].as_str().unwrap_or_default());
                self.dirty.set(true);
                self.note("", false);
            }
            "error" => self.note(event["errorMessage"].as_str().unwrap_or("The turn failed."), true),
            _ => {}
        }
    }

    fn stop(self: &Rc<Self>) {
        let this = self.clone();
        glib::spawn_future_local(async move {
            if let Err(error) = this.api.call("POST", "/api/conversation/stop".to_string(), Some(json!({}))).await {
                // Nothing to stop on the daemon: end the reading instead.
                if let Some(cancel) = this.live.borrow().as_ref() {
                    cancel.stop();
                }
                this.note(&error.message, true);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transcript_is_all_that_was_said_under_what_it_answered() {
        let transcript = json!({ "messages": [
            { "role": "user", "content": [{ "type": "text", "text": "When?" }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "The note says." },
                { "type": "text", "text": "I will look." },
                { "type": "toolCall", "name": "bash", "arguments": { "command": "cat note" }, "output": "nine" },
                { "type": "text", "text": "At **nine**." },
            ] },
            { "role": "assistant", "content": [{ "type": "text", "text": "Writing it down." }, { "type": "handoff", "text": "Note." }] },
            { "role": "user", "content": [{ "type": "text", "text": "And then?" }] },
            { "role": "assistant", "content": [], "errorMessage": "The model stopped." },
            { "role": "user", "content": [{ "type": "text", "text": "Unanswered" }] },
        ] });
        let exchange = |asked: &str, said: &str| Exchange { asked: asked.into(), said: said.into() };
        assert_eq!(exchanges_of(&transcript), [exchange("When?", "I will look.\n\nAt **nine**."), exchange("And then?", "The model stopped.")]);
    }
}
