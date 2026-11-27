//! The conversation host over a scripted answerer: what a turn hands a pass
//! (persona, cwd, env), what it streams back, what the conversation log keeps,
//! and what the owner's hooks are told.
use super::fake_answerer::{Fake, FakeTurn, Gate, Seen, replies, said, says};
use super::*;
use crate::config::LocalModelConfig;
use crate::hooks::HookCommandResult;
use crate::local_turn::Answerer;
use crate::sidecars::{question_path, read_path};
use std::sync::OnceLock;
use std::thread::JoinHandle;

// ── Helpers ────────────────────────────────────────────────────────────

/// A scratch directory holding the ghost home `casper`, an owner home, and the
/// data directory `gio trash` is pointed at, so nothing reaches the owner's
/// own home or Trash. Removed when dropped.
struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new() -> Self {
        Self::with_character("# Casper\n\nYou are Casper, a letterpress printer.\n")
    }

    fn with_character(character: &str) -> Self {
        let root = std::env::temp_dir().join(format!("ghostd-conversation-host-{}", crate::random::uuid()));
        let home = Self { root };
        std::fs::create_dir_all(home.ghost().dir()).unwrap();
        std::fs::create_dir_all(home.owner_home()).unwrap();
        std::fs::write(home.ghost().character_file(), character).unwrap();
        home
    }

    fn ghost(&self) -> Home {
        Home { dir: self.root.join("casper") }
    }

    fn owner_home(&self) -> PathBuf {
        self.root.join(".owner")
    }

    /// The freedesktop home trash a deleted conversation lands in.
    fn trash_dir(&self) -> PathBuf {
        self.root.join(".data/Trash")
    }

    /// The one conversation's directory: the model's cwd, its log and its sidecars.
    fn conversation_dir(&self) -> PathBuf {
        self.ghost().conversation_dir()
    }

    /// Where the ghost keeps its topic documents.
    fn topics_dir(&self) -> PathBuf {
        self.ghost().topics_dir()
    }

    fn env(&self) -> Env {
        Env::from([
            ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
            ("HOME".to_string(), self.owner_home().display().to_string()),
            ("XDG_DATA_HOME".to_string(), self.root.join(".data").display().to_string()),
        ])
    }

    /// The options of a host over this home: no hooks, no coding agent, and `answerer` in place of the model.
    fn options(&self, answerer: Option<Arc<Fake>>) -> ConversationHostOptions {
        ConversationHostOptions {
            ghost: self.ghost(),
            owner_home: self.owner_home(),
            logger: Logger::silent(),
            hooks: Arc::new(HookRunner::from_config(&self.root.join("hooks.json"), Logger::silent(), self.env()).unwrap()),
            app_url: None,
            local_model: None,
            answerer: answerer.map(|fake| fake as Arc<dyn Answerer>),
            coding_agent: Some(Box::new(|| None)),
            env: self.env(),
            // No device is subscribed, so nothing is ever sent.
            push: crate::push::Push::with_sender(self.root.join("push.json"), Logger::silent(), Box::new(|_, _| crate::push::Sent::Delivered)),
        }
    }

    fn host(&self, fake: &Arc<Fake>) -> ConversationHost {
        ConversationHost::new(self.options(Some(fake.clone())))
    }

    fn host_with_hooks(&self, fake: &Arc<Fake>, hooks: HookRunner) -> ConversationHost {
        ConversationHost::new(ConversationHostOptions { hooks: Arc::new(hooks), ..self.options(Some(fake.clone())) })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn emitter(events: &Arc<Seen<Value>>) -> Emit {
    let events = events.clone();
    Arc::new(move |event| {
        events.push(event);
    })
}

/// Admit a turn and run it on this thread.
fn run(host: &ConversationHost, prompt: &str, emit: Emit) {
    host.admit_turn(prompt).unwrap_or_else(|refusal| panic!("the turn is admitted, not refused: {}", refusal.message)).run(emit);
}

/// Run a turn to its end and return what it streamed.
fn turn(host: &ConversationHost, prompt: &str) -> Vec<Value> {
    let events = Seen::new();
    run(host, prompt, emitter(&events));
    events.all()
}

/// Start a turn on its own thread: its stream so far, and the thread to join for its end.
fn start(host: &ConversationHost, prompt: &str) -> (Arc<Seen<Value>>, JoinHandle<()>) {
    let events = Seen::new();
    let (host, prompt, emit) = (host.clone(), prompt.to_string(), emitter(&events));
    (events, std::thread::spawn(move || run(&host, &prompt, emit)))
}

fn wait_for_event(events: &Seen<Value>, kind: &str) {
    events.wait(&format!("a {kind} event"), |events| events.iter().any(|event| event["type"] == kind));
}

fn of_type(events: &[Value], kinds: &[&str]) -> Vec<Value> {
    events.iter().filter(|event| kinds.iter().any(|kind| event["type"] == *kind)).cloned().collect()
}

/// Every text delta of a stream, joined.
fn text(events: &[Value]) -> String {
    events.iter().filter(|event| event["type"] == "text_delta").filter_map(|event| event["delta"].as_str()).collect()
}

/// `actual` is an object carrying every field of `expected` with the same value.
fn carries(actual: &Value, expected: &Value) -> bool {
    expected.as_object().expect("an object").iter().all(|(key, value)| actual.get(key) == Some(value))
}

#[track_caller]
fn assert_carries(actual: &Value, expected: Value) {
    assert!(carries(actual, &expected), "{actual} does not carry {expected}");
}

#[track_caller]
fn assert_has(events: &[Value], expected: Value) {
    assert!(events.iter().any(|event| carries(event, &expected)), "no event carries {expected} in {events:?}");
}

/// What a handoff asks while the ghost has no topic documents yet.
fn handoff_prompt(home: &Scratch) -> String {
    crate::local_turn::handoff_prompt(&home.topics_dir(), None)
}

fn messages(host: &ConversationHost) -> Vec<Value> {
    host.read_transcript(None, None).unwrap()["messages"].as_array().unwrap().clone()
}

fn roles(host: &ConversationHost) -> Vec<String> {
    messages(host).iter().map(|message| message["role"].as_str().unwrap().to_string()).collect()
}

/// The conversation as `GET /api/conversation` gives it.
fn conversation(host: &ConversationHost) -> Value {
    host.conversation().unwrap()
}

/// The conversation before anything is said.
fn nothing_said() -> Value {
    json!({ "preview": null, "updatedAt": null, "messageCount": 0, "unread": false, "running": false, "question": null })
}

/// A sidecar as it is on disk, or None when there is no such file.
fn stored(path: &std::path::Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().map(|text| serde_json::from_str(&text).unwrap())
}

fn code<T>(result: Result<T>) -> String {
    result.err().map(|error| error.code).unwrap_or_else(|| "no error".to_string())
}

/// A hook runner whose handlers "run" through `run`, for the events `document` names.
fn hooks_run_by(document: Value, run: impl Fn(&HookEvent) -> HookCommandResult + Send + Sync + 'static) -> HookRunner {
    HookRunner::with_runner(document, Logger::silent(), Box::new(move |_hook, event| run(event)))
}

fn succeeded(stdout: &str) -> HookCommandResult {
    HookCommandResult { exit_code: Some(0), stdout: stdout.to_string(), ..Default::default() }
}

/// A real `session_stop` command hook, run by bash, which keeps each event it
/// is handed. It asks for one more pass ("verify it"): ungated, whenever the
/// event is not itself a continuation; gated, the first time it runs, and
/// only once `go` exists.
struct StopHook {
    dir: PathBuf,
}

impl StopHook {
    fn new(home: &Scratch, gated: bool) -> (Self, HookRunner) {
        let dir = home.root.join(".stop-hook");
        std::fs::create_dir_all(&dir).unwrap();
        let at = |name: &str| format!("'{}'", dir.join(name).display());
        let wait = if gated { format!("while [ ! -e {} ]; do sleep 0.02; done", at("go")) } else { String::new() };
        let block =
            if gated { format!("[ ! -e {} ]", at("seen")) } else { "case \"$input\" in *'\"stop_hook_active\":true'*) false ;; esac".to_string() };
        let command = format!(
            "input=$(cat)\nprintf '%s\\n' \"$input\" >> {inputs}\n{wait}\nif {block}; then answer='{{\"decision\":\"block\",\"reason\":\"verify it\"}}'; else answer='{{}}'; fi\n: > {seen}\nprintf '%s' \"$answer\"\n",
            inputs = at("inputs.jsonl"),
            seen = at("seen"),
        );
        let document = json!({ "hooks": { "session_stop": [{ "hooks": [{ "type": "command", "command": command, "name": "Review" }] }] } });
        let file = dir.join("hooks.json");
        std::fs::write(&file, document.to_string()).unwrap();
        (Self { dir }, HookRunner::from_config(&file, Logger::silent(), home.env()).unwrap())
    }

    /// Let a gated hook answer.
    fn go(&self) {
        std::fs::write(self.dir.join("go"), "").unwrap();
    }

    /// The events the hook was handed, in order.
    fn inputs(&self) -> Vec<Value> {
        let text = std::fs::read_to_string(self.dir.join("inputs.jsonl")).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }
}

// ── A turn ─────────────────────────────────────────────────────────────

#[test]
fn a_turn_runs_in_the_conversation_directory_with_the_ghosts_persona() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&["I set type."]));
    let host = home.host(&fake);
    let events = turn(&host, "What do you do?");

    assert_eq!(events[0], json!({ "type": "start" }));
    assert_eq!(text(&events), "I set type.");
    assert_eq!(events.last().unwrap(), &json!({ "type": "done" }));
    let call = &fake.calls()[0];
    assert_eq!(call.prompt, "What do you do?");
    assert_eq!(call.cwd, home.conversation_dir());
    assert_eq!(call.env, home.env());
    assert!(call.persona.contains("You are Casper, a letterpress printer."));
    assert!(call.persona.contains("## Character file"));
}

#[test]
fn a_turn_streams_its_text_as_one_block_between_a_start_and_an_end() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["I set type."])));
    assert_eq!(
        turn(&host, "What do you do?"),
        vec![
            json!({ "type": "start" }),
            json!({ "type": "pass" }),
            json!({ "type": "text_start", "contentIndex": 0 }),
            json!({ "type": "text_delta", "contentIndex": 0, "delta": "I set type." }),
            json!({ "type": "text_end", "contentIndex": 0, "content": "I set type." }),
            json!({ "type": "done" }),
        ]
    );
}

#[test]
fn the_persona_is_rendered_again_every_turn_so_a_rewritten_character_is_who_the_ghost_is_next() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&["one", "two"]));
    let host = home.host(&fake);
    turn(&host, "first");
    std::fs::write(home.ghost().character_file(), "# Casper\n\nYou are Casper, now a bookbinder.\n").unwrap();
    turn(&host, "second");
    assert!(fake.calls()[1].persona.contains("now a bookbinder"));
}

#[test]
fn a_later_turn_is_handed_the_conversation_so_far_and_both_are_in_the_log() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&["pong", "pong again"]));
    let host = home.host(&fake);
    turn(&host, "ping");
    turn(&host, "again");

    // The second turn answers "again", handed the first as the messages it was.
    assert_eq!(fake.prompts(), ["ping", "again"]);
    assert_eq!(fake.calls()[0].history, Vec::<Value>::new());
    assert_eq!(fake.calls()[1].history, vec![json!({ "role": "user", "content": "ping" }), json!({ "role": "assistant", "content": "pong" })]);
    let transcript: Vec<Value> = messages(&host).iter().map(|message| json!([message["role"], message["content"]])).collect();
    assert_eq!(
        transcript,
        vec![
            json!(["user", [{ "type": "text", "text": "ping" }]]),
            json!(["assistant", [{ "type": "text", "text": "pong" }]]),
            json!(["user", [{ "type": "text", "text": "again" }]]),
            json!(["assistant", [{ "type": "text", "text": "pong again" }]]),
        ]
    );
}

#[test]
fn tool_calls_stream_as_cards_and_a_failed_one_stays_marked_in_the_log() {
    let home = Scratch::new();
    let fake = Fake::new(vec![FakeTurn {
        events: vec![
            PassEvent::ToolStart { id: "t1".to_string(), name: "Bash".to_string(), args: json!({ "command": "false" }) },
            PassEvent::ToolEnd { id: "t1".to_string(), is_error: true, output: "exit 1".to_string() },
            said("a", "It failed."),
        ],
        ..Default::default()
    }]);
    let host = home.host(&fake);
    let events = turn(&host, "run false");

    let cwd = home.conversation_dir();
    let cards = of_type(&events, &["tool_execution_start", "tool_execution_end"]);
    assert_eq!(
        cards,
        vec![
            json!({ "type": "tool_execution_start", "id": "t1", "toolName": "Bash", "arguments": { "command": "false" }, "cwd": cwd.to_string_lossy() }),
            json!({ "type": "tool_execution_end", "id": "t1", "toolName": "Bash", "isError": true, "summary": "exit 1", "output": "exit 1" }),
        ]
    );
    let logged = messages(&host);
    let assistant = logged.iter().find(|message| message["role"] == "assistant").unwrap();
    assert_eq!(
        assistant["content"],
        json!([
            { "type": "toolCall", "id": "t1", "name": "Bash", "arguments": { "command": "false" }, "failed": true, "output": "exit 1" },
            { "type": "text", "text": "It failed." },
        ])
    );
}

#[test]
fn reasoning_streams_and_is_logged_and_a_running_tool_shows_the_tail_of_its_output() {
    let home = Scratch::new();
    let thought = |block: &str, delta: &str| PassEvent::Thinking { block: block.to_string(), delta: delta.to_string() };
    let started = || PassEvent::ToolStart { id: "t1".to_string(), name: "bash".to_string(), args: json!({ "command": "make" }) };
    let fake = Fake::new(vec![FakeTurn {
        events: vec![
            thought("r1", "Let me "),
            thought("r1", ""),
            thought("r1", "see."),
            thought("r2", "Next."),
            started(),
            // A tool is one card however often it is announced, and only a known one is updated or ended.
            started(),
            PassEvent::ToolUpdate { id: "t1".to_string(), output: format!("{}\n", "x".repeat(900)) },
            PassEvent::ToolUpdate { id: "t1".to_string(), output: "  \n".to_string() },
            PassEvent::ToolUpdate { id: "t9".to_string(), output: "stray".to_string() },
            PassEvent::ToolEnd { id: "t9".to_string(), is_error: true, output: "stray".to_string() },
            PassEvent::ToolEnd { id: "t1".to_string(), is_error: false, output: "made\n".to_string() },
            said("a", ""),
            said("a", "Built."),
        ],
        ..Default::default()
    }]);
    let host = home.host(&fake);
    let events = turn(&host, "build it");
    assert_eq!(
        events[2..events.len() - 1],
        [
            json!({ "type": "thinking", "delta": "Let me " }),
            json!({ "type": "thinking", "delta": "see." }),
            json!({ "type": "thinking", "delta": "\nNext." }),
            json!({ "type": "tool_execution_start", "id": "t1", "toolName": "bash", "arguments": { "command": "make" }, "cwd": home.conversation_dir().to_string_lossy() }),
            json!({ "type": "tool_execution_update", "id": "t1", "summary": format!("…{}", "x".repeat(800)) }),
            json!({ "type": "tool_execution_end", "id": "t1", "toolName": "bash", "isError": false, "summary": "made", "output": "made\n" }),
            json!({ "type": "text_start", "contentIndex": 0 }),
            json!({ "type": "text_delta", "contentIndex": 0, "delta": "Built." }),
            json!({ "type": "text_end", "contentIndex": 0, "content": "Built." }),
        ]
    );
    assert_eq!(
        messages(&host).last().unwrap()["content"],
        json!([
            { "type": "thinking", "text": "Let me see.\nNext." },
            { "type": "toolCall", "id": "t1", "name": "bash", "arguments": { "command": "make" }, "output": "made\n" },
            { "type": "text", "text": "Built." }
        ])
    );
}

#[test]
fn a_transcript_is_read_a_page_at_a_time() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["one", "two"])));
    // Before anything is said it reads as empty.
    assert_eq!(host.read_transcript(None, None).unwrap(), json!({ "messages": [], "total": 0, "truncated": false }));
    turn(&host, "first");
    turn(&host, "second");
    let page = |limit: Option<usize>, offset: Option<usize>| {
        let read = host.read_transcript(limit, offset).unwrap();
        (read["messages"].as_array().unwrap().len(), read["total"].clone(), read["truncated"].clone())
    };
    assert_eq!(page(None, None), (4, json!(4), json!(false)));
    assert_eq!(page(Some(usize::MAX), Some(0)), (4, json!(4), json!(false)));
    assert_eq!(page(Some(3), None), (3, json!(4), json!(true)));
    // A page holds at least one message, and one past the end holds none.
    assert_eq!(page(Some(0), None), (1, json!(4), json!(true)));
    assert_eq!(page(None, Some(1)), (3, json!(4), json!(true)));
    assert_eq!(page(None, Some(9)), (0, json!(4), json!(true)));
    assert_eq!(page(Some(usize::MAX), Some(usize::MAX)), (0, json!(4), json!(true)));
}

#[test]
fn a_turn_ends_in_an_error_that_keeps_what_was_said_before_it() {
    let home = Scratch::new();
    let fake = Fake::new(vec![FakeTurn { fail: Some("connection reset".to_string()), ..says("partial") }]);
    let host = home.host(&fake);
    let events = turn(&host, "hello");

    assert_eq!(events.last().unwrap(), &json!({ "type": "error", "reason": "error", "errorMessage": "connection reset" }));
    let logged = messages(&host);
    let assistant = logged.iter().find(|message| message["role"] == "assistant").unwrap();
    assert_carries(assistant, json!({ "errorMessage": "connection reset", "content": [{ "type": "text", "text": "partial" }] }));
}

#[test]
fn the_system_prompt_names_the_coding_agent_the_owner_chose() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&["ok"]));
    let host = ConversationHost::new(ConversationHostOptions {
        coding_agent: Some(Box::new(|| Some("codex".to_string()))),
        ..home.options(Some(fake.clone()))
    });
    turn(&host, "hi");
    // In the Ghost section, by its one-shot command; the sections keep their order after it.
    let persona = &fake.calls()[0].persona;
    let at = |text: &str| persona.find(text).unwrap_or_else(|| panic!("{text} is not in the prompt"));
    assert!(at("\n\n## Character file\n") < at("\n\n## Ghost\n"));
    assert!(at("\n\n## Ghost\n") < at("read its answer: `codex exec \"<task>\"`.\n\n## Owner context\n"));

    // Without one, the prompt names none.
    let other = Scratch::new();
    let fake = Fake::new(replies(&["ok"]));
    turn(&other.host(&fake), "hi");
    assert!(!fake.calls()[0].persona.contains("coding agent"));
}

#[test]
fn a_turn_fails_plainly_when_no_local_model_is_configured() {
    let home = Scratch::new();
    let host = ConversationHost::new(home.options(None));
    let events = turn(&host, "hi");
    let last = events.last().unwrap();
    assert_eq!(last["type"], "error");
    assert!(last["errorMessage"].as_str().unwrap().contains("local.model"), "{last}");
    let refusal = host.complete("Review this.", &Abort::new()).unwrap_err();
    assert_eq!((refusal.code.as_str(), refusal.status), ("no_local_model", 409));
}

// ── Queued follow-ups and aborts ───────────────────────────────────────

#[test]
fn a_follow_up_queued_during_a_pass_runs_right_after_it_in_the_same_stream() {
    let home = Scratch::new();
    let gate = Gate::default();
    let fake = Fake::new([vec![FakeTurn { gate: Some(gate.clone()), ..says("first") }], replies(&["second"])].concat());
    let host = home.host(&fake);
    let (events, running) = start(&host, "one");
    fake.wait_for_calls(1);
    assert_eq!(host.queued_messages(), json!({ "streaming": true, "followUp": [] }));
    assert_eq!(host.queue_message("two").unwrap(), json!({ "streaming": true, "followUp": ["two"] }));
    gate.release();
    running.join().unwrap();
    let events = events.all();

    // The stream announces the queue as it grows and as it drains, then the message.
    assert_eq!(
        of_type(&events, &["queue", "owner_message"]),
        vec![
            json!({ "type": "queue", "followUp": ["two"] }),
            json!({ "type": "queue", "followUp": [] }),
            json!({ "type": "owner_message", "text": "two" })
        ]
    );
    assert_eq!(text(&events), "firstsecond");
    // The second pass's text is a new block of the same stream.
    assert_eq!(
        of_type(&events, &["text_start"]),
        vec![json!({ "type": "text_start", "contentIndex": 0 }), json!({ "type": "text_start", "contentIndex": 1 })]
    );
    let last_lines: Vec<String> = fake.prompts().iter().map(|prompt| prompt.rsplit('\n').next().unwrap().to_string()).collect();
    assert_eq!(last_lines, ["one", "two"]);
    assert_eq!(of_type(&events, &["done", "error"]).len(), 1);
    assert_eq!(host.queued_messages(), json!({ "streaming": false, "followUp": [] }));
}

#[test]
fn a_turns_start_is_announced_with_its_prompt_already_in_the_transcript() {
    let home = Scratch::new();
    let gate = Gate::default();
    let fake = Fake::new(vec![FakeTurn { gate: Some(gate.clone()), ..says("ok") }]);
    let host = home.host(&fake);
    // What the owner had said, as a client that reads on each announcement sees it.
    let seen: Arc<Seen<Vec<String>>> = Seen::new();
    let (reader, kept) = (host.clone(), seen.clone());
    let subscription = host.subscribe(
        move |_event| {
            let said = messages(&reader);
            let owner = said
                .iter()
                .filter(|message| message["role"] == "user")
                .map(|message| message["content"].as_array().unwrap().iter().map(|part| part["text"].as_str().unwrap_or("")).collect::<String>());
            kept.push(owner.collect());
        },
        || {},
    );
    let (_events, running) = start(&host, "check the issues");
    fake.wait_for_calls(1);
    assert_eq!(seen.all()[0], ["check the issues"]);
    gate.release();
    running.join().unwrap();
    host.unsubscribe(subscription);
}

#[test]
fn text_after_a_tool_call_is_logged_as_its_own_part_when_the_block_key_is_reused() {
    let home = Scratch::new();
    let fake = Fake::new(vec![FakeTurn {
        events: vec![
            said("run", "Let me check."),
            PassEvent::ToolStart { id: "t1".to_string(), name: "bash".to_string(), args: json!({ "command": "ls" }) },
            PassEvent::ToolEnd { id: "t1".to_string(), is_error: false, output: "ok".to_string() },
            said("run", "Done: X"),
        ],
        ..Default::default()
    }]);
    let host = home.host(&fake);
    let events = turn(&host, "check it");
    let logged = messages(&host);
    let parts: Vec<&str> =
        logged.last().unwrap()["content"].as_array().unwrap().iter().map(|part| part["text"].as_str().unwrap_or("toolCall")).collect();
    assert_eq!(parts, ["Let me check.", "toolCall", "Done: X"]);
    // As the stream showed it: the block closes before the card and a new one opens after.
    let kinds: Vec<&str> = events.iter().map(|event| event["type"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        [
            "start",
            "pass",
            "text_start",
            "text_delta",
            "text_end",
            "tool_execution_start",
            "tool_execution_end",
            "text_start",
            "text_delta",
            "text_end",
            "done"
        ]
    );
    assert_has(&events, json!({ "type": "text_end", "contentIndex": 1, "content": "Done: X" }));
    assert_has(&events, json!({ "type": "tool_execution_end", "id": "t1", "toolName": "bash", "isError": false, "summary": "ok" }));
}

#[test]
fn a_follow_up_queued_behind_a_pass_that_failed_still_runs() {
    let home = Scratch::new();
    let gate = Gate::default();
    let failing = FakeTurn { fail: Some("crashed".to_string()), gate: Some(gate.clone()), ..says("half") };
    let fake = Fake::new([vec![failing], replies(&["second"])].concat());
    let host = home.host(&fake);
    let (events, running) = start(&host, "one");
    fake.wait_for_calls(1);
    host.queue_message("two").unwrap();
    gate.release();
    running.join().unwrap();

    assert_eq!(fake.prompts(), ["one", "two"]);
    assert_eq!(events.all().last().unwrap(), &json!({ "type": "done" }));
    let logged: Vec<Value> = messages(&host).iter().map(|message| json!([message["role"], message["errorMessage"]])).collect();
    assert_eq!(logged, vec![json!(["user", null]), json!(["assistant", "crashed"]), json!(["user", null]), json!(["assistant", null])]);
}

#[test]
fn a_stop_is_refused_when_nothing_is_running() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["x"])));
    let refusal = host.stop_turn().unwrap_err();
    assert_eq!((refusal.code.as_str(), refusal.status), ("conversation_not_streaming", 409));
}

#[test]
fn a_queued_message_is_refused_when_nothing_is_streaming() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["x"])));
    let refusal = host.queue_message("late").unwrap_err();
    assert_eq!((refusal.code.as_str(), refusal.status), ("conversation_not_streaming", 409));
}

#[test]
fn a_stop_stops_the_pass_and_ends_the_turn_aborted() {
    let home = Scratch::new();
    let fake = Fake::new(vec![FakeTurn { gate: Some(Gate::default()), ..Default::default() }]);
    let host = home.host(&fake);
    let (events, running) = start(&host, "wait");
    fake.wait_for_calls(1);
    assert_eq!(conversation(&host)["running"], true);
    // The conversation is held: a second turn is refused, and so is starting over.
    let refusal = host.admit_turn("again").err().expect("a second turn is refused");
    assert_eq!((refusal.code.as_str(), refusal.status), ("conversation_busy", 409));
    let refusal = host.delete_conversation().unwrap_err();
    assert_eq!((refusal.code.as_str(), refusal.status), ("conversation_busy", 409));
    assert!(log_path(&home.conversation_dir()).exists());
    host.stop_turn().unwrap();
    running.join().unwrap();
    assert_eq!(events.all().last().unwrap(), &json!({ "type": "error", "reason": "aborted", "errorMessage": "Turn aborted." }));
    assert_eq!(conversation(&host)["running"], false);
    // What the stopped pass leaves in the log says so.
    assert_eq!(messages(&host).last().unwrap()["errorMessage"], "Turn aborted.");
}

// ── Owner commands ─────────────────────────────────────────────────────

#[test]
fn an_owner_command_runs_in_the_owner_home_and_its_output_is_handed_to_the_next_turn() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&["seen"]));
    let host = home.host(&fake);
    let events = turn(&host, "!echo printed");
    assert_has(
        &events,
        json!({ "type": "tool_execution_start", "toolName": "bash", "arguments": { "command": "echo printed" }, "cwd": home.owner_home().to_string_lossy() }),
    );
    assert_has(&events, json!({ "type": "tool_execution_end", "toolName": "bash", "isError": false, "summary": "printed" }));
    assert_eq!(events.last().unwrap(), &json!({ "type": "done" }));
    assert!(fake.calls().is_empty());
    // Read back as the live turn showed it: the owner's `!command`, then its output.
    let logged = messages(&host);
    let read: Vec<Value> = logged.iter().map(|message| json!([message["role"], message["entryId"]])).collect();
    assert_eq!(read, vec![json!(["user", "e1"]), json!(["assistant", "e1o"])]);
    assert_eq!(logged[0]["content"], json!([{ "type": "text", "text": "!echo printed" }]));

    turn(&host, "what did I run?");
    let prompt = &fake.calls()[0].prompt;
    assert!(prompt.starts_with("I ran this myself:\n$ echo printed\nprinted\n"), "{prompt}");
    assert!(prompt.ends_with("\n\nwhat did I run?"), "{prompt}");
}

#[test]
fn a_command_that_fails_is_a_failed_card_and_an_empty_one_is_refused() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(Vec::new()));
    let events = turn(&host, "!exit 3");
    assert_has(&events, json!({ "type": "tool_execution_end", "toolName": "bash", "isError": true, "summary": "Exit 3" }));
    assert_eq!(events.last().unwrap(), &json!({ "type": "done" }));
    for empty in ["!", "!!", " !!  "] {
        let refusal = host.admit_turn(empty).err().expect("an empty command is refused");
        assert_eq!((refusal.code.as_str(), refusal.message.as_str()), ("invalid_request", "Write a command after ! or !!."));
    }
    // A refused command holds nothing: the conversation takes the next turn.
    assert!(host.admit_turn("!true").is_ok());
}

#[test]
fn a_newline_free_commands_output_is_bounded_and_keeps_its_actual_trailing_bytes() {
    let home = Scratch::new();
    // Nothing answers here, so the long output is not a conversation to hand off.
    let host = ConversationHost::new(home.options(None));
    turn(&host, "!printf '%0600000d' 0; printf tail");
    let entries = read_log(&home.conversation_dir()).unwrap().unwrap();
    let Some(LogEntry::Command { output, .. }) = entries.iter().find(|entry| matches!(entry, LogEntry::Command { .. })) else {
        panic!("Owner command was not logged.");
    };
    assert_eq!(text::len(output), 100_000);
    assert!(output.ends_with("tail"));
    assert!(!output.contains('\n'));
}

#[test]
fn a_running_command_is_stopped() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(Vec::new()));
    let (events, running) = start(&host, "!sleep 30");
    wait_for_event(&events, "tool_execution_start");
    // A command has no passes to queue after; it is busy, not idle.
    assert_eq!(code(host.queue_message("after")), "conversation_busy");
    assert_eq!(host.queued_messages(), json!({ "streaming": false, "followUp": [] }));
    host.stop_turn().unwrap();
    running.join().unwrap();
    assert_eq!(events.all().last().unwrap(), &json!({ "type": "error", "reason": "aborted", "errorMessage": "Command aborted." }));
}

#[test]
fn the_conversation_shows_an_owner_command_while_it_runs_and_after() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["on it"])));
    let (events, running) = start(&host, "!sleep 30");
    wait_for_event(&events, "tool_execution_start");
    // A command is logged when it ends: until then only `running` says it is there.
    let mut only_running = nothing_said();
    only_running["running"] = json!(true);
    assert_eq!(conversation(&host), only_running);
    host.stop_turn().unwrap();
    running.join().unwrap();
    assert_carries(&conversation(&host), json!({ "running": false, "messageCount": 2, "preview": "!sleep 30" }));

    // The command keeps the preview when the owner's first words come after it.
    turn(&host, "fix the failing build please");
    assert_carries(&conversation(&host), json!({ "messageCount": 4, "preview": "!sleep 30" }));

    // `!!` output is kept from the transcript too, so it alone leaves nothing said.
    let other = Scratch::new();
    let host = other.host(&Fake::new(Vec::new()));
    turn(&host, "!!echo hidden");
    assert_eq!(conversation(&host), nothing_said());
}

#[test]
fn a_commands_output_is_fenced_so_a_fence_line_inside_stays_code() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(Vec::new()));
    turn(&host, "!printf '# Readme\\n```sh\\nls\\n```\\n'");
    assert_eq!(messages(&host).last().unwrap()["content"], json!([{ "type": "text", "text": "````\n# Readme\n```sh\nls\n```\n````" }]));
}

#[test]
fn a_message_that_is_only_a_photo_goes_to_the_model_not_to_bash() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&["a red bicycle"]));
    let host = home.host(&fake);
    let events = turn(&host, "![image](attachments/k1-photo.jpg)");
    assert!(of_type(&events, &["tool_execution_start"]).is_empty());
    assert!(fake.calls()[0].prompt.contains("![image](attachments/k1-photo.jpg)"));

    // `!!` keeps a command whose text opens with `[` out of the ghost's context.
    let before = messages(&host);
    let kept = turn(&host, "!![ -d / ] && echo kept");
    assert_has(&kept, json!({ "type": "tool_execution_end", "toolName": "bash", "isError": false, "summary": "kept" }));
    assert_eq!(messages(&host), before);
}

#[test]
fn the_output_of_an_excluded_command_is_kept_from_the_ghost() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&["ok", "ok"]));
    let host = home.host(&fake);
    turn(&host, "hello");
    turn(&host, "!!echo secret");
    turn(&host, "next");
    let call = &fake.calls()[1];
    assert_eq!(call.prompt, "next");
    assert!(!json!(call.history).to_string().contains("secret"), "{:?}", call.history);
}

// ── session_stop hooks ─────────────────────────────────────────────────

#[test]
fn the_turn_continues_while_a_session_stop_hook_asks_it_to() {
    let home = Scratch::new();
    let (stop, hooks) = StopHook::new(&home, false);
    let fake = Fake::new(replies(&["done", "verified"]));
    let host = home.host_with_hooks(&fake, hooks);
    let events = turn(&host, "do it");

    // Each run of the hook is bracketed by its name and event, so a client can
    // tell a stop hook, which runs after the reply is complete, from one the
    // reply waits on.
    assert_eq!(
        of_type(&events, &["hook_start", "hook_end", "session_stop_continued", "done"]),
        vec![
            json!({ "type": "hook_start", "name": "Review", "event": "session_stop" }),
            json!({ "type": "hook_end", "name": "Review", "event": "session_stop" }),
            json!({ "type": "session_stop_continued", "reason": "verify it" }),
            json!({ "type": "hook_start", "name": "Review", "event": "session_stop" }),
            json!({ "type": "hook_end", "name": "Review", "event": "session_stop" }),
            json!({ "type": "done" }),
        ]
    );
    assert_eq!(fake.calls()[1].prompt, "Stop hook feedback:\nverify it");
    assert_eq!(roles(&host), ["user", "assistant", "hook", "assistant"]);
    let inputs = stop.inputs();
    let [first, continued] = inputs.as_slice() else { panic!("the hook ran {} times", inputs.len()) };
    assert!(first["turn_id"].is_string());
    assert_carries(first, json!({ "type": "session_stop", "owner_prompt": "do it", "stop_hook_active": false }));
    assert_carries(continued, json!({ "type": "session_stop", "owner_prompt": "do it", "turn_id": first["turn_id"], "stop_hook_active": true }));
    // What every hook event carries (docs/hooks.md), and what the ghost just said.
    let said = json!({ "role": "assistant", "content": [{ "type": "text", "text": "done" }] });
    assert_carries(
        first,
        json!({
            "ghost_name": "Casper",
            "ghost_home": home.ghost().dir().to_string_lossy(),
            "cwd": home.conversation_dir().to_string_lossy(),
            "transcript_path": log_path(&home.conversation_dir()).to_string_lossy(),
            "messages": [said],
            "last_assistant_message": said,
        }),
    );
}

// A question ends the turn on the owner: a stop hook's "keep going" must
// not carry the ghost past its own question.
#[test]
fn no_session_stop_hook_runs_while_the_ghosts_question_waits_on_the_owner() {
    let home = Scratch::new();
    let (stop, hooks) = StopHook::new(&home, false);
    let gate = Gate::default();
    let asking = FakeTurn { gate: Some(gate.clone()), ..says("Write this as my character file?") };
    let fake = Fake::new([vec![asking], replies(&["written"])].concat());
    let host = home.host_with_hooks(&fake, hooks);
    let (events, running) = start(&host, "draft your character");
    fake.wait_for_calls(1);
    // The ghost asks during its pass.
    let options = ["Write it".to_string(), "Change something first".to_string()];
    let asked = host.set_question("Write this as my character file?", &options).unwrap();
    gate.release();
    running.join().unwrap();
    let events = events.all();
    assert_eq!(fake.calls().len(), 1);
    assert!(of_type(&events, &["hook_start"]).is_empty());
    assert!(stop.inputs().is_empty());
    assert_eq!(events.last().unwrap(), &json!({ "type": "done" }));
    // The question is the conversation's until the owner's next message answers it.
    assert_eq!(conversation(&host)["question"], asked);
    assert_carries(&asked, json!({ "text": "Write this as my character file?", "options": options }));
    turn(&host, "Write it");
    assert_eq!(conversation(&host)["question"], Value::Null);
}

// A hook's feedback is not the owner's answer: the question it finds open stays
// open, and ends the turn on the owner as any question does.
#[test]
fn a_hook_continuation_leaves_the_open_question_for_the_owners_next_message_to_answer() {
    let home = Scratch::new();
    let (stop, hooks) = StopHook::new(&home, true);
    let fake = Fake::new(replies(&["done", "verified", "noted"]));
    let host = home.host_with_hooks(&fake, hooks);
    let (events, running) = start(&host, "do it");
    // The hook is running, and answers only once it is let go: the question is asked before its continuation.
    wait_for_event(&events, "hook_start");
    let asked = host.set_question("Ship it?", &["Yes".to_string(), "Not yet".to_string()]).unwrap();
    stop.go();
    running.join().unwrap();

    assert_eq!(fake.prompts(), ["do it", "Stop hook feedback:\nverify it"]);
    assert_eq!(roles(&host), ["user", "assistant", "hook", "assistant"]);
    assert_eq!(conversation(&host)["question"], asked);
    assert_eq!(stored(&question_path(&home.conversation_dir())), Some(asked));
    // The continuation's own pass is not reviewed while the question waits.
    assert_eq!(stop.inputs().len(), 1);

    turn(&host, "Yes");
    assert_eq!(conversation(&host)["question"], Value::Null);
    assert!(!question_path(&home.conversation_dir()).exists());
}

// A conversation grows as long as the model's context permits; past the
// threshold, the ghost writes a note in the background once the turn has ended.
#[test]
fn a_conversation_near_the_models_context_is_handed_off_in_the_background_and_a_turn_waits_for_the_note() {
    let home = Scratch::new();
    // Past three quarters of the default context, at three characters to a token.
    let long = "x".repeat(80_000);
    let gate = Gate::default();
    let writing = FakeTurn { gate: Some(gate.clone()), ..says("The owner said hello; I answered at length.") };
    let fake = Fake::new([replies(&[&long]), vec![writing], replies(&["Still here.", "Good."])].concat());
    let host = home.host(&fake);
    // The turn itself is not held up: the note is asked for after it has ended.
    let first = turn(&host, "hello");
    assert!(of_type(&first, &["thinking"]).is_empty());
    fake.wait_for_calls(2);
    let calls = fake.calls();
    // It is asked as the conversation's own next message, so the server has read all before it.
    assert_eq!(calls[1].prompt, handoff_prompt(&home));
    assert_eq!(calls[1].history, vec![json!({ "role": "user", "content": "hello" }), json!({ "role": "assistant", "content": long })]);

    // The model answers one request at a time: a turn that arrives meanwhile waits, saying why.
    let (events, running) = start(&host, "are you there?");
    wait_for_event(&events, "thinking");
    assert_eq!(fake.calls().len(), 2);
    gate.release();
    running.join().unwrap();
    assert_has(&events.all(), json!({ "type": "thinking", "delta": "Handing off: updating the topic documents and writing a note…\n" }));
    // It then runs from the note, with the owner's words.
    let calls = fake.calls();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[2].history, Vec::<Value>::new());
    assert_eq!(
        calls[2].prompt,
        "The conversation before this was handed off. Its note:\n\nThe owner said hello; I answered at length.\n\nare you there?"
    );
    // The log keeps everything, the note among it and saying what it covers, and the owner reads it all.
    let logged = messages(&host);
    let contents: Vec<&Value> = logged.iter().map(|message| &message["content"][0]).collect();
    assert_eq!(contents[2], &json!({ "type": "handoff", "text": "The owner said hello; I answered at length.", "covers": 3 }));
    assert_eq!(contents[3], &json!({ "type": "text", "text": "are you there?" }));
    assert_eq!(contents[4], &json!({ "type": "text", "text": "Still here." }));

    // Short again, the next turn hands off nothing and waits for nothing.
    let last = turn(&host, "good");
    assert!(of_type(&last, &["thinking"]).is_empty());
    assert_eq!(fake.calls().len(), 4);
    assert_eq!(fake.calls()[3].prompt, "good");
}

// What the server counted is what decides, when it has said.
#[test]
fn the_servers_own_count_of_the_context_decides_when_it_is_known() {
    let home = Scratch::new();
    let counted = FakeTurn { events: vec![PassEvent::Context { tokens: 30_000, characters: 90_000 }, said("a", "short")], ..Default::default() };
    let fake = Fake::new([vec![counted], replies(&["a note", "after"])].concat());
    let host = home.host(&fake);
    turn(&host, "hello");
    turn(&host, "again");
    assert_eq!(fake.calls()[1].prompt, handoff_prompt(&home));
    assert!(fake.calls()[2].prompt.ends_with("a note\n\nagain"));
}

// One long output can overflow the context inside a turn. The turn fails saying
// so, and the next one is not stuck: the note is written from what still fits.
#[test]
fn a_conversation_that_outgrew_the_context_mid_turn_is_handed_off_from_what_still_fits() {
    let home = Scratch::new();
    let outgrown = FakeTurn {
        events: vec![said("a", &"y".repeat(30_000)), PassEvent::Context { tokens: 40_000, characters: 90_000 }],
        fail: Some("The conversation no longer fits the model's context (40000 of 32768 tokens).".to_string()),
        ..Default::default()
    };
    let fake = Fake::new([vec![says(&"x".repeat(60_000)), outgrown], replies(&["a note of what fits", "carrying on"])].concat());
    let host = home.host(&fake);
    turn(&host, "first");
    turn(&host, "second");
    turn(&host, "third");
    let calls = fake.calls();
    assert_eq!(calls[2].prompt, handoff_prompt(&home));
    // Not the whole conversation, which no longer fits, but its newest turn, from the owner's message on.
    assert_eq!(calls[2].history.len(), 2);
    assert_eq!(calls[2].history[0], json!({ "role": "user", "content": "second" }));
    assert!(calls[3].prompt.ends_with("a note of what fits\n\nthird"), "{}", &calls[3].prompt[..80]);
}

// A handoff keeps the ghost's topic documents: it runs commands as a turn
// does, and only what it says after the last of them is the note.
#[test]
fn a_handoff_brings_the_topic_documents_up_to_date_and_the_next_turn_is_handed_its_note_and_their_index() {
    let home = Scratch::new();
    let long = "x".repeat(80_000);
    let gate = Gate::default();
    let write = "printf 'The Heron leaves the north pier at nine.\\n' > ../topics/boat-trip.md";
    let handing_off = FakeTurn {
        gate: Some(gate.clone()),
        events: vec![
            PassEvent::Thinking { block: "r1".into(), delta: "One topic: the boat.".into() },
            said("r1", "Writing it down."),
            PassEvent::ToolStart { id: "c1".into(), name: "bash".into(), args: json!({ "command": write }) },
            PassEvent::ToolEnd { id: "c1".into(), is_error: false, output: "(no output)".into() },
            said("r2", "Waiting on the owner to pick a pier."),
        ],
        ..Default::default()
    };
    let fake = Fake::new([replies(&[&long]), vec![handing_off], replies(&["North.", "Still nine."])].concat());
    let host = home.host(&fake);
    turn(&host, "when does the boat leave?");
    fake.wait_for_calls(2);
    // The directory is there for the ghost's first document, and the pass's commands run where a turn's do.
    assert!(home.topics_dir().is_dir());
    assert_eq!(fake.calls()[1].prompt, handoff_prompt(&home));
    assert_eq!(fake.calls()[1].cwd, home.conversation_dir());
    // What the scripted command stands for.
    std::fs::write(home.topics_dir().join("boat-trip.md"), "The Heron leaves the north pier at nine.\n").unwrap();
    gate.release();

    turn(&host, "which pier?");
    let index = format!(
        "Your topic documents are in \"{}\"; `cat` one when the conversation returns to its topic:\n- boat-trip.md: The Heron leaves the north pier at nine.",
        home.topics_dir().display()
    );
    let opening = format!("The conversation before this was handed off. Its note:\n\nWaiting on the owner to pick a pier.\n\n{index}");
    // The next turn is handed the note and the index, and none of the handoff's own commands.
    let calls = fake.calls();
    assert_eq!((calls[2].prompt.as_str(), &calls[2].history), (format!("{opening}\n\nwhich pier?").as_str(), &Vec::new()));
    // The log keeps what the handoff did, in order, and its note says what it covers and what was told of the documents.
    let handoff = &messages(&host)[2]["content"];
    assert_eq!(
        handoff,
        &json!([
            { "type": "thinking", "text": "One topic: the boat." },
            { "type": "text", "text": "Writing it down." },
            { "type": "toolCall", "id": "c1", "name": "bash", "arguments": { "command": write }, "output": "(no output)" },
            { "type": "handoff", "text": "Waiting on the owner to pick a pier.", "covers": 3, "topics": index },
        ])
    );

    // Nothing a turn is handed changes between turns: the owner's edit and a new document wait for the next handoff.
    std::fs::write(home.topics_dir().join("boat-trip.md"), "Cancelled.\n").unwrap();
    std::fs::write(home.topics_dir().join("taxes.md"), "Filed.\n").unwrap();
    turn(&host, "and when?");
    assert_eq!(fake.calls()[3].history[0], json!({ "role": "user", "content": format!("{opening}\n\nwhich pier?") }));
}

// The owner is not there to be asked, and a question is not a note.
#[test]
fn a_handoff_asks_the_owner_nothing() {
    let home = Scratch::new();
    let asking = FakeTurn { ask: Some(("Which pier?".to_string(), vec!["North".to_string(), "South".to_string()])), ..says("Which pier?") };
    // The handoff tried again after the next turn is held, so the log is read as that turn left it.
    let held = FakeTurn { gate: Some(Gate::default()), ..Default::default() };
    let fake = Fake::new([replies(&[&"x".repeat(80_000)]), vec![asking], replies(&["after"]), vec![held]].concat());
    let host = home.host(&fake);
    turn(&host, "hello");
    fake.wait_for_calls(2);
    turn(&host, "again");
    assert_eq!(conversation(&host)["question"], Value::Null);
    assert_eq!(fake.calls()[2].prompt, "again");
    assert_eq!(roles(&host), ["user", "assistant", "user", "assistant"]);
    host.shut_down();
}

// A handoff runs commands, so the owner can stop one as they stop a turn.
#[test]
fn a_stop_stops_a_handoff_and_the_conversation_carries_on_whole() {
    let home = Scratch::new();
    let long = "x".repeat(80_000);
    let stuck = FakeTurn { gate: Some(Gate::default()), ..says("never said") };
    let fake = Fake::new([replies(&[&long]), vec![stuck], replies(&["Here."])].concat());
    let host = home.host(&fake);
    turn(&host, "hello");
    fake.wait_for_calls(2);
    host.stop_turn().unwrap();
    // No note: the next turn waits for nothing and is handed the conversation as it was.
    let events = turn(&host, "are you there?");
    assert!(of_type(&events, &["thinking"]).is_empty());
    let calls = fake.calls();
    assert_eq!(calls[2].history, vec![json!({ "role": "user", "content": "hello" }), json!({ "role": "assistant", "content": long })]);
    assert_eq!(calls[2].prompt, "are you there?");
    // With nothing left to stop, a stop is refused again.
    host.shut_down();
    assert_eq!(host.stop_turn().unwrap_err().code, "conversation_not_streaming");
}

// Starting over clears the conversation, not what the ghost knows: a new
// conversation is told of the topic documents there are, once, as it starts.
#[test]
fn a_new_conversation_is_told_of_the_topic_documents_there_are_as_it_starts() {
    let home = Scratch::new();
    std::fs::create_dir_all(home.topics_dir()).unwrap();
    std::fs::write(home.topics_dir().join("boat-trip.md"), "# The Heron, north pier at nine\n\nBooked on 2026-11-20.\n").unwrap();
    let fake = Fake::new(replies(&["Hello.", "Yes.", "Hello again."]));
    let host = home.host(&fake);
    turn(&host, "hello");
    let told = |index: &str| {
        format!("Your topic documents are in \"{}\"; `cat` one when the conversation returns to its topic:\n{index}", home.topics_dir().display())
    };
    let first = format!("{}\n\nhello", told("- boat-trip.md: The Heron, north pier at nine"));
    assert_eq!((fake.calls()[0].prompt.as_str(), &fake.calls()[0].history), (first.as_str(), &Vec::new()));
    // The log's first line keeps what it was told, so a document written since changes nothing the server has read.
    let header = &read_log(&home.conversation_dir()).unwrap().unwrap()[0];
    assert!(
        matches!(header, LogEntry::Conversation { topics: Some(topics), .. } if *topics == told("- boat-trip.md: The Heron, north pier at nine"))
    );
    std::fs::write(home.topics_dir().join("taxes.md"), "Filed on 2026-11-26.\n").unwrap();
    turn(&host, "still there?");
    assert_eq!(fake.calls()[1].history[0], json!({ "role": "user", "content": first }));
    // The owner sees nothing of it: their message is their own words.
    assert_eq!(messages(&host)[0]["content"][0]["text"], "hello");

    if crate::env::which("gio", &home.env()).is_none() {
        eprintln!("skipped: gio is not installed");
        return;
    }
    // Starting over leaves the documents where they are, and the new conversation is told of them as they now stand.
    host.delete_conversation().unwrap();
    turn(&host, "hello");
    assert_eq!(
        fake.calls()[2].prompt,
        format!("{}\n\nhello", told("- boat-trip.md: The Heron, north pier at nine\n- taxes.md: Filed on 2026-11-26."))
    );
    assert!(fake.calls()[2].history.is_empty());
}

// The model's `ask` tool reaches the same open question a pass is handed the way to set.
#[test]
fn a_pass_puts_its_question_to_the_owner_and_the_owners_next_message_removes_it() {
    let home = Scratch::new();
    let options = vec!["North pier".to_string(), "South pier".to_string()];
    let asking = FakeTurn { ask: Some(("Which pier?".to_string(), options.clone())), ..says("Which pier?") };
    let fake = Fake::new([vec![asking], replies(&["booked"])].concat());
    let host = home.host(&fake);
    turn(&host, "book the boat");
    let asked = conversation(&host)["question"].clone();
    assert_carries(&asked, json!({ "text": "Which pier?", "options": options }));
    assert!(clock::parse_iso(asked["askedAt"].as_str().unwrap()).is_some(), "{asked}");
    // It is kept beside the log, as the conversation gives it.
    let file = question_path(&home.conversation_dir());
    assert_eq!(file, home.conversation_dir().join(".question.json"));
    assert_eq!(stored(&file), Some(asked));
    turn(&host, "North pier");
    assert_eq!(conversation(&host)["question"], Value::Null);
    assert!(!file.exists());
    // The answer's pass is handed the question, as the reply said it.
    assert!(json!(fake.calls()[1].history).to_string().contains("Which pier?"));
}

#[test]
fn repeated_identical_owner_requests_have_distinct_hook_identities() {
    let home = Scratch::new();
    let (stop, hooks) = StopHook::new(&home, false);
    let fake = Fake::new(replies(&["done", "verified", "done again", "verified again"]));
    let host = home.host_with_hooks(&fake, hooks);
    turn(&host, "do it");
    turn(&host, "do it");
    let ids: Vec<Value> = stop.inputs().iter().map(|input| input["turn_id"].clone()).collect();
    assert_eq!(ids.len(), 4);
    assert_eq!(ids, [ids[0].clone(), ids[0].clone(), ids[2].clone(), ids[2].clone()]);
    assert_ne!(ids[2], ids[0]);
}

#[test]
fn the_stop_hook_is_not_asked_while_the_owners_follow_up_waits() {
    let home = Scratch::new();
    let (stop, hooks) = StopHook::new(&home, true);
    stop.go();
    let gate = Gate::default();
    let fake = Fake::new([vec![FakeTurn { gate: Some(gate.clone()), ..says("first") }], replies(&["second", "verified"])].concat());
    let host = home.host_with_hooks(&fake, hooks);
    let (events, running) = start(&host, "one");
    fake.wait_for_calls(1);
    host.queue_message("two").unwrap();
    gate.release();
    running.join().unwrap();
    let events = events.all();

    // The first pass is not reviewed; the follow-up's own pass is.
    assert_eq!(fake.prompts(), ["one", "two", "Stop hook feedback:\nverify it"]);
    let position = |kind: &str| events.iter().position(|event| event["type"] == kind).unwrap_or_else(|| panic!("no {kind} event"));
    assert!(position("owner_message") < position("session_stop_continued"));
    let inputs = stop.inputs();
    let [reviewed, continued] = inputs.as_slice() else { panic!("the hook ran {} times", inputs.len()) };
    assert!(reviewed["turn_id"].is_string());
    assert_carries(reviewed, json!({ "type": "session_stop", "owner_prompt": "two", "stop_hook_active": false }));
    assert_carries(continued, json!({ "type": "session_stop", "owner_prompt": "two", "turn_id": reviewed["turn_id"], "stop_hook_active": true }));
}

#[test]
fn a_follow_up_sent_while_the_stop_hook_runs_wins_over_its_continuation() {
    let home = Scratch::new();
    let (stop, hooks) = StopHook::new(&home, true);
    let fake = Fake::new(replies(&["first", "second"]));
    let host = home.host_with_hooks(&fake, hooks);
    let (events, running) = start(&host, "one");
    // The hook is running, and answers only once it is let go.
    wait_for_event(&events, "hook_start");
    host.queue_message("two").unwrap();
    stop.go();
    running.join().unwrap();
    let events = events.all();

    assert_eq!(fake.prompts(), ["one", "two"]);
    assert_has(&events, json!({ "type": "owner_message", "text": "two" }));
    assert!(of_type(&events, &["session_stop_continued"]).is_empty());
    let inputs = stop.inputs();
    let [first, reviewed] = inputs.as_slice() else { panic!("the hook ran {} times", inputs.len()) };
    assert!(first["turn_id"].is_string());
    assert_carries(first, json!({ "owner_prompt": "one" }));
    assert_carries(reviewed, json!({ "owner_prompt": "two", "stop_hook_active": false }));
    assert_ne!(reviewed["turn_id"], first["turn_id"]);
}

// ── The conversation's state ───────────────────────────────────────────

#[test]
fn the_conversation_has_no_preview_and_no_time_until_something_is_said() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["hi"])));
    assert_eq!(conversation(&host), nothing_said());
    // Asking for it makes nothing.
    assert!(!home.conversation_dir().exists());

    let before = clock::now_ms();
    turn(&host, "Plan the zine\nwith details");
    let row = conversation(&host);
    assert_carries(&row, json!({ "preview": "Plan the zine", "messageCount": 2, "unread": true, "running": false, "question": null }));
    assert!(clock::parse_iso(row["updatedAt"].as_str().unwrap()).is_some_and(|at| at >= before), "{row}");
    assert_eq!(row.as_object().unwrap().len(), 6);

    host.mark_read(clock::now_ms() + 60_000).unwrap();
    assert_carries(&conversation(&host), json!({ "preview": "Plan the zine", "messageCount": 2, "unread": false }));
}

#[test]
fn starting_over_moves_the_whole_conversation_directory_to_trash() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&["hi", "hello again"]));
    let host = home.host(&fake);
    if crate::env::which("gio", &home.env()).is_none() {
        eprintln!("skipped: gio is not installed");
        return;
    }
    turn(&host, "Plan the zine");
    let photo = host.save_attachment(b"\x89PNG\r\n\x1a\nrest").unwrap();
    host.set_question("Which paper?", &["Newsprint".to_string(), "Cotton".to_string()]).unwrap();
    host.mark_read(clock::now_ms()).unwrap();
    let dir = home.conversation_dir();
    let kept = [log_path(&dir), dir.join(&photo), question_path(&dir), read_path(&dir)];
    for path in &kept {
        assert!(path.exists(), "{}", path.display());
    }
    let photo_name = photo.strip_prefix("attachments/").unwrap();
    assert!(host.read_attachment(photo_name).is_ok());

    host.delete_conversation().unwrap();
    assert!(!dir.exists());
    let trashed = home.trash_dir().join("files").join(dir.file_name().unwrap());
    for path in &kept {
        let moved = trashed.join(path.strip_prefix(&dir).unwrap());
        assert!(moved.exists(), "{}", moved.display());
    }
    // Nothing of it is left to read: not its messages, its question, its read mark, or its photo.
    assert_eq!(conversation(&host), nothing_said());
    assert_eq!(host.read_transcript(None, None).unwrap(), json!({ "messages": [], "total": 0, "truncated": false }));
    assert_eq!(code(host.read_attachment(photo_name)), "not_found");
    let refusal = host.delete_conversation().unwrap_err();
    assert_eq!((refusal.code.as_str(), refusal.status), ("not_found", 404));

    // The next message makes a new one, handed nothing of the old.
    turn(&host, "Start again");
    assert_eq!(fake.calls()[1].history, Vec::<Value>::new());
    assert_carries(&conversation(&host), json!({ "preview": "Start again", "messageCount": 2, "unread": true, "question": null }));
}

#[test]
fn nothing_is_marked_asked_or_trashed_before_there_is_a_conversation() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["hi"])));
    let two = ["Yes".to_string(), "No".to_string()];
    for refusal in [host.mark_read(0).unwrap_err(), host.set_question("Well?", &two).unwrap_err(), host.delete_conversation().unwrap_err()] {
        assert_eq!((refusal.code.as_str(), refusal.status, refusal.message.as_str()), ("not_found", 404, "There is no conversation yet."));
    }
    // A sidecar is written beside a log, never into a directory that has none.
    assert!(!home.conversation_dir().exists());
    turn(&host, "hello");
    assert_eq!(code(host.set_question("  ", &two)), "invalid_request");
    // A question is trimmed, and its answers deduplicated.
    let answers = |list: &[&str]| list.iter().map(|answer| answer.to_string()).collect::<Vec<_>>();
    host.set_question(" Shall I? ", &answers(&[" Yes ", "Yes", "", "No"])).unwrap();
    assert_carries(&conversation(&host)["question"], json!({ "text": "Shall I?", "options": ["Yes", "No"] }));
    // It offers 2 to 4 different answers: fewer or more is refused, and the open question stays.
    for refused in [answers(&[]), answers(&["Yes", " Yes"]), answers(&["a", "b", "c", "d", "e"])] {
        let refusal = host.set_question("Again?", &refused).unwrap_err();
        assert_eq!(
            (refusal.code.as_str(), refusal.message.as_str()),
            ("invalid_request", "A question offers 2 to 4 different options."),
            "{refused:?}"
        );
    }
    host.set_question("Which?", &answers(&["a", "b", "c", "d"])).unwrap();
    assert_carries(&conversation(&host)["question"], json!({ "text": "Which?", "options": ["a", "b", "c", "d"] }));
}

#[test]
fn a_late_read_receipt_does_not_move_the_read_watermark_backwards() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["done"])));
    turn(&host, "Do it");
    let latest = clock::now_ms();
    assert_eq!(host.mark_read(latest).unwrap(), clock::iso(latest));
    assert_eq!(host.mark_read(0).unwrap(), clock::iso(latest));
    // The mark is kept beside the log.
    assert_eq!(stored(&home.conversation_dir().join(".read.json")), Some(json!({ "readAt": clock::iso(latest) })));
}

#[test]
fn read_marks_that_race_leave_the_latest() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["done"])));
    turn(&host, "Do it");
    let latest = clock::now_ms();
    std::thread::scope(|scope| {
        for earlier in 0..8 {
            let host = &host;
            scope.spawn(move || host.mark_read(latest - earlier * 1_000).unwrap());
        }
    });
    assert_eq!(stored(&read_path(&home.conversation_dir())), Some(json!({ "readAt": clock::iso(latest) })));
}

// ── Conversation events and unread state ───────────────────────────────

#[test]
fn the_conversation_starts_unread_is_marked_read_then_is_unread_after_a_newer_turn() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["hello"])));
    turn(&host, "first");
    let row = conversation(&host);
    assert_eq!(row["unread"], true);

    let read_at = clock::parse_iso(row["updatedAt"].as_str().unwrap()).unwrap() + 1;
    host.mark_read(read_at).unwrap();
    assert_eq!(conversation(&host)["unread"], false);

    // A newer turn is one the clock has moved on for: time has no signal to wait on.
    while clock::now_ms() <= read_at {
        std::thread::sleep(Duration::from_millis(1));
    }
    turn(&host, "second");
    assert_eq!(conversation(&host)["unread"], true);
}

#[test]
fn subscribers_hear_small_invalidations_for_turns_and_read_changes_until_they_leave() {
    let home = Scratch::new();
    let host = home.host(&Fake::new(replies(&["hello"])));
    let (heard, left): (Arc<Seen<Value>>, Arc<Seen<Value>>) = (Seen::new(), Seen::new());
    let (keep, closed) = (heard.clone(), Seen::new());
    let ended = closed.clone();
    host.subscribe(
        move |event| {
            keep.push(event.clone());
        },
        move || {
            ended.push(());
        },
    );
    let keep = left.clone();
    let leaving = host.subscribe(
        move |event| {
            keep.push(event.clone());
        },
        || panic!("a subscriber that left is not closed"),
    );

    turn(&host, "Who are you?");
    // Its prompt was logged, and it ended: each a change to read again.
    let turned = heard.all();
    assert_eq!(turned.len(), 2);
    for event in &turned {
        assert_eq!(event["type"], "conversation-updated");
        assert!(clock::parse_iso(event["updatedAt"].as_str().unwrap()).is_some(), "{event}");
        assert_eq!(event.as_object().unwrap().len(), 2);
    }
    assert_eq!(left.all(), turned);

    host.unsubscribe(leaving);
    host.mark_read(clock::now_ms()).unwrap();
    assert_eq!(heard.all().len(), 3);
    assert_eq!(left.all().len(), 2);

    // Shutdown ends the streams still open and refuses another turn.
    host.shut_down();
    assert_eq!(closed.all().len(), 1);
    host.mark_read(clock::now_ms()).unwrap();
    assert_eq!(heard.all().len(), 3);
    let refusal = host.admit_turn("again").err().expect("a stopping daemon admits no turn");
    assert_eq!((refusal.code.as_str(), refusal.status), ("shutting_down", 503));
}

#[test]
fn shutdown_aborts_the_turn_that_is_running() {
    let home = Scratch::new();
    let fake = Fake::new(vec![FakeTurn { gate: Some(Gate::default()), ..Default::default() }]);
    let host = home.host(&fake);
    let (events, running) = start(&host, "wait");
    fake.wait_for_calls(1);
    host.shut_down();
    running.join().unwrap();
    assert_carries(events.all().last().unwrap(), json!({ "type": "error", "reason": "aborted" }));
}

// ── Alerts when a turn ends ─────────────────────────────────────────────

/// A host whose one subscribed device's alerts are kept in the returned list
/// instead of being sent; `hold` keeps each send waiting until released.
fn alerting(home: &Scratch, fake: &Arc<Fake>, link: bool, hold: Option<Gate>) -> (ConversationHost, Arc<Seen<Value>>) {
    let alerts = Seen::new();
    let kept = alerts.clone();
    let push = crate::push::Push::with_sender(
        home.root.join("push.json"),
        Logger::silent(),
        Box::new(move |_, alert| {
            kept.push(alert.clone());
            if let Some(gate) = &hold {
                let _ = gate.hold(&Abort::new());
            }
            crate::push::Sent::Delivered
        }),
    );
    push.subscribe(
        crate::push::Subscription::parse(&json!({
            "endpoint": "https://fcm.googleapis.com/fcm/send/phone",
            "p256dh": "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "auth": "BTBZMqHH6r4Tts7J_aSIgg",
            "vapidKey": "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        }))
        .unwrap(),
    )
    .unwrap();
    let host = ConversationHost::new(ConversationHostOptions {
        push,
        app_url: link.then(|| Box::new(|| Some("https://summonghost.com/#/ghost.example.ts.net".to_string())) as AppUrl),
        ..home.options(Some(fake.clone()))
    });
    (host, alerts)
}

#[test]
fn a_turn_that_ends_alerts_the_owners_devices_once_with_the_ghosts_name_a_bounded_excerpt_and_the_apps_link() {
    let home = Scratch::new();
    let fake = Fake::new(replies(&[&format!("Finished.\n{}", "a".repeat(400))]));
    let (host, alerts) = alerting(&home, &fake, true, None);
    let events = turn(&host, "Make the report");
    let sent = alerts.wait("the alert", |seen| !seen.is_empty());
    assert_eq!(sent.len(), 1);
    let body = sent[0]["body"].as_str().unwrap();
    // The whole alert: nothing in it names a conversation.
    assert_eq!(sent[0], json!({ "title": "Casper", "body": body, "url": "https://summonghost.com/#/ghost.example.ts.net" }));
    assert_eq!(text::len(body), 280);
    assert!(body.starts_with("Finished. aaaa"), "{body}");
    assert_eq!(events.last().unwrap()["type"], "done");
}

#[test]
fn the_owner_can_prompt_again_while_a_slow_push_service_is_still_delivering() {
    let home = Scratch::new();
    let held = Gate::default();
    let (host, alerts) = alerting(&home, &Fake::new(replies(&["One.", "Two."])), false, Some(held.clone()));
    turn(&host, "First");
    alerts.wait("the first alert", |seen| seen.len() == 1);
    assert_eq!(turn(&host, "Second").last().unwrap()["type"], "done");
    alerts.wait("the second alert", |seen| seen.len() == 2);
    held.release();
}

#[test]
fn a_failed_turn_alerts_with_what_failed() {
    let home = Scratch::new();
    let failing = Fake::new(vec![FakeTurn { fail: Some("service unavailable".to_string()), ..Default::default() }]);
    let (host, alerts) = alerting(&home, &failing, false, None);
    let events = turn(&host, "Try it");
    let sent = alerts.wait("the alert", |seen| !seen.is_empty());
    assert_eq!(sent[0], json!({ "title": "Casper", "body": "Failed: service unavailable", "url": null }));
    assert_carries(events.last().unwrap(), json!({ "type": "error" }));
}

#[test]
fn a_turn_that_fails_outside_its_passes_still_alerts() {
    use std::os::unix::fs::PermissionsExt;
    let home = Scratch::new();
    let (host, alerts) = alerting(&home, &Fake::new(replies(&["hi"])), false, None);
    turn(&host, "hello");
    alerts.wait("the first turn's alert", |seen| seen.len() == 1);
    // The owner command runs, and then cannot be logged.
    let log = log_path(&home.conversation_dir());
    std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o400)).unwrap();
    if std::fs::OpenOptions::new().append(true).open(&log).is_ok() {
        eprintln!("skipped: this user writes to a read-only file");
        return;
    }
    let events = turn(&host, "!echo ran");
    std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o600)).unwrap();
    let last = events.last().unwrap();
    assert_carries(last, json!({ "type": "error", "reason": "error" }));
    let sent = alerts.wait("the failed turn's alert", |seen| seen.len() == 2);
    assert_eq!(sent[1]["body"], format!("Failed: {}", last["errorMessage"].as_str().unwrap()));
    // The conversation is not left held.
    assert_eq!(turn(&host, "still there?").last().unwrap(), &json!({ "type": "done" }));
}

#[test]
fn a_cancelled_turn_is_kept_quiet() {
    let home = Scratch::new();
    let fake = Fake::new(vec![FakeTurn { gate: Some(Gate::default()), ..Default::default() }]);
    let (host, alerts) = alerting(&home, &fake, false, None);
    let (events, running) = start(&host, "wait");
    fake.wait_for_calls(1);
    host.stop_turn().unwrap();
    running.join().unwrap();
    assert_carries(events.all().last().unwrap(), json!({ "type": "error", "reason": "aborted" }));
    // A turn that ends after it alerts first, so an alert for the cancelled one would be here by then.
    fake.then(says("after"));
    turn(&host, "again");
    let sent = alerts.wait("the later turn's alert", |seen| !seen.is_empty());
    assert_eq!(sent.len(), 1);
    assert_carries(&sent[0], json!({ "body": "after" }));
}

// ── One completion for a hook ──────────────────────────────────────────

#[test]
fn complete_returns_the_trimmed_text_and_refuses_an_empty_prompt_or_an_empty_answer() {
    let home = Scratch::new();
    let fake = Fake::new(vec![says("  APPROVE\n"), FakeTurn::default()]);
    let host = home.host(&fake);

    let refusal = host.complete("   ", &Abort::new()).unwrap_err();
    assert_eq!(refusal.code, "invalid_request");
    assert!(refusal.message.contains("non-empty"), "{}", refusal.message);
    assert_eq!(host.complete("Review this.", &Abort::new()).unwrap(), "APPROVE");
    assert_eq!(fake.prompts(), ["Review this."]);
    let refusal = host.complete("Classify.", &Abort::new()).unwrap_err();
    assert_eq!((refusal.code.as_str(), refusal.status), ("completion_failed", 502));
}

#[test]
fn complete_answers_a_session_stop_hook_while_the_turn_awaiting_it_holds_its_admission() {
    let home = Scratch::new();
    let asked: Arc<OnceLock<ConversationHost>> = Arc::new(OnceLock::new());
    let reviews = Seen::new();
    let (asking, kept) = (asked.clone(), reviews.clone());
    let hooks = hooks_run_by(json!({ "hooks": { "session_stop": [{ "hooks": [{ "type": "command", "command": "review" }] }] } }), move |_event| {
        let host = asking.get().expect("the host exists before its first turn");
        kept.push(host.complete("Is the turn done?", &Abort::new()).expect("a completion"));
        succeeded("")
    });
    let fake = Fake::new(replies(&["the answer", "APPROVE"]));
    let host = home.host_with_hooks(&fake, hooks);
    assert!(asked.set(host.clone()).is_ok());

    turn(&host, "work");
    assert_eq!(reviews.all(), ["APPROVE"]);
}

#[test]
fn complete_runs_on_the_daemons_own_local_model_with_no_persona_or_tools() {
    let home = Scratch::new();
    // A stand-in llama-server, already answering: it keeps what each request asked and says " APPROVE " to every chat.
    let asked = Seen::new();
    let kept = asked.clone();
    let server = crate::http::Server::start("127.0.0.1:0".parse().unwrap(), move |mut request, responder| {
        if request.path == "/health" {
            return responder.json(200, &json!({ "status": "ok" }));
        }
        let body: Value = serde_json::from_slice(&request.read_body(1 << 20).unwrap_or_default()).unwrap_or(Value::Null);
        kept.push(json!({ "path": request.path, "messages": body["messages"], "tools": body.get("tools").is_some() }));
        let reply = json!({ "choices": [{ "delta": { "content": " APPROVE " } }] });
        responder.bytes(200, &[("content-type", "text/event-stream")], format!("data: {reply}\n\ndata: [DONE]\n\n").as_bytes());
    })
    .unwrap();
    // Nothing here is ever run: the model's server is that one.
    let config = LocalModelConfig {
        model: home.root.join("gemma-test.gguf"),
        server: "/nowhere/llama-server".to_string(),
        context_size: 8_192,
        idle_ms: 600_000,
        reasoning_effort: "low".to_string(),
    };
    let endpoint = crate::local_model::Endpoint { address: server.address, key: "k".to_string() };
    let model = LocalModel::with_endpoint(config, Logger::silent(), home.env(), endpoint);
    let host = ConversationHost::new(ConversationHostOptions { local_model: Some(model), ..home.options(None) });

    let answer = host.complete("Review this.", &Abort::new());
    host.shut_down();
    server.close();
    assert_eq!(answer.map_err(|error| error.message), Ok("APPROVE".to_string()));
    // One completion, then, as the host shuts down, the model's slot saved for its next start.
    assert_eq!(
        asked.all(),
        vec![
            json!({ "path": "/v1/chat/completions", "messages": [{ "role": "user", "content": "Review this." }], "tools": false }),
            json!({ "path": "/slots/0", "messages": null, "tools": false }),
        ]
    );
}
