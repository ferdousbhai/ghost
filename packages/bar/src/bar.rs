//! The bar: a prompt near the bottom of the screen and, above it, what the owner asked with the whole of what the
//! ghost answers, over whatever else is on screen. Nothing of it stays: the prompt goes when a question is sent,
//! the answer when the owner presses Escape or turns to another window, and summoning the bar brings the prompt back.
//!
//! It is a layer-shell surface where the compositor has them, and a plain undecorated window where it has not
//! (scripted QA's broadway display). Text is typed into it by whatever types into the focused field, so Omarchy's
//! dictation fills it as it fills any other; where the machine has dictation, the prompt shows a microphone and
//! the key that starts it.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::mpsc::TryRecvError,
    time::Duration,
};

use ghostd::abort::Abort;
use gtk::{accessible::Property, gdk, glib, prelude::*};
use gtk4_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use serde_json::{Value, json};

use crate::{api, dictation, md};

const WIDTH: i32 = 880;
/// The panel's border and padding on both sides (`.bar-panel` in style.css), which the answer's width is less by.
const PANEL_INSET: i32 = 2 * (1 + 18);
/// Where the prompt's lower edge is, as a share of the screen's height from its bottom. Omarchy's dictation shows
/// what it hears at 85% of the way down, so the prompt sits just above that and neither covers the other.
const RAISED: f64 = 0.16;
/// As much of the screen's height as an answer takes before it scrolls.
const TALLEST: f64 = 0.55;
/// The most messages the daemon hands over in one page of the transcript.
const PAGE: u64 = 2000;

/// One exchange of the conversation: what the owner asked, and all the ghost said to it.
#[derive(Clone, Debug, PartialEq)]
struct Exchange {
    asked: String,
    said: String,
}

pub struct Bar {
    window: gtk::ApplicationWindow,
    panel: gtk::Box,
    asked: gtk::Label,
    scroll: gtk::ScrolledWindow,
    said: gtk::Box,
    status: gtk::Label,
    options: gtk::Box,
    entry: gtk::Entry,
    /// The caps of the key that starts dictation, beside the prompt's microphone.
    caps: gtk::Box,
    /// The conversation so far, as the log has it.
    exchanges: RefCell<Vec<Exchange>>,
    /// The exchange on screen while the owner is looking back; none at the conversation's end.
    at: Cell<Option<usize>>,
    /// What the ghost has said in the turn on screen, as Markdown.
    text: RefCell<String>,
    /// Said since the answer was last drawn.
    dirty: Cell<bool>,
    /// The turn this bar is reading, and what ends the reading.
    live: RefCell<Option<Abort>>,
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

/// Where the conversation's newest page starts, when `page`, read from its oldest message, is not all of it.
fn newest_from(page: &Value) -> Option<u64> {
    let count = page["messages"].as_array().map_or(0, Vec::len) as u64;
    (page["truncated"] == true).then(|| page["total"].as_u64().unwrap_or(0).saturating_sub(count))
}

/// The newest page of the transcript: the daemon pages from the oldest, as `ghost show` knows too.
async fn newest_page() -> Result<Value, String> {
    let page = |from: u64| api::call("GET", format!("/api/conversation/transcript?limit={PAGE}&offset={from}"), None);
    let first = page(0).await?;
    match newest_from(&first) {
        Some(from) => page(from).await,
        None => Ok(first),
    }
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
        // `Bar::hold` says who has the keyboard: the prompt keeps it, an answer gives it up when turned from.
        window.set_keyboard_mode(KeyboardMode::Exclusive);
    }
    place(&window);
    window
}

impl Bar {
    pub fn build(app: &gtk::Application) {
        let window = surface(app);
        let root = gtk::Box::new(gtk::Orientation::Vertical, 10);
        // The keyboard's place once the prompt has gone, so the bar's keys still reach it.
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
        // The prompt: the field, and where the machine has dictation, a microphone with the key that starts it.
        let entry = gtk::Entry::builder().placeholder_text("Ask your ghost").hexpand(true).build();
        let prompt = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        prompt.add_css_class("bar-entry");
        prompt.append(&entry);
        entry.bind_property("visible", &prompt, "visible").sync_create().build();
        let caps = gtk::Box::new(gtk::Orientation::Horizontal, 3);
        if dictation::installed() {
            let microphone = gtk::Button::from_icon_name(omui::icons::name::MICROPHONE);
            microphone.add_css_class("bar-microphone");
            microphone.set_focus_on_click(false);
            microphone.update_property(&[Property::Label("Dictate")]);
            microphone.connect_clicked(|_| dictation::toggle());
            prompt.append(&microphone);
            prompt.append(&caps);
        }
        root.append(&panel);
        root.append(&prompt);
        window.set_child(Some(&root));

        let bar = Rc::new(Self {
            window,
            panel,
            asked,
            scroll,
            said,
            status,
            options,
            entry,
            caps,
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
        // conversation an exchange at a time. Ctrl+Q ends the bar itself, which the next `ghost-bar` starts anew.
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
                gdk::Key::q if control => this.window.application().iter().for_each(|app| app.quit()),
                gdk::Key::Up | gdk::Key::Page_Up => this.step(-1),
                gdk::Key::Down | gdk::Key::Page_Down => this.step(1),
                _ => return glib::Propagation::Proceed,
            }
            glib::Propagation::Stop
        });
        bar.window.add_controller(keys);
        // Turning to another window puts an answer away, as Escape does. Not the prompt: it holds the keyboard, and
        // what takes the compositor's attention meanwhile (dictation's indicator appearing) is not the owner leaving.
        let this = bar.clone();
        let was_active = Cell::new(false);
        bar.window.connect_is_active_notify(move |window| {
            if was_active.replace(window.is_active()) && !window.is_active() && !this.entry.get_visible() {
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
        self.hold(true);
        self.window.set_visible(true);
        self.entry.grab_focus();
        let this = self.clone();
        glib::spawn_future_local(async move {
            this.hint().await;
            this.settle().await;
        });
    }

    /// The key that starts dictation, as this machine has it bound now, a cap for each key; none where it cannot
    /// be told, and the microphone stands alone.
    async fn hint(&self) {
        if !dictation::installed() {
            return;
        }
        let keys = dictation::keys().await.unwrap_or_default();
        while let Some(cap) = self.caps.first_child() {
            self.caps.remove(&cap);
        }
        for key in keys {
            self.caps.append(&gtk::Label::builder().label(key).css_classes(["keycap"]).build());
        }
    }

    /// Who has the keyboard. The prompt holds it against everything else on screen, so what is typed or dictated
    /// lands in it whatever appears meanwhile; an answer has it only until the owner turns to another window.
    fn hold(&self, prompt: bool) {
        if self.window.is_layer_window() {
            self.window.set_keyboard_mode(if prompt { KeyboardMode::Exclusive } else { KeyboardMode::OnDemand });
        }
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
    /// answers it offers under it, the one it recommends first and marked. Any other answer is typed into the
    /// prompt, once the bar is summoned.
    async fn settle(self: &Rc<Self>) {
        if self.live.borrow().is_some() {
            return;
        }
        let transcript = newest_page().await;
        let conversation = api::call("GET", "/api/conversation".to_string(), None).await.unwrap_or(Value::Null);
        if self.live.borrow().is_some() {
            return;
        }
        match transcript {
            Ok(transcript) => *self.exchanges.borrow_mut() = exchanges_of(&transcript),
            Err(error) => {
                // Why the daemon cannot be asked, until the bar is put away: summoned again, it asks again.
                self.seen.set(true);
                return self.note(&error, true);
            }
        }
        // The answer area's name tells a screen reader, and the scripted QA, that what it shows is all there is.
        self.scroll.update_property(&[Property::Label("Answer")]);
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
        if prompt.is_empty() {
            return;
        }
        if self.live.borrow().is_some() {
            return self.follow_up(prompt);
        }
        self.clear();
        self.seen.set(false);
        self.show(&self.asked, &prompt);
        self.note("Thinking…", false);
        self.sent();
        self.scroll.update_property(&[Property::Label("Answering")]);

        let abort = Abort::new();
        let events = api::stream("/api/messages", json!({ "prompt": prompt }), abort.clone());
        *self.live.borrow_mut() = Some(abort);

        // Tokens arrive faster than a redraw is worth: what has come is read, and the answer drawn, every 60 ms.
        let this = self.clone();
        // Whether the daemon took the turn, and whether it said how the turn ended.
        let (mut taken, mut closed) = (false, false);
        glib::timeout_add_local(Duration::from_millis(60), move || {
            loop {
                match events.try_recv() {
                    Ok(Ok(event)) => {
                        taken = true;
                        closed |= matches!(event["type"].as_str(), Some("done" | "error"));
                        this.on_event(&event);
                    }
                    Ok(Err(error)) => {
                        closed = true;
                        this.note(&error, true);
                        // What was not sent is the owner's to send again: another turn was running, or no daemon.
                        if !taken {
                            this.entry.set_text(&prompt);
                            this.entry.set_position(-1);
                            this.entry.set_visible(true);
                            this.hold(true);
                            this.entry.grab_focus();
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        if !closed && !this.status.has_css_class("error") {
                            this.note("The answer was cut off; ghostd stopped sending it.", true);
                        }
                        this.ended();
                        return glib::ControlFlow::Break;
                    }
                }
            }
            if this.dirty.replace(false) {
                this.say(&this.text.borrow());
            }
            glib::ControlFlow::Continue
        });
    }

    /// The prompt has done its work; the answer keeps the keyboard, for the bar's keys.
    fn sent(&self) {
        self.entry.set_text("");
        self.entry.set_visible(false);
        self.hold(false);
        if let Some(root) = self.window.child() {
            root.grab_focus();
        }
    }

    /// Sent while a turn is running (the bar was summoned during it): the turn's next pass, which `owner_message`
    /// announces. A turn that ended meanwhile leaves the text in the prompt, for Enter to send as a turn of its own.
    fn follow_up(self: &Rc<Self>, text: String) {
        let this = self.clone();
        glib::spawn_future_local(async move {
            match api::call("POST", "/api/conversation/queue".to_string(), Some(json!({ "text": text }))).await {
                Ok(_) => this.sent(),
                Err(error) => this.note(&error, true),
            }
        });
    }

    /// The turn's stream has ended: all it said is drawn, and the conversation read again.
    fn ended(self: &Rc<Self>) {
        *self.live.borrow_mut() = None;
        self.dirty.set(false);
        self.say(&self.text.borrow());
        if !self.status.has_css_class("error") {
            self.note("", false);
        }
        // An answer that ended off screen is still to be seen.
        self.seen.set(self.window.is_visible());
        let this = self.clone();
        glib::spawn_future_local(async move { this.settle().await });
    }

    fn on_event(&self, event: &Value) {
        match event["type"].as_str().unwrap_or_default() {
            "pass" => self.note("Thinking…", false),
            // A follow-up is an exchange of its own, as it is in the transcript.
            "owner_message" => {
                self.show(&self.asked, event["text"].as_str().unwrap_or_default());
                self.text.borrow_mut().clear();
                self.dirty.set(true);
            }
            // "Loading the local model…" is a notice, which the wire tells from reasoning by its words alone; the
            // reasoning itself is `ghost show`'s to list.
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
            if let Err(error) = api::call("POST", "/api/conversation/stop".to_string(), Some(json!({}))).await {
                // The daemon stops nothing: the reading ends instead, and the bar is free again.
                if let Some(reading) = this.live.borrow().as_ref() {
                    reading.abort();
                }
                this.note(&error, true);
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

    #[test]
    fn a_conversation_longer_than_a_page_is_read_from_its_newest_page() {
        let page = |count: usize, total: u64, truncated: bool| json!({ "messages": vec![json!({}); count], "total": total, "truncated": truncated });
        assert_eq!(newest_from(&page(3, 3, false)), None);
        assert_eq!(newest_from(&page(0, 0, false)), None);
        assert_eq!(newest_from(&page(2000, 2001, true)), Some(1));
        assert_eq!(newest_from(&page(2000, 5000, true)), Some(3000));
    }
}
