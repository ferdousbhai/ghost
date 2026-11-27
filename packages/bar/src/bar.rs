//! The bar: a prompt pinned to the bottom of the screen, with what the owner asked and what the ghost says above it
//! as captions, over whatever else is on screen. There is one conversation, the daemon's `default`, and it is shown
//! a caption at a time: Up and Down go back and forth through all of it.
//!
//! It is a layer-shell surface where the compositor has them, and a plain undecorated window where it has not
//! (scripted QA's broadway display). Text is typed into it by whatever types into the focused field, so Omarchy's
//! dictation fills it as it fills any other.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use gtk::{gdk, glib, prelude::*};
use gtk4_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use serde_json::{Value, json};

use crate::api::{Api, Cancel, Frame, segment};

/// The conversation `POST /api/messages` writes to when it names none.
const SESSION: &str = "default";
/// As much as one caption holds: about three lines at the bar's width.
const CAPTION_CHARS: usize = 240;
const WIDTH: i32 = 880;

/// One caption of the conversation: what the owner asked, and a caption's worth of what the ghost said to it.
#[derive(Clone, Debug, PartialEq)]
struct Page {
    asked: String,
    said: String,
}

pub struct Bar {
    api: Api,
    window: gtk::ApplicationWindow,
    captions: gtk::Box,
    asked: gtk::Label,
    said: gtk::Label,
    status: gtk::Label,
    options: gtk::Box,
    entry: gtk::Entry,
    /// The conversation so far, as the log has it.
    pages: RefCell<Vec<Page>>,
    /// The page on screen while the owner is looking back; none at the conversation's end.
    at: Cell<Option<usize>>,
    /// What the ghost is saying: the block of the turn being written.
    text: RefCell<String>,
    live: RefCell<Option<Cancel>>,
}

/// What the ghost said as captions, in order: its Markdown marks dropped, its lines run together with a dot before
/// each list item, cut between words into pages of `CAPTION_CHARS`.
pub fn captions(text: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim().trim_start_matches('#').trim_start();
        let line = match line.strip_prefix("- ").or(line.strip_prefix("* ")) {
            Some(item) => format!("· {item}"),
            None => line.to_string(),
        };
        let plain = line.replace("**", "").replace("__", "").replace('`', "");
        words.extend(plain.split_whitespace().map(String::from));
    }
    let mut pages = Vec::new();
    let mut page = String::new();
    for word in words {
        if !page.is_empty() && page.chars().count() + 1 + word.chars().count() > CAPTION_CHARS {
            pages.push(std::mem::take(&mut page));
        }
        if !page.is_empty() {
            page.push(' ');
        }
        page.push_str(&word);
    }
    if !page.is_empty() {
        pages.push(page);
    }
    pages
}

/// A transcript (`GET /sessions/:id/transcript`) as captions: each thing the ghost said, under what it answered.
/// Its reasoning, its commands and what they printed are `ghost show`'s to list.
fn pages_of(transcript: &Value) -> Vec<Page> {
    let mut pages = Vec::new();
    let mut asked = String::new();
    for message in transcript["messages"].as_array().into_iter().flatten() {
        let parts = message["content"].as_array().into_iter().flatten();
        match message["role"].as_str() {
            Some("user") => asked = parts.filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join(" ").trim().to_string(),
            Some("assistant") => {
                for part in parts.filter(|part| part["type"] == "text") {
                    let said = captions(part["text"].as_str().unwrap_or_default());
                    pages.extend(said.into_iter().map(|said| Page { asked: asked.clone(), said }));
                }
                if let Some(error) = message["errorMessage"].as_str() {
                    pages.push(Page { asked: asked.clone(), said: error.to_string() });
                }
            }
            _ => {}
        }
    }
    pages
}

fn line(class: &str) -> gtk::Label {
    let label = gtk::Label::builder().css_classes([class]).wrap(true).wrap_mode(gtk::pango::WrapMode::WordChar).build();
    label.set_justify(gtk::Justification::Center);
    label.set_visible(false);
    label
}

/// The surface: nothing of a window, at the bottom edge above everything else.
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
        window.set_margin(Edge::Bottom, 56);
        // The keyboard while the owner is in the bar, and back to their work when they click away.
        window.set_keyboard_mode(KeyboardMode::OnDemand);
    }
    window
}

/// The bar when ghostd cannot be reached: why, until Escape.
pub fn unavailable(app: &gtk::Application, message: &str) {
    let window = surface(app);
    let captions = gtk::Box::new(gtk::Orientation::Vertical, 4);
    captions.add_css_class("captions");
    let label = line("caption-status");
    label.add_css_class("error");
    label.set_text(message);
    label.set_visible(true);
    captions.append(&label);
    window.set_child(Some(&captions));
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
        root.set_size_request(WIDTH, -1);
        let captions = gtk::Box::new(gtk::Orientation::Vertical, 4);
        captions.add_css_class("captions");
        captions.set_halign(gtk::Align::Center);
        captions.set_visible(false);
        let (asked, said, status) = (line("caption-asked"), line("caption-said"), line("caption-status"));
        captions.append(&asked);
        captions.append(&said);
        captions.append(&status);
        let options = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        options.set_halign(gtk::Align::Center);
        options.set_visible(false);
        let entry = gtk::Entry::builder().placeholder_text("Ask your ghost").css_classes(["bar-entry"]).build();
        root.append(&captions);
        root.append(&options);
        root.append(&entry);
        window.set_child(Some(&root));

        let bar = Rc::new(Self {
            api,
            window,
            captions,
            asked,
            said,
            status,
            options,
            entry,
            pages: RefCell::new(Vec::new()),
            at: Cell::new(None),
            text: RefCell::new(String::new()),
            live: RefCell::new(None),
        });

        let this = bar.clone();
        bar.entry.connect_activate(move |_| this.ask());
        // Escape stops the turn that is running; with none, it puts the bar away, and summoning it shows it again.
        // Up and Down go through the conversation a caption at a time.
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let this = bar.clone();
        keys.connect_key_pressed(move |_, key, _, _| {
            match key {
                gdk::Key::Escape if this.live.borrow().is_some() => this.stop(),
                gdk::Key::Escape => this.window.set_visible(false),
                gdk::Key::Up | gdk::Key::Page_Up => this.step(-1),
                gdk::Key::Down | gdk::Key::Page_Down => this.step(1),
                _ => return glib::Propagation::Proceed,
            }
            glib::Propagation::Stop
        });
        bar.window.add_controller(keys);
        // Each time it is summoned: the keyboard, and the conversation as it now is (the `ghost` command and the
        // phone's page write to the same one).
        let this = bar.clone();
        bar.window.connect_map(move |_| {
            this.entry.grab_focus();
            let this = this.clone();
            glib::spawn_future_local(async move { this.settle().await });
        });
        bar.window.present();
    }

    fn show(&self, label: &gtk::Label, text: &str) {
        label.set_text(text);
        label.set_visible(!text.is_empty());
        self.captions.set_visible(self.asked.get_visible() || self.said.get_visible() || self.status.get_visible());
    }

    fn note(&self, text: &str, failed: bool) {
        if failed {
            self.status.add_css_class("error");
        } else {
            self.status.remove_css_class("error");
        }
        self.show(&self.status, text);
    }

    /// Back (`-1`) or on (`1`) one caption. Past the last is the conversation's end again.
    fn step(&self, by: isize) {
        if self.live.borrow().is_some() {
            return;
        }
        let count = self.pages.borrow().len();
        // From the conversation's end, back is its last caption: on screen already when a turn has just ended, and
        // now numbered.
        let to = match self.at.get() {
            Some(at) => at.checked_add_signed(by),
            None if by < 0 => count.checked_sub(1),
            None => None,
        };
        match to.filter(|to| *to < count) {
            Some(to) => {
                let page = self.pages.borrow()[to].clone();
                self.at.set(Some(to));
                self.show(&self.asked, &page.asked);
                self.show(&self.said, &page.said);
                self.note(&format!("{} of {count}", to + 1), false);
            }
            None if by > 0 && self.at.get().is_some() => {
                self.at.set(None);
                self.show(&self.asked, "");
                self.show(&self.said, "");
                self.note("", false);
            }
            None => {}
        }
    }

    /// The conversation as the log has it, and the ghost's open question: the last thing it said, with the
    /// answers it offers under it, the one it recommends first and marked. Any other answer is typed.
    async fn settle(self: &Rc<Self>) {
        if self.live.borrow().is_some() {
            return;
        }
        let transcript = self.api.get(format!("/api/sessions/{SESSION}/transcript?limit=2000")).await;
        let sessions = self.api.get("/api/sessions".to_string()).await.unwrap_or(Value::Null);
        if self.live.borrow().is_some() {
            return;
        }
        match transcript {
            Ok(transcript) => *self.pages.borrow_mut() = pages_of(&transcript),
            Err(error) => return self.note(&error.message, true),
        }
        let open = sessions["sessions"].as_array().into_iter().flatten().find(|session| session["id"] == SESSION);
        let offered: Vec<String> = open
            .and_then(|session| session["question"]["options"].as_array())
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
            && let Some(page) = self.pages.borrow().last()
        {
            self.show(&self.asked, &page.asked);
            self.show(&self.said, &page.said);
        }
    }

    fn ask(self: &Rc<Self>) {
        let prompt = self.entry.text().trim().to_string();
        if prompt.is_empty() || self.live.borrow().is_some() {
            return;
        }
        self.entry.set_text("");
        self.text.borrow_mut().clear();
        self.at.set(None);
        self.options.set_visible(false);
        self.show(&self.asked, &prompt);
        self.show(&self.said, "");
        self.note("Thinking…", false);

        let (frames, cancel) = self.api.stream("/api/messages".to_string(), Some(json!({ "prompt": prompt })));
        *self.live.borrow_mut() = Some(cancel);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let mut next = Some(frames);
            while let Some(frames) = next.take() {
                while let Ok(frame) = frames.recv().await {
                    match frame {
                        // A long turn's stream is cut; its last frame says where the rest is.
                        Frame::Event(event) if event["type"] == "resume" => {
                            let path = format!(
                                "/api/sessions/{SESSION}/stream?turn={}&from={}",
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
            if !this.status.has_css_class("error") {
                this.note("", false);
            }
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
            // Each thing the ghost says takes the caption from the one before, and a caption that is full gives
            // way to the next, as a film's lines do.
            "text_start" => self.text.borrow_mut().clear(),
            "text_delta" => {
                self.text.borrow_mut().push_str(event["delta"].as_str().unwrap_or_default());
                self.show(&self.said, captions(&self.text.borrow()).last().map(String::as_str).unwrap_or_default());
                self.note("", false);
            }
            "error" => self.note(event["errorMessage"].as_str().unwrap_or("The turn failed."), true),
            _ => {}
        }
    }

    fn stop(self: &Rc<Self>) {
        let this = self.clone();
        glib::spawn_future_local(async move {
            if let Err(error) = this.api.call("POST", format!("/api/sessions/{SESSION}/stop"), Some(json!({}))).await {
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
    fn what_the_ghost_said_is_captions_without_its_marks() {
        assert_eq!(
            captions("## Ferry\n\nThe **boat** leaves at `nine`.\n\n- Bring tickets.\n* Sara too."),
            ["Ferry The boat leaves at nine. · Bring tickets. · Sara too."]
        );
        let pages = captions(&"word ".repeat(100));
        assert_eq!(pages.len(), 3);
        assert!(pages.iter().all(|page| page.chars().count() <= CAPTION_CHARS && page.starts_with("word") && page.ends_with("word")));
        assert!(captions(" \n").is_empty());
    }

    #[test]
    fn a_transcript_is_each_thing_said_under_what_it_answered() {
        let transcript = json!({ "messages": [
            { "role": "user", "content": [{ "type": "text", "text": "When?" }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "The note says." },
                { "type": "text", "text": "I will look." },
                { "type": "toolCall", "name": "bash", "arguments": { "command": "cat note" }, "output": "nine" },
                { "type": "text", "text": "At nine." },
            ] },
            { "role": "user", "content": [{ "type": "text", "text": "And then?" }] },
            { "role": "assistant", "content": [], "errorMessage": "The model stopped." },
        ] });
        let page = |asked: &str, said: &str| Page { asked: asked.into(), said: said.into() };
        assert_eq!(pages_of(&transcript), [page("When?", "I will look."), page("When?", "At nine."), page("And then?", "The model stopped.")]);
    }
}
