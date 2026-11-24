//! Ask: a conversation with the ghost, which answers from the owner's own data. The conversations are the
//! ghost's own (`ghost say` shows the same ones).

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use gtk::{gdk, glib, prelude::*};
use serde_json::{Value, json};

use crate::{
    api::{Cancel, Frame, segment},
    md,
    ui::App,
};

/// One answer on the page: its steps, its Markdown, and what failed.
struct Answer {
    step: gtk::Label,
    body: gtk::Box,
    errors: gtk::Box,
    text: RefCell<String>,
    dirty: Cell<bool>,
}

pub struct AskPage {
    pub root: gtk::Box,
    app: Rc<App>,
    chats: gtk::ListBox,
    convo: gtk::Box,
    scroll: gtk::ScrolledWindow,
    composer: gtk::TextView,
    send: gtk::Button,
    status: gtk::Label,
    session: RefCell<String>,
    sessions: RefCell<Vec<Value>>,
    live: RefCell<Option<(Rc<Answer>, Cancel)>>,
    syncing: Cell<bool>,
}

fn api_path(rest: &str) -> String {
    format!("/api{rest}")
}

impl AskPage {
    pub fn build(app: &Rc<App>) -> Rc<Self> {
        let root = gtk::Box::new(gtk::Orientation::Horizontal, 0);

        // A second sidebar: the pane's own padding is around the button and the list.
        let column = gtk::Box::new(gtk::Orientation::Vertical, 6);
        column.add_css_class("sidebar");
        column.set_size_request(200, -1);
        let fresh = gtk::Button::with_label("New chat");
        fresh.add_css_class("chip");
        fresh.set_margin_top(3);
        fresh.set_margin_start(3);
        fresh.set_margin_end(3);
        let chats = gtk::ListBox::new();
        chats.set_selection_mode(gtk::SelectionMode::Single);
        column.append(&fresh);
        column.append(&gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&chats).build());
        root.append(&column);

        let main = gtk::Box::new(gtk::Orientation::Vertical, 0);
        main.set_hexpand(true);
        let convo = gtk::Box::new(gtk::Orientation::Vertical, 14);
        convo.set_margin_top(16);
        convo.set_margin_bottom(16);
        convo.set_margin_start(22);
        convo.set_margin_end(22);
        let scroll = gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&convo).build();
        main.append(&scroll);

        let bar = gtk::Box::new(gtk::Orientation::Vertical, 4);
        bar.add_css_class("composer-bar");
        let frame = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        frame.add_css_class("composer-frame");
        let composer = gtk::TextView::new();
        composer.set_wrap_mode(gtk::WrapMode::WordChar);
        composer.set_hexpand(true);
        composer.set_accepts_tab(false);
        let composer_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .max_content_height(160)
            .hexpand(true)
            .child(&composer)
            .build();
        let send = gtk::Button::with_label("Ask");
        send.add_css_class("suggested-action");
        send.set_valign(gtk::Align::End);
        frame.append(&composer_scroll);
        frame.append(&send);
        let status = gtk::Label::builder().css_classes(["meta"]).xalign(0.0).build();
        bar.append(&frame);
        bar.append(&status);
        main.append(&bar);
        root.append(&main);

        let page = Rc::new(Self {
            root,
            app: app.clone(),
            chats,
            convo,
            scroll,
            composer,
            send,
            status,
            session: RefCell::new(String::new()),
            sessions: RefCell::new(Vec::new()),
            live: RefCell::new(None),
            syncing: Cell::new(false),
        });
        page.new_chat();

        let this = page.clone();
        fresh.connect_clicked(move |_| this.new_chat());
        let this = page.clone();
        page.send.connect_clicked(move |_| if this.live.borrow().is_some() { this.stop() } else { this.ask() });
        let this = page.clone();
        page.chats.connect_row_selected(move |_, row| {
            if this.syncing.get() {
                return;
            }
            let id =
                row.and_then(|row| this.sessions.borrow().get(row.index() as usize).and_then(|session| session["id"].as_str().map(String::from)));
            if let Some(id) = id {
                this.open_chat(id);
            }
        });
        let keys = gtk::EventControllerKey::new();
        let this = page.clone();
        keys.connect_key_pressed(move |_, key, _, modifiers| match key {
            gdk::Key::Return | gdk::Key::KP_Enter if !modifiers.contains(gdk::ModifierType::SHIFT_MASK) => {
                if this.live.borrow().is_none() {
                    this.ask();
                }
                glib::Propagation::Stop
            }
            gdk::Key::Escape if this.live.borrow().is_some() => {
                this.stop();
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
        page.composer.add_controller(keys);

        let this = page.clone();
        glib::spawn_future_local(async move { this.refresh_chats().await });
        page
    }

    /// The keyboard goes to the composer when the page shows.
    pub fn focus(&self) {
        self.composer.grab_focus();
    }

    pub fn note(&self, text: &str) {
        self.status.set_text(text);
    }

    fn new_chat(&self) {
        let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
        *self.session.borrow_mut() = format!("app-{seconds}");
        omui::clear(&self.convo);
        let hello = omui::EmptyState::new(
            Some(omui::icons::name::CHAT),
            "Ask about your notes, mail, chats, files and photos.",
            Some("Answers come from this computer and name where each fact is from."),
        );
        self.convo.append(&hello.widget);
        self.syncing.set(true);
        self.chats.unselect_all();
        self.syncing.set(false);
        self.composer.grab_focus();
    }

    async fn refresh_chats(self: &Rc<Self>) {
        let Ok(body) = self.app.api.get(api_path("/sessions")).await else { return };
        let sessions = body["sessions"].as_array().cloned().unwrap_or_default();
        self.syncing.set(true);
        omui::clear(&self.chats);
        for session in &sessions {
            let title = session["title"].as_str().filter(|title| !title.is_empty()).or(session["preview"].as_str()).unwrap_or("(untitled)");
            let row = omui::sidebar_row(session["id"].as_str().unwrap_or_default(), None, title, None);
            self.chats.append(&row);
            if session["id"].as_str() == Some(self.session.borrow().as_str()) {
                self.chats.select_row(Some(&row));
            }
        }
        *self.sessions.borrow_mut() = sessions;
        self.syncing.set(false);
    }

    fn open_chat(self: &Rc<Self>, id: String) {
        if self.live.borrow().is_some() || *self.session.borrow() == id {
            return;
        }
        *self.session.borrow_mut() = id.clone();
        omui::clear(&self.convo);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let reply = this.app.api.get(api_path(&format!("/sessions/{}/transcript", segment(&id)))).await;
            if *this.session.borrow() != id {
                return;
            }
            match reply {
                Ok(body) => {
                    for message in body["messages"].as_array().into_iter().flatten() {
                        let text: Vec<&str> = message["content"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|part| part["type"] == "text")
                            .filter_map(|part| part["text"].as_str())
                            .collect();
                        let text = text.join("\n\n");
                        if text.trim().is_empty() {
                            continue;
                        }
                        match message["role"].as_str() {
                            Some("user") => this.question(&text),
                            Some("assistant") => {
                                let answer = this.answer();
                                *answer.text.borrow_mut() = text;
                                this.draw(&answer);
                            }
                            _ => {}
                        }
                    }
                    this.to_end();
                }
                Err(error) => this.note(&error.message),
            }
        });
    }

    fn question(&self, text: &str) {
        let label = gtk::Label::new(Some(text));
        label.add_css_class("question");
        label.set_xalign(0.0);
        label.set_wrap(true);
        label.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        label.set_selectable(true);
        label.set_halign(gtk::Align::End);
        self.convo.append(&label);
    }

    fn answer(&self) -> Rc<Answer> {
        let frame = gtk::Box::new(gtk::Orientation::Vertical, 6);
        frame.add_css_class("answer");
        let step = omui::label("", "step");
        step.set_visible(false);
        let body = gtk::Box::new(gtk::Orientation::Vertical, 6);
        let errors = gtk::Box::new(gtk::Orientation::Vertical, 4);
        frame.append(&step);
        frame.append(&body);
        frame.append(&errors);
        self.convo.append(&frame);
        Rc::new(Answer { step, body, errors, text: RefCell::new(String::new()), dirty: Cell::new(false) })
    }

    fn to_end(&self) {
        let scroll = self.scroll.clone();
        glib::idle_add_local_once(move || {
            let adjustment = scroll.vadjustment();
            adjustment.set_value(adjustment.upper());
        });
    }

    fn draw(&self, answer: &Answer) {
        md::render(&answer.body, &answer.text.borrow());
    }

    fn ask(self: &Rc<Self>) {
        let buffer = self.composer.buffer();
        let prompt = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).trim().to_string();
        if prompt.is_empty() {
            return;
        }
        buffer.set_text("");
        if self.convo.first_child().is_some_and(|child| child.has_css_class("empty-state")) {
            omui::clear(&self.convo);
        }
        self.question(&prompt);
        let answer = self.answer();
        answer.step.set_text("Looking through your content…");
        answer.step.set_visible(true);
        self.to_end();
        self.send.set_label("Stop");
        self.note("");

        let session = self.session.borrow().clone();
        let first = self.app.api.stream(api_path("/messages"), Some(json!({ "prompt": prompt, "sessionId": session })));
        *self.live.borrow_mut() = Some((answer.clone(), first.1.clone()));

        // Tokens arrive faster than a redraw is worth: the Markdown is redrawn at most every 60 ms.
        let this = self.clone();
        let drawn = answer.clone();
        glib::timeout_add_local(Duration::from_millis(60), move || {
            if drawn.dirty.replace(false) {
                this.draw(&drawn);
                this.to_end();
            }
            if this.live.borrow().as_ref().is_some_and(|(live, _)| Rc::ptr_eq(live, &drawn)) {
                glib::ControlFlow::Continue
            } else {
                glib::ControlFlow::Break
            }
        });

        let this = self.clone();
        glib::spawn_future_local(async move {
            let mut next = Some(first.0);
            while let Some(frames) = next.take() {
                while let Ok(frame) = frames.recv().await {
                    match frame {
                        Frame::Event(event) => {
                            // A long turn's stream is cut; its last frame says where the rest is.
                            if event["type"] == "resume" {
                                let path = api_path(&format!(
                                    "/sessions/{}/stream?turn={}&from={}",
                                    segment(&session),
                                    segment(event["turn"].as_str().unwrap_or_default()),
                                    event["from"].as_u64().unwrap_or(0)
                                ));
                                let (frames, cancel) = this.app.api.stream(path, None);
                                *this.live.borrow_mut() = Some((answer.clone(), cancel));
                                next = Some(frames);
                            } else {
                                this.on_event(&answer, &event);
                            }
                        }
                        Frame::Failed(error) => this.fail(&answer, &error.message),
                        Frame::End => break,
                    }
                }
            }
            answer.step.set_visible(false);
            *this.live.borrow_mut() = None;
            // The redraw timer must not draw the unfinished form over the finished one.
            answer.dirty.set(false);
            this.draw(&answer);
            this.send.set_label("Ask");
            this.to_end();
            this.refresh_chats().await;
        });
    }

    fn fail(&self, answer: &Rc<Answer>, message: &str) {
        let label = omui::label(message, "error");
        label.set_selectable(true);
        answer.errors.append(&label);
    }

    fn on_event(&self, answer: &Rc<Answer>, event: &Value) {
        let step = |text: String| {
            answer.step.set_text(&text);
            answer.step.set_visible(true);
        };
        match event["type"].as_str().unwrap_or_default() {
            "pass" => step("Thinking…".to_string()),
            "thinking" => {
                if let Some(text) = event["delta"].as_str().filter(|text| text.contains("Loading")) {
                    step(text.trim().to_string());
                }
            }
            "tool_execution_start" => {
                let arguments = &event["arguments"];
                step(match event["toolName"].as_str().unwrap_or_default() {
                    // The local model's one tool: the command itself says what it is doing.
                    "bash" => format!("Running: {}", arguments["command"].as_str().unwrap_or_default().lines().next().unwrap_or_default()),
                    name => format!("Running {name}…"),
                });
            }
            // A running command's latest line: a coding agent's steps as they happen.
            "tool_execution_update" => {
                if let Some(line) = event["summary"].as_str().and_then(|text| text.lines().rev().find(|line| !line.trim().is_empty())) {
                    step(line.trim().to_string());
                }
            }
            "text_start" => {
                if !answer.text.borrow().is_empty() {
                    answer.text.borrow_mut().push_str("\n\n");
                }
            }
            "text_delta" => {
                answer.text.borrow_mut().push_str(event["delta"].as_str().unwrap_or_default());
                answer.dirty.set(true);
                answer.step.set_visible(false);
            }
            "error" => self.fail(answer, event["errorMessage"].as_str().unwrap_or("The turn failed.")),
            _ => {}
        }
    }

    fn stop(self: &Rc<Self>) {
        let path = api_path(&format!("/sessions/{}/stop", segment(&self.session.borrow())));
        let this = self.clone();
        glib::spawn_future_local(async move {
            if let Err(error) = this.app.api.call("POST", path, Some(json!({}))).await {
                // Nothing to stop on the daemon: end the reading instead.
                if let Some((_, cancel)) = this.live.borrow().as_ref() {
                    cancel.stop();
                }
                this.note(&error.message);
            }
        });
    }
}
