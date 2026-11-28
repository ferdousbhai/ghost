//! The HTTP API over a real listening loopback server on an ephemeral port,
//! with a scripted answerer standing where the local model does. Everything a
//! test touches lives in one scratch directory: the ghost home, the owner
//! home, and the XDG directories `gio trash` and the token file resolve from.
use super::*;
use crate::abort::Abort;
use crate::config::RemoteConfig;
use crate::conversation_host::ConversationHostOptions;
use crate::conversation_host::fake_answerer::{Fake, FakeTurn, Gate, WAIT, replies, said, says};
use crate::conversation_log::LOG_FILENAME;
use crate::http::{ClientRequest, ClientResponse, EventReader, send};
use crate::local_turn::PassEvent;
use crate::process::{CommandFailure, CommandResult};
use crate::remote::TailscaleRunner;
use crate::sidecars::read_path;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const APP: &str = "https://summonghost.com";
const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];
const JSON: (&str, &str) = ("content-type", "application/json");

/// A first turn that says "held" once released, then one for each of `after`.
fn held(after: &[&str]) -> (Vec<FakeTurn>, Gate) {
    let gate = Gate::default();
    let mut turns = vec![FakeTurn { gate: Some(gate.clone()), ..says("held") }];
    turns.extend(replies(after));
    (turns, gate)
}

// ── A fake `tailscale` ──────────────────────────────────────────────────

const FAKE_TARGET: &str = "http://127.0.0.1:7717";
const FAKE_HOSTNAME: &str = "ghostbox.example.ts.net";

/// A `tailscale` that answers the two status reads, with Serve off, and keeps every command it was asked to run.
fn fake_tailscale() -> (Arc<Mutex<Vec<String>>>, TailscaleRunner) {
    let calls: Arc<Mutex<Vec<String>>> = Arc::default();
    let asked = calls.clone();
    let runner: TailscaleRunner = Arc::new(move |args| {
        let line = args.join(" ");
        asked.lock().unwrap().push(line.clone());
        let ok = |stdout: Value| Ok(CommandResult { stdout: stdout.to_string(), stderr: String::new(), code: 0 });
        match line.as_str() {
            // The owner's laptop and phone, a partner's shared machine, and a tagged server.
            "status --json" => ok(json!({
                "BackendState": "Running",
                "Self": { "DNSName": format!("{FAKE_HOSTNAME}."), "UserID": 42 },
                "Peer": {
                    "a": { "DNSName": "laptop.example.ts.net.", "UserID": 42, "Online": true },
                    "b": { "DNSName": "phone.example.ts.net.", "UserID": 42, "Online": false },
                    "c": { "DNSName": "partner.example.ts.net.", "UserID": 7, "Online": true },
                    "d": { "DNSName": "server.example.ts.net.", "UserID": 42, "Online": true, "Tags": ["tag:server"] },
                },
                "User": { "42": { "LoginName": "owner@example.com" }, "7": { "LoginName": "partner@example.com" } },
            })),
            "serve status --json" => ok(json!({})),
            _ => Err(CommandFailure::Other(format!("Unexpected command: {line}"))),
        }
    });
    (calls, runner)
}

fn serve_over(runner: TailscaleRunner) -> Arc<RemoteServe> {
    Arc::new(RemoteServe::new(7717, &RemoteConfig { owner: None, apps: Vec::new() }, runner))
}

/// Tailnet callers as the remote tests admit them: this node belongs to
/// `Owner@Example.com`, and no one else is admitted.
fn tailnet(owner: Option<&str>) -> Option<Arc<RemoteAccess>> {
    let config = RemoteConfig { owner: owner.map(str::to_string), apps: Vec::new() };
    Some(Arc::new(RemoteAccess::with_self_login(&config, Box::new(|| Some("Owner@Example.com".to_string())))))
}

// ── A daemon on scratch state ───────────────────────────────────────────

struct Reply {
    status: u16,
    head: ClientResponse,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.header(name)
    }

    fn text(&self) -> String {
        String::from_utf8(self.body.clone()).expect("a UTF-8 body")
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("a JSON body, not {:?}", self.text()))
    }

    /// The `{ error: { message, code } }` envelope's code, which must come with a message.
    fn code(&self) -> String {
        let body = self.json();
        assert!(body["error"]["message"].is_string(), "{body}");
        assert_eq!(body.as_object().map(Map::len), Some(1), "{body}");
        body["error"]["code"].as_str().expect("an error code").to_string()
    }

    /// The body's events, as Ghost's own SSE reader takes them.
    fn events(&self) -> Vec<Value> {
        let mut reader = EventReader::new(&self.body[..]);
        let mut events = Vec::new();
        while let Some(data) = reader.next_event().unwrap() {
            events.push(serde_json::from_str(&data).expect("a JSON event"));
        }
        events
    }
}

fn finish(mut response: ClientResponse) -> Reply {
    let mut body = Vec::new();
    response.body.read_to_end(&mut body).expect("a whole body");
    Reply { status: response.status, head: response, body }
}

fn types(events: &[Value]) -> Vec<&str> {
    events.iter().map(|event| event["type"].as_str().unwrap_or("")).collect()
}

fn terminals(events: &[Value]) -> Vec<&Value> {
    events.iter().filter(|event| matches!(event["type"].as_str(), Some("done" | "error"))).collect()
}

fn deltas(events: &[Value]) -> Vec<&str> {
    events.iter().filter(|event| event["type"] == "text_delta").map(|event| event["delta"].as_str().unwrap()).collect()
}

fn turn_body(prompt: &str) -> Value {
    json!({ "prompt": prompt })
}

/// The turn most tests send: "Who are you?".
fn first_turn() -> Value {
    turn_body("Who are you?")
}

type Pushed = Arc<Mutex<Vec<(String, Value)>>>;

/// Poll until `ready` has a value, or fail after `WAIT`.
fn wait_for<T>(mut ready: impl FnMut() -> Option<T>) -> T {
    let deadline = std::time::Instant::now() + WAIT;
    loop {
        if let Some(value) = ready() {
            return value;
        }
        assert!(std::time::Instant::now() < deadline, "timed out waiting");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

struct Daemon {
    root: PathBuf,
    ghost_dir: PathBuf,
    conversation_dir: PathBuf,
    hooks_path: PathBuf,
    env: Env,
    fake: Arc<Fake>,
    host: ConversationHost,
    listening: Server,
    /// One message per change to the conversation the host announces.
    updates: mpsc::Receiver<()>,
    gates: Vec<Gate>,
    /// Every alert a device would have been sent: its endpoint and the alert.
    pushed: Pushed,
    /// The app's link to this machine, which an alert carries; none until a test sets one.
    app_url: Arc<Mutex<Option<String>>>,
}

impl Daemon {
    /// A daemon with no authentication whose turns are answered "hello there".
    fn start() -> Self {
        Self::answering(replies(&["hello there"]))
    }

    fn answering(turns: Vec<FakeTurn>) -> Self {
        Self::with(turns, |_| {})
    }

    fn with(turns: Vec<FakeTurn>, configure: impl FnOnce(&mut ServerOptions)) -> Self {
        let root = std::env::temp_dir().join(format!("ghostd-server-test-{}", crate::random::uuid()));
        let ghost_dir = root.join("casper");
        let owner_home = root.join(".owner");
        std::fs::create_dir_all(&ghost_dir).unwrap();
        std::fs::create_dir_all(&owner_home).unwrap();
        std::fs::write(ghost_dir.join("character.md"), "# casper\n\nYou are casper, a letterpress printer.\n").unwrap();
        let scratch = |name: &str| root.join(name).to_string_lossy().into_owned();
        let env = Env::from([
            ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
            ("HOME".to_string(), scratch(".owner")),
            ("XDG_DATA_HOME".to_string(), scratch(".data")),
            ("XDG_CACHE_HOME".to_string(), scratch(".cache")),
            ("XDG_STATE_HOME".to_string(), scratch(".state")),
            ("XDG_CONFIG_HOME".to_string(), scratch(".config")),
        ]);
        let ghost = Home { dir: ghost_dir.clone() };
        let pushed: Pushed = Arc::default();
        let app_url: Arc<Mutex<Option<String>>> = Arc::default();
        let hooks_path = root.join(".hooks.json");
        let hooks = Arc::new(HookRunner::from_config(&hooks_path, Logger::silent(), env.clone()).unwrap());
        let gates = turns.iter().filter_map(|turn| turn.gate.clone()).collect();
        let fake = Fake::new(turns);
        let host = ConversationHost::new(ConversationHostOptions {
            ghost: ghost.clone(),
            owner_home: owner_home.clone(),
            logger: Logger::silent(),
            hooks: hooks.clone(),
            app_url: Some(Box::new({
                let app_url = app_url.clone();
                move || app_url.lock().unwrap().clone()
            })),
            local_model: None,
            answerer: Some(fake.clone()),
            coding_agent: Some(Box::new(|| None)),
            env: env.clone(),
            // No test reaches a push service: what would be sent is recorded.
            push: crate::push::Push::with_sender(
                root.join(".state").join("ghost").join("push.json"),
                Logger::silent(),
                Box::new({
                    let pushed = pushed.clone();
                    move |subscription, payload| {
                        pushed.lock().unwrap().push((subscription.endpoint.clone(), payload.clone()));
                        if subscription.endpoint.ends_with("/gone") { crate::push::Sent::Gone } else { crate::push::Sent::Delivered }
                    }
                }),
            ),
        });
        let (sender, updates) = mpsc::channel();
        let sender = Mutex::new(sender);
        host.subscribe(
            move |_| {
                let _ = sender.lock().unwrap().send(());
            },
            || {},
        );
        // No authentication, no remote callers, any free port, and no real `tailscale`, unless the test says otherwise.
        let mut options = ServerOptions {
            ghost,
            host: host.clone(),
            running_source: RunningSource {
                version: "0.0.0-test".to_string(),
                commit: None,
                root: None,
                entry: std::env::current_exe().unwrap_or_default(),
                started_at: crate::clock::now_ms(),
            },
            hooks,
            logger: Logger::silent(),
            api_token: ApiToken::Off,
            remote: None,
            remote_apps: Vec::new(),
            remote_serve: serve_over(fake_tailscale().1),
            port: 0,
            env: env.clone(),
            home: owner_home,
        };
        configure(&mut options);
        let listening = start_daemon_server(options).unwrap();
        let conversation_dir = ghost_dir.join("conversation");
        Self { root, ghost_dir, conversation_dir, hooks_path, env, fake, host, listening, updates, gates, pushed, app_url }
    }

    /// Whether `DELETE /api/conversation` can work here; it moves the conversation to the scratch Trash with `gio`.
    fn can_trash(&self) -> bool {
        let installed = crate::env::which("gio", &self.env).is_some();
        if !installed {
            eprintln!("skipped: gio is not installed");
        }
        installed
    }

    /// Send a request and read the response head; the body is the caller's to read.
    fn open(&self, method: &str, target: &str, headers: &[(&str, &str)], body: Option<&[u8]>) -> ClientResponse {
        let address = SocketAddr::from(([127, 0, 0, 1], self.listening.address.port()));
        send(ClientRequest { address: address.into(), method, target, headers, body, timeout: Some(WAIT), abort: None }).expect("the daemon answers")
    }

    fn call(&self, method: &str, target: &str, headers: &[(&str, &str)], body: Option<&[u8]>) -> Reply {
        finish(self.open(method, target, headers, body))
    }

    fn get(&self, target: &str) -> Reply {
        self.call("GET", target, &[], None)
    }

    fn get_as(&self, target: &str, headers: &[(&str, &str)]) -> Reply {
        self.call("GET", target, headers, None)
    }

    fn delete(&self, target: &str) -> Reply {
        self.call("DELETE", target, &[], None)
    }

    /// A JSON body under `application/json`.
    fn send_json(&self, method: &str, target: &str, body: &Value) -> Reply {
        self.call(method, target, &[JSON], Some(body.to_string().as_bytes()))
    }

    fn put(&self, target: &str, body: &Value) -> Reply {
        self.send_json("PUT", target, body)
    }

    fn post(&self, target: &str, body: &Value) -> Reply {
        self.send_json("POST", target, body)
    }

    /// Start a turn and return once its response has begun.
    fn open_turn(&self, body: &Value) -> ClientResponse {
        self.open("POST", "/api/messages", &[JSON, ("accept", "text/event-stream")], Some(body.to_string().as_bytes()))
    }

    /// Run a turn to the end of its response.
    fn post_turn(&self, body: &Value) -> Reply {
        finish(self.open_turn(body))
    }

    /// `GET /api/conversation`.
    fn conversation(&self) -> Value {
        let response = self.get("/api/conversation");
        assert_eq!(response.status, 200);
        response.json()
    }

    fn streaming(&self) -> bool {
        self.host.queued_messages()["streaming"] == true
    }

    /// Wait until the running turn has given the conversation back, a moment
    /// after its terminal. The host announces the conversation when it has,
    /// so each announcement is a reason to look again.
    fn wait_settled(&self) {
        while self.host.conversation().unwrap()["running"] == true {
            self.updates.recv_timeout(WAIT).expect("the turn settles");
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        for gate in &self.gates {
            gate.release();
        }
        // A turn outlives its response, and writes its log as it ends: stop one
        // still running and wait for it to give the conversation back, which
        // the host announces, before the scratch directory goes.
        while self.host.stop_turn().is_ok() && self.updates.recv_timeout(WAIT).is_ok() {}
        self.host.shut_down();
        self.listening.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `GET /api/conversation` while nothing has been said.
fn nothing_said() -> Value {
    json!({ "preview": null, "updatedAt": null, "messageCount": 0, "unread": false, "running": false, "question": null })
}

// ── GET /api/ghost, hooks, character ────────────────────────────────────

#[test]
fn names_the_machines_one_ghost() {
    let daemon = Daemon::start();
    let response = daemon.get("/api/ghost");
    assert_eq!(response.status, 200);
    // With where its topic documents are, the owner's to read, edit and delete, and how many there are.
    let topics = daemon.ghost_dir.join("topics");
    assert_eq!(response.json(), json!({ "name": "casper", "topics": { "path": topics.to_string_lossy(), "count": 0 } }));
    std::fs::create_dir_all(&topics).unwrap();
    std::fs::write(topics.join("boat-trip.md"), "The Heron leaves at nine.\n").unwrap();
    assert_eq!(daemon.get("/api/ghost").json()["topics"]["count"], 1);
    assert_eq!(response.header("content-type"), Some("application/json; charset=utf-8"));
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(response.header("connection"), Some("close"));
    assert_eq!(response.header("content-length"), Some(response.body.len().to_string().as_str()));
}

#[test]
fn hooks_config_reads_and_replaces_the_whole_document_through_the_runner() {
    let daemon = Daemon::start();
    let path = daemon.hooks_path.to_string_lossy().into_owned();
    let route = "/api/hooks/config";

    // A missing file is the empty document.
    assert_eq!(daemon.get(route).json(), json!({ "path": path, "document": {} }));

    let next = json!({ "hooks": { "session_stop": [{ "hooks": [{ "type": "command", "command": "/bin/true" }] }] } });
    let written = daemon.put(route, &next);
    assert_eq!(written.status, 200);
    assert_eq!(written.json(), json!({ "path": path, "document": next }));
    assert_eq!(read_json(&daemon.hooks_path), next);

    // The runner's own admission, so the route's 400s are the loader's messages.
    let rejected = daemon.call("PUT", route, &[JSON], Some(b"[]"));
    assert_eq!(rejected.status, 400);
    assert_eq!(rejected.json(), json!({ "error": { "message": format!("{path} must contain a JSON object."), "code": "invalid_request" } }));

    let wrapped = daemon.put(route, &json!({ "path": path, "document": next, "hooks": {} }));
    assert_eq!(wrapped.status, 400);
    assert_eq!(wrapped.json()["error"]["message"], json!(format!("{path} has no top-level \"path\", \"document\"; send the document itself.")));
    assert_eq!(daemon.get(route).json(), json!({ "path": path, "document": next }));
    assert_eq!(read_json(&daemon.hooks_path), next);

    assert_eq!(daemon.call("POST", route, &[], None).status, 405);
}

#[test]
fn character_round_trips_the_persona_file_and_refuses_an_oversize_write() {
    let daemon = Daemon::start();
    let file = daemon.ghost_dir.join("character.md");
    let route = "/api/character";

    let written = daemon.put(route, &json!({ "body": "# Casper\n\nDry wit, direct answers.\n" }));
    assert_eq!(written.status, 200);
    assert_eq!(written.json(), json!({ "ok": true, "limit": 20_000 }));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Casper\n\nDry wit, direct answers.\n");

    let read = daemon.get(route);
    assert_eq!(read.status, 200);
    assert_eq!(read.json(), json!({ "body": "# Casper\n\nDry wit, direct answers.\n", "limit": 20_000 }));

    let oversize = daemon.put(route, &json!({ "body": "x".repeat(20_001) }));
    assert_eq!(oversize.status, 400);
    assert_eq!(oversize.code(), "limit_exceeded");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Casper\n\nDry wit, direct answers.\n");

    assert_eq!(daemon.put(route, &json!({ "body": 42 })).status, 400);
    assert_eq!(daemon.post(route, &json!({})).status, 405);
}

#[test]
fn character_still_serves_an_oversize_hand_edited_file_so_the_owner_can_shorten_it() {
    let daemon = Daemon::start();
    std::fs::write(daemon.ghost_dir.join("character.md"), "y".repeat(20_400)).unwrap();
    let read = daemon.get("/api/character");
    assert_eq!(read.status, 200);
    let body = read.json();
    assert_eq!(body["body"].as_str().map(str::len), Some(20_400));
    assert_eq!(body["limit"], 20_000);
}

// ── POST /api/messages ──────────────────────────────────────────────────

#[test]
fn refuses_a_second_turn_while_one_is_answering_before_the_stream_and_admits_it_after() {
    let (turns, gate) = held(&["after"]);
    let daemon = Daemon::answering(turns);
    let first = daemon.open_turn(&turn_body("hold this turn"));
    daemon.fake.wait_for_calls(1);

    let rejected = daemon.post_turn(&turn_body("must fail before SSE"));
    assert_eq!(rejected.status, 409);
    assert_eq!(rejected.header("content-type"), Some("application/json; charset=utf-8"));
    assert_eq!(rejected.code(), "conversation_busy");

    gate.release();
    assert_eq!(finish(first).events().last(), Some(&json!({ "type": "done" })));
    // The response ended, so the conversation is free: a client that read to the end is never told it is busy.
    let retried = daemon.post_turn(&turn_body("after release"));
    assert_eq!(retried.status, 200);
    assert_eq!(terminals(&retried.events()), [&json!({ "type": "done" })]);
    assert_eq!(daemon.fake.prompts(), ["hold this turn", "after release"]);
}

#[test]
fn streams_one_well_formed_turn() {
    let daemon = Daemon::answering(vec![FakeTurn {
        events: vec![
            PassEvent::ToolStart { id: "t1".to_string(), name: "Read".to_string(), args: json!({ "path": "character.md" }) },
            PassEvent::ToolEnd { id: "t1".to_string(), is_error: false, output: "# casper".to_string() },
            said("a", "I set type for a living."),
        ],
        ..FakeTurn::default()
    }]);
    let response = daemon.post_turn(&first_turn());

    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some("text/event-stream; charset=utf-8"));
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(response.header("x-accel-buffering"), Some("no"));
    // The stream is delimited by the connection closing.
    assert_eq!(response.header("connection"), Some("close"));
    assert_eq!((response.header("content-length"), response.header("transfer-encoding")), (None, None));
    // The opening comment makes the accepted stream visible before the model's
    // work; event frames keep the canonical `data: <json>\n\n` shape.
    assert!(response.text().starts_with(": keepalive\n\ndata: "), "{}", response.text());

    let events = response.events();
    assert_eq!(types(&events), ["start", "pass", "tool_execution_start", "tool_execution_end", "text_start", "text_delta", "text_end", "done"]);
    assert_eq!(deltas(&events).concat(), "I set type for a living.");
}

/// A megabyte the stream carries and the log does not: a notice, as "Loading the local model…" is.
fn megabyte_notice() -> PassEvent {
    PassEvent::Thinking { block: "load".to_string(), delta: "x".repeat(1_048_576) }
}

#[test]
fn a_turn_outlives_the_client_that_started_it() {
    let (turns, gate) = held(&[]);
    let daemon = Daemon::answering(turns);
    let response = daemon.open_turn(&turn_body("carry on without me"));
    daemon.fake.wait_for_calls(1);
    // The client goes away mid-turn: its socket closes with the turn still answering.
    drop(response);
    assert_eq!(daemon.conversation()["running"], true);
    gate.release();
    daemon.wait_settled();
    // The turn ran to its end, and is in the log for whoever reads next.
    let transcript = daemon.get("/api/conversation/transcript").json();
    assert_eq!(transcript["total"], 2);
    assert_eq!(transcript["messages"][1]["content"], json!([{ "type": "text", "text": "held" }]));
    assert_eq!(transcript["messages"][1].get("errorMessage"), None);
    assert_eq!(daemon.get("/api/conversation/queue").json(), json!({ "streaming": false, "followUp": [] }));
}

#[test]
fn a_reader_that_falls_too_far_behind_is_dropped_and_the_turn_carries_on() {
    // Far more than the loopback socket buffers and the response's backlog hold between them, to a client that reads none of it.
    let megabytes = 64;
    assert!(megabytes * 1_048_576 > 4 * MAX_TURN_BACKLOG_BYTES);
    let mut events: Vec<PassEvent> = (0..megabytes).map(|_| megabyte_notice()).collect();
    events.push(said("a", "All of it."));
    let daemon = Daemon::answering(vec![FakeTurn { events, ..FakeTurn::default() }]);
    let response = daemon.open_turn(&first_turn());
    // The turn never waited on that client.
    daemon.wait_settled();
    let transcript = daemon.get("/api/conversation/transcript").json();
    assert_eq!(transcript["messages"][1]["content"], json!([{ "type": "text", "text": "All of it." }]));
    // What the client then reads is whole events from the start, and stops short: no terminal, so it reads the transcript.
    let events = finish(response).events();
    assert_eq!(types(&events[..2]), ["start", "pass"]);
    assert!(events[2..].iter().all(|event| event["type"] == "thinking"), "{:?}", types(&events));
    assert!(events.len() < 2 + megabytes, "{} events", events.len());
}

#[test]
fn rejects_a_malformed_turn_body_with_a_client_error() {
    let daemon = Daemon::start();
    for body in [json!({ "prompt": "" }), json!({ "prompt": "  \n" }), json!({ "prompt": 7 }), json!({}), json!([]), json!("hello")] {
        let response = daemon.post("/api/messages", &body);
        assert_eq!(response.status, 400, "{body}");
        assert_eq!(response.code(), "invalid_request", "{body}");
    }
    let unparsable = daemon.call("POST", "/api/messages", &[JSON], Some(b"{"));
    assert_eq!(unparsable.json(), json!({ "error": { "message": "Request body must be JSON.", "code": "invalid_request" } }));
    let empty = daemon.call("POST", "/api/messages", &[JSON], None);
    assert_eq!(empty.json(), json!({ "error": { "message": "Request body is required.", "code": "invalid_request" } }));
    assert!(daemon.fake.calls().is_empty());
}

// ── The turn stream's lifecycle ─────────────────────────────────────────

#[test]
fn flushes_the_accepted_stream_before_a_silent_turn_says_anything() {
    let (turns, gate) = held(&[]);
    let daemon = Daemon::answering(turns);
    // The head arrives while the model is still silent.
    let response = daemon.open_turn(&turn_body("hello"));
    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some("text/event-stream; charset=utf-8"));
    // And so does the opening comment, and what the turn has said so far.
    let mut body = BufReader::new(response.body);
    let mut opening = String::new();
    body.read_line(&mut opening).unwrap();
    assert_eq!(opening, ": keepalive\n");
    let mut events = EventReader::new(body);
    let mut next = || events.next_event().unwrap().map(|data| serde_json::from_str::<Value>(&data).unwrap());
    assert_eq!(next(), Some(json!({ "type": "start" })));
    assert_eq!(next(), Some(json!({ "type": "pass" })));
    daemon.fake.wait_for_calls(1);
    assert!(daemon.streaming());

    gate.release();
    let mut rest = Vec::new();
    while let Some(event) = next() {
        rest.push(event);
    }
    assert_eq!(types(&rest), ["text_start", "text_delta", "text_end", "done"]);
}

#[test]
fn a_stopped_turn_ends_its_stream_aborted() {
    let (turns, _gate) = held(&[]);
    let daemon = Daemon::answering(turns);
    let response = daemon.open_turn(&turn_body("hold"));
    daemon.fake.wait_for_calls(1);
    let stopped = daemon.post("/api/conversation/stop", &json!({}));
    assert_eq!((stopped.status, stopped.json()), (200, json!({ "stopped": true })));
    let events = finish(response).events();
    assert_eq!(terminals(&events), [&json!({ "type": "error", "reason": "aborted", "errorMessage": "Turn aborted." })]);
    assert_eq!(events.last().unwrap()["reason"], "aborted");
}

// ── GET /api/events ─────────────────────────────────────────────────────

#[test]
fn conversation_events_announce_each_change() {
    let daemon = Daemon::answering(replies(&["hello"]));
    let response = daemon.open("GET", "/api/events", &[], None);
    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some("text/event-stream; charset=utf-8"));
    assert_eq!(response.header("cache-control"), Some("no-store"));
    // The opening comment is written once the subscription is listening.
    let mut body = BufReader::new(response.body);
    let mut opening = String::new();
    body.read_line(&mut opening).unwrap();
    assert_eq!(opening, ": keepalive\n");

    daemon.post_turn(&first_turn());
    let mut events = EventReader::new(body);
    let event: Value = serde_json::from_str(&events.next_event().unwrap().expect("an invalidation")).unwrap();
    assert_eq!(event["type"], "conversation-updated");
    assert!(crate::clock::parse_iso(event["updatedAt"].as_str().unwrap()).is_some(), "{event}");
    assert_eq!(event.as_object().map(Map::len), Some(2), "{event}");
    // The turn's end is another.
    let event: Value = serde_json::from_str(&events.next_event().unwrap().expect("a second invalidation")).unwrap();
    assert_eq!(event["type"], "conversation-updated");
}

#[test]
fn conversation_events_end_when_the_host_shuts_down() {
    let daemon = Daemon::start();
    let response = daemon.open("GET", "/api/events", &[], None);
    let mut body = BufReader::new(response.body);
    let mut opening = String::new();
    body.read_line(&mut opening).unwrap();
    daemon.host.shut_down();
    let mut rest = String::new();
    body.read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "\n");
}

// ── /api/conversation/queue ─────────────────────────────────────────────

#[test]
fn queues_a_follow_up_during_a_live_turn_and_runs_it_as_the_next_pass_of_the_same_stream() {
    let (turns, gate) = held(&["Kept it understated."]);
    let daemon = Daemon::answering(turns);
    let route = "/api/conversation/queue";
    let turn = daemon.open_turn(&turn_body("Set the type."));
    daemon.fake.wait_for_calls(1);

    let queued = daemon.post(route, &json!({ "text": "  Keep the result understated. " }));
    assert_eq!(queued.status, 200);
    let waiting = json!({ "streaming": true, "followUp": ["Keep the result understated."] });
    assert_eq!(queued.json(), waiting);
    assert_eq!(daemon.get(route).json(), waiting);

    for body in [json!({ "text": "   " }), json!({}), json!({ "text": 3 })] {
        let response = daemon.post(route, &body);
        assert_eq!(response.status, 400, "{body}");
        assert_eq!(response.json(), json!({ "error": { "message": "\"text\" must be a non-empty string.", "code": "invalid_request" } }));
    }

    gate.release();
    let events = finish(turn).events();
    let owner = events.iter().position(|event| event["type"] == "owner_message").expect("the follow-up starts its pass");
    assert_eq!(events[owner], json!({ "type": "owner_message", "text": "Keep the result understated." }));
    assert!(events[owner..].iter().any(|event| event["type"] == "text_delta"));
    assert!(events.contains(&json!({ "type": "queue", "followUp": ["Keep the result understated."] })));
    assert_eq!(terminals(&events).len(), 1);
    assert_eq!(daemon.fake.prompts(), ["Set the type.", "Keep the result understated."]);

    assert_eq!(daemon.get(route).json(), json!({ "streaming": false, "followUp": [] }));
    let too_late = daemon.post(route, &json!({ "text": "Too late" }));
    assert_eq!(too_late.status, 409);
    assert_eq!(too_late.code(), "conversation_not_streaming");
    assert_eq!(daemon.delete(route).status, 405);
}

// ── GET /api/conversation ───────────────────────────────────────────────

#[test]
fn the_conversation_has_nothing_before_anything_is_said_shows_a_running_turn_to_any_client_and_describes_itself_after() {
    let (turns, gate) = held(&[]);
    let daemon = Daemon::answering(turns);
    assert_eq!(daemon.conversation(), nothing_said());

    let turn = daemon.open_turn(&first_turn());
    daemon.fake.wait_for_calls(1);
    // A client that arrives mid-turn sees it running, with what is logged so far: the prompt.
    let mut running = daemon.conversation();
    assert!(running.as_object_mut().unwrap().remove("updatedAt").is_some_and(|at| at.is_string()));
    assert_eq!(running, json!({ "preview": "Who are you?", "messageCount": 1, "unread": true, "running": true, "question": null }));
    let transcript = daemon.get("/api/conversation/transcript").json();
    assert_eq!((&transcript["total"], &transcript["messages"][0]["content"]), (&json!(1), &json!([{ "type": "text", "text": "Who are you?" }])));
    assert_eq!(daemon.get("/api/conversation/queue").json(), json!({ "streaming": true, "followUp": [] }));
    gate.release();
    assert_eq!(finish(turn).events().last(), Some(&json!({ "type": "done" })));
    daemon.wait_settled();

    let mut row = daemon.conversation();
    let updated_at = row.as_object_mut().unwrap().remove("updatedAt").expect("an updatedAt");
    assert!(crate::clock::parse_iso(updated_at.as_str().unwrap()).is_some(), "{updated_at}");
    assert_eq!(row, json!({ "preview": "Who are you?", "messageCount": 2, "unread": true, "running": false, "question": null }));
}

// ── PUT /api/conversation/read ──────────────────────────────────────────

#[test]
fn marks_the_conversation_read_through_a_time_no_later_than_now_and_never_back() {
    let daemon = Daemon::answering(replies(&["one", "two"]));
    let route = "/api/conversation/read";
    let file = read_path(&daemon.conversation_dir);
    // Before anything is said there is nothing to have read.
    let early = daemon.put(route, &json!({}));
    assert_eq!((early.status, early.code().as_str()), (404, "not_found"));
    assert!(!file.exists());

    daemon.post_turn(&first_turn());
    daemon.wait_settled();
    assert_eq!(daemon.conversation()["unread"], true);
    // Only the form the transcript carries is a timestamp: a date alone or one with an offset is refused.
    let refused = ["soon", "2999-01-01T00:00:00.000Z", "2020-01-01", "2020-01-01T02:00:00+02:00"].map(|at| json!({ "readThrough": at }));
    for body in refused.into_iter().chain([json!({ "readThrough": 7 }), json!([])]) {
        let refused = daemon.put(route, &body);
        assert_eq!(refused.status, 400, "{body}");
        assert_eq!(refused.code(), "invalid_request", "{body}");
    }
    assert_eq!(daemon.conversation()["unread"], true);

    let read_through = daemon.get("/api/conversation/transcript").json()["readThrough"].clone();
    let read = daemon.put(route, &json!({ "readThrough": read_through }));
    assert_eq!((read.status, read.json()), (200, json!({ "ok": true, "readAt": read_through })));
    assert_eq!(read_json(&file), json!({ "readAt": read_through }));
    assert_eq!(daemon.conversation()["unread"], false);

    // An earlier time leaves the mark where it is.
    let earlier = daemon.put(route, &json!({ "readThrough": "2020-01-01T00:00:00.000Z" }));
    assert_eq!((earlier.status, earlier.json()), (200, json!({ "ok": true, "readAt": read_through })));
    assert_eq!(read_json(&file), json!({ "readAt": read_through }));
    assert_eq!(daemon.conversation()["unread"], false);

    // A reply later than the mark is unread again. Both are millisecond
    // timestamps, so the next turn starts in a later millisecond; the clock
    // is the only thing to wait on.
    let mark = crate::clock::parse_iso(read_through.as_str().unwrap()).unwrap();
    while crate::clock::now_ms() <= mark {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(daemon.post_turn(&turn_body("And then?")).status, 200);
    daemon.wait_settled();
    assert_eq!(daemon.conversation()["unread"], true);

    // With no `readThrough` the mark is now.
    let before = crate::clock::now_ms();
    let now = daemon.put(route, &json!({}));
    assert_eq!(now.status, 200);
    let body = now.json();
    let read_at = crate::clock::parse_iso(body["readAt"].as_str().unwrap()).expect("a timestamp");
    assert!((before..=crate::clock::now_ms()).contains(&read_at), "{body}");
    assert_eq!(body, json!({ "ok": true, "readAt": body["readAt"] }));
    assert_eq!(daemon.conversation()["unread"], false);
}

// ── DELETE /api/conversation ────────────────────────────────────────────

#[test]
fn starting_over_moves_the_conversation_to_recoverable_trash_and_the_next_message_starts_a_new_log() {
    let daemon = Daemon::answering(replies(&["one", "two"]));
    if !daemon.can_trash() {
        return;
    }
    let log = daemon.conversation_dir.join(LOG_FILENAME);
    // Before anything is said there is nothing to start over from.
    let nothing = daemon.delete("/api/conversation");
    assert_eq!((nothing.status, nothing.code().as_str()), (404, "not_found"));

    daemon.post_turn(&turn_body("the first conversation"));
    daemon.wait_settled();
    assert!(log.exists());

    let deleted = daemon.delete("/api/conversation");
    assert_eq!(deleted.status, 200);
    assert_eq!(deleted.json(), json!({ "ok": true }));
    // The whole conversation directory moves, its log with it, into the scratch Trash.
    assert!(!daemon.conversation_dir.exists());
    let trashed = daemon.root.join(".data/Trash/files/conversation").join(LOG_FILENAME);
    assert!(std::fs::read_to_string(&trashed).unwrap().contains("the first conversation"));
    assert_eq!(daemon.conversation(), nothing_said());
    let transcript = daemon.get("/api/conversation/transcript").json();
    assert_eq!((&transcript["messages"], &transcript["total"], &transcript["truncated"]), (&json!([]), &json!(0), &json!(false)));
    let again = daemon.delete("/api/conversation");
    assert_eq!((again.status, again.code().as_str()), (404, "not_found"));

    // The next message starts a new log, which holds nothing of the one in Trash.
    assert_eq!(daemon.post_turn(&turn_body("the second conversation")).status, 200);
    daemon.wait_settled();
    let started = std::fs::read_to_string(&log).unwrap();
    let header: Value = serde_json::from_str(started.lines().next().expect("a header")).unwrap();
    assert_eq!(header["type"], "conversation");
    assert!(!started.contains("the first conversation"));
    let transcript = daemon.get("/api/conversation/transcript").json();
    assert_eq!(transcript["total"], 2);
    assert_eq!(transcript["messages"][0]["content"], json!([{ "type": "text", "text": "the second conversation" }]));
    assert_eq!(daemon.conversation()["preview"], "the second conversation");
}

// ── GET /api/conversation/transcript ────────────────────────────────────

#[test]
fn returns_the_conversations_renderable_messages() {
    let daemon = Daemon::answering(replies(&["I set type for a living."]));
    daemon.post_turn(&first_turn());
    let response = daemon.get("/api/conversation/transcript");
    assert_eq!(response.status, 200);
    let transcript = response.json();
    let mut keys: Vec<&str> = transcript.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["messages", "readThrough", "total", "truncated"]);
    assert_eq!((&transcript["total"], &transcript["truncated"]), (&json!(2), &json!(false)));
    let messages: Vec<(&Value, &Value)> =
        transcript["messages"].as_array().unwrap().iter().map(|message| (&message["role"], &message["content"])).collect();
    assert_eq!(
        messages,
        [
            (&json!("user"), &json!([{ "type": "text", "text": "Who are you?" }])),
            (&json!("assistant"), &json!([{ "type": "text", "text": "I set type for a living." }])),
        ]
    );
}

#[test]
fn pages_with_limit_and_offset_and_rejects_what_is_not_a_count() {
    let daemon = Daemon::answering(replies(&["one", "two"]));
    daemon.post_turn(&turn_body("first"));
    daemon.wait_settled();
    daemon.post_turn(&turn_body("second"));
    let page = daemon.get("/api/conversation/transcript?limit=1&offset=2").json();
    assert_eq!((&page["total"], &page["truncated"]), (&json!(4), &json!(true)));
    let messages = page["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!((&messages[0]["role"], &messages[0]["content"]), (&json!("user"), &json!([{ "type": "text", "text": "second" }])));
    // A limit of none is one message, and an offset past the end is an empty page.
    let page = daemon.get("/api/conversation/transcript?limit=0&offset=%203").json();
    assert_eq!((page["messages"].as_array().unwrap().len(), &page["total"], &page["truncated"]), (1, &json!(4), &json!(true)));
    let page = daemon.get("/api/conversation/transcript?offset=4").json();
    assert_eq!((&page["messages"], &page["total"], &page["truncated"]), (&json!([]), &json!(4), &json!(true)));
    for (query, key) in [
        ("limit=many", "limit"),
        ("offset=later", "offset"),
        ("limit=Infinity", "limit"),
        ("offset=NaN", "offset"),
        ("limit=1.5", "limit"),
        ("offset=-1", "offset"),
        ("limit=", "limit"),
        ("offset=99999999999999999999999", "offset"),
    ] {
        let response = daemon.get(&format!("/api/conversation/transcript?{query}"));
        assert_eq!(response.status, 400, "{query}");
        let refusal = json!({ "error": { "message": format!("\"{key}\" must be a whole number, zero or more."), "code": "invalid_request" } });
        assert_eq!(response.json(), refusal, "{query}");
    }
}

#[test]
fn reads_the_conversation_with_no_log_yet_as_empty() {
    let daemon = Daemon::start();
    let before = crate::clock::now_ms();
    let response = daemon.get("/api/conversation/transcript");
    assert_eq!(response.status, 200);
    let mut transcript = response.json();
    let read_through = transcript.as_object_mut().unwrap().remove("readThrough").expect("a readThrough");
    let read_through = crate::clock::parse_iso(read_through.as_str().unwrap()).expect("a timestamp");
    assert!((before..=crate::clock::now_ms()).contains(&read_through));
    assert_eq!(transcript, json!({ "messages": [], "total": 0, "truncated": false }));
}

// ── Routing and transport ───────────────────────────────────────────────

#[test]
fn binds_a_free_loopback_port() {
    let daemon = Daemon::start();
    assert!(daemon.listening.address.port() > 0);
    assert_ne!(daemon.listening.address.port(), crate::config::DEFAULT_PORT);
    assert_eq!(daemon.get("/api/ghost").status, 200);
}

const METHODS: [&str; 4] = ["GET", "POST", "PUT", "DELETE"];

/// The route table of CONTRACTS.md "Daemon HTTP API": every path the daemon
/// answers, and the methods it answers there.
const ROUTE_TABLE: &[(&str, &[&str])] = &[
    ("/api/remote/whoami", &["GET"]),
    ("/api/remote/machines", &["GET"]),
    ("/api/remote", &["GET"]),
    ("/api/hooks/config", &["GET", "PUT"]),
    ("/api/status", &["GET"]),
    ("/api/push/subscription", &["PUT", "DELETE"]),
    ("/api/push/test", &["POST"]),
    ("/api/ghost", &["GET"]),
    ("/api/character", &["GET", "PUT"]),
    ("/api/complete", &["POST"]),
    ("/api/messages", &["POST"]),
    ("/api/events", &["GET"]),
    ("/api/conversation", &["GET", "DELETE"]),
    ("/api/conversation/read", &["PUT"]),
    ("/api/conversation/attachments", &["POST"]),
    ("/api/conversation/attachments/:file", &["GET"]),
    ("/api/conversation/transcript", &["GET"]),
    ("/api/conversation/stop", &["POST"]),
    ("/api/conversation/queue", &["GET", "POST"]),
];

fn plain_404() -> Value {
    json!({ "error": { "message": "Not found.", "code": "not_found" } })
}

#[test]
fn it_404s_anything_outside_the_contract_and_405s_the_wrong_method() {
    let daemon = Daemon::start();
    for path in ["/nothing", "/api/other", "/api/nothing", "/", "//", "/api", "/api/conversation/transcript/more"] {
        let response = daemon.get(path);
        assert_eq!(response.status, 404, "{path}");
        assert_eq!(response.json(), plain_404(), "{path}");
    }
    let posted = daemon.call("POST", "/api/conversation", &[], None);
    assert_eq!(posted.status, 405);
    assert_eq!(posted.json(), json!({ "error": { "message": "POST is not allowed here.", "code": "method_not_allowed" } }));
    assert_eq!(daemon.get("/api/messages").status, 405);
    // A trailing slash and a query name the same route.
    assert_eq!(daemon.get("/api/ghost/?x=1").json()["name"], "casper");
}

#[test]
fn answers_exactly_the_contracts_route_table_and_405s_every_other_method_on_it() {
    // The table the server routes by is this one, route for route.
    let contract: std::collections::BTreeSet<(String, &str)> =
        ROUTE_TABLE.iter().flat_map(|(path, methods)| methods.iter().map(move |method| (path.to_string(), *method))).collect();
    let served: std::collections::BTreeSet<(String, &str)> =
        ROUTES.iter().flat_map(|(methods, pattern, _)| methods.split(' ').map(move |method| (format!("/{pattern}"), method))).collect();
    assert_eq!(served, contract);

    let daemon = Daemon::start();
    for (path, allowed) in ROUTE_TABLE {
        let target = path.replace(":file", "x.png");
        for method in METHODS {
            let response = daemon.open(method, &target, &[JSON], (method != "GET").then_some(b"{}"));
            let status = response.status;
            if allowed.contains(&method) {
                // Reached its handler, whatever that makes of an empty request:
                // the router's two refusals are not among its answers. An event
                // stream that opened is left unread.
                assert_ne!(status, 405, "{method} {target}");
                if status == 404 {
                    assert_ne!(finish(response).json(), plain_404(), "{method} {target}");
                }
            } else {
                assert_eq!(status, 405, "{method} {target}");
                let refusal = json!({ "error": { "message": format!("{method} is not allowed here."), "code": "method_not_allowed" } });
                assert_eq!(finish(response).json(), refusal, "{method} {target}");
            }
        }
    }
    // Nothing above was a message, so nothing was said.
    assert!(daemon.fake.calls().is_empty());
    assert_eq!(daemon.conversation(), nothing_said());
}

#[test]
fn returns_a_typed_400_for_malformed_percent_encoding_in_dynamic_path_segments() {
    let daemon = Daemon::start();
    for path in ["/api/conversation/attachments/%", "/api/conversation/attachments/%zz", "/api/conversation/attachments/%ff"] {
        let response = daemon.get(path);
        assert_eq!(response.status, 400, "{path}");
        assert_eq!(
            response.json(),
            json!({ "error": { "message": "URL path segments must use valid percent-encoding.", "code": "invalid_request" } }),
            "{path}"
        );
    }
}

#[test]
fn decodes_a_percent_encoded_attachment_name() {
    let daemon = Daemon::start();
    let saved = daemon.call("POST", "/api/conversation/attachments", &[("content-type", "image/png")], Some(PNG));
    let path = saved.json()["path"].as_str().unwrap().to_string();
    let encoded = path.replace('-', "%2D");
    assert_ne!(encoded, path);
    let served = daemon.get(&format!("/api/conversation/{encoded}"));
    assert_eq!((served.status, served.body.as_slice()), (200, PNG));
}

#[test]
fn offers_cors_to_no_origin_that_is_not_an_app() {
    let daemon = Daemon::start();
    for origin in ["http://localhost:5173", "https://evil.example"] {
        let response = daemon.get_as("/api/ghost", &[("origin", origin)]);
        assert_eq!(response.header("access-control-allow-origin"), None, "{origin}");
        assert_eq!(response.header("vary"), None, "{origin}");
        let preflight = daemon.call("OPTIONS", "/api/messages", &[("origin", origin), ("access-control-request-method", "POST")], None);
        assert_eq!((preflight.status, preflight.header("access-control-allow-origin")), (204, None), "{origin}");
        assert!(preflight.body.is_empty());
    }
}

#[test]
fn refuses_a_body_over_a_megabyte() {
    let daemon = Daemon::start();
    // Refused by the length it declares, before any of it is read.
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", daemon.listening.address.port())).unwrap();
    let head = format!("PUT /api/character HTTP/1.1\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n", MAX_BODY_BYTES + 1);
    std::io::Write::write_all(&mut stream, head.as_bytes()).unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    assert!(answer.starts_with("HTTP/1.1 413 Payload Too Large\r\n"), "{answer}");
    let body: Value = serde_json::from_str(answer.split_once("\r\n\r\n").expect("a head and a body").1).unwrap();
    assert_eq!(body, json!({ "error": { "message": "Request body is too large.", "code": "payload_too_large" } }));
    // At the bound it is read, and refused for what it says: no character is that long.
    let padding = MAX_BODY_BYTES - json!({ "body": "" }).to_string().len();
    let read = daemon.put("/api/character", &json!({ "body": "x".repeat(padding) }));
    assert_eq!((read.status, read.code().as_str()), (400, "limit_exceeded"));
}

#[test]
fn reports_the_running_source() {
    let daemon = Daemon::start();
    let status = daemon.get("/api/status");
    assert_eq!(status.status, 200);
    let mut body = status.json();
    let started = body.as_object_mut().unwrap().remove("startedAt").expect("a startedAt");
    assert!(crate::clock::parse_iso(started.as_str().unwrap()).is_some());
    assert_eq!(body, json!({ "version": "0.0.0-test", "source": { "commit": null, "root": null }, "restartNeeded": false }));
}

#[test]
fn completes_a_prompt_for_a_hook() {
    let daemon = Daemon::answering(replies(&["  a completion\n"]));
    let done = daemon.post("/api/complete", &json!({ "prompt": "Summarise." }));
    assert_eq!((done.status, done.json()), (200, json!({ "text": "a completion" })));
    assert_eq!(daemon.fake.calls()[0].prompt, "Summarise.");
    for body in [json!({}), json!({ "prompt": 1 }), json!({ "prompt": "  " })] {
        let refused = daemon.post("/api/complete", &body);
        assert_eq!((refused.status, refused.code().as_str()), (400, "invalid_request"), "{body}");
    }
}

#[test]
fn a_completion_stops_when_its_caller_goes_away() {
    let (turns, _gate) = held(&[]);
    let daemon = Daemon::answering(turns);
    let address = SocketAddr::from(([127, 0, 0, 1], daemon.listening.address.port()));
    let body = json!({ "prompt": "Summarise." }).to_string();
    let leaving = Abort::new();
    std::thread::scope(|scope| {
        let request = scope.spawn(|| {
            let request = ClientRequest {
                address: address.into(),
                method: "POST",
                target: "/api/complete",
                headers: &[JSON],
                body: Some(body.as_bytes()),
                timeout: Some(WAIT),
                abort: Some(&leaving),
            };
            send(request).map(|response| response.status)
        });
        daemon.fake.wait_for_calls(1);
        leaving.abort();
        assert!(request.join().unwrap().is_err());
    });
    daemon.fake.wait_for_a_stop();
}

#[test]
fn an_unexpected_failure_is_a_500_that_says_nothing_of_its_cause_and_is_logged() {
    let (logger, records) = Logger::recording();
    let daemon = Daemon::with(replies(&["hello there"]), |options| options.logger = logger);
    // A character "file" that cannot be read as one.
    std::fs::remove_file(daemon.ghost_dir.join("character.md")).unwrap();
    std::fs::create_dir(daemon.ghost_dir.join("character.md")).unwrap();
    let response = daemon.get("/api/character");
    assert_eq!(response.status, 500);
    assert_eq!(response.json(), json!({ "error": { "message": "The daemon failed to handle the request.", "code": "internal_error" } }));
    let records = records.lock().unwrap();
    let failure = records.iter().find(|record| record.message == "request failed").expect("a logged failure");
    assert_eq!(failure.fields["path"], "/api/character");
    assert!(failure.fields["error"].is_string());
    // And the daemon goes on answering.
    assert_eq!(daemon.get("/api/ghost").status, 200);
}

// ── Attachments ─────────────────────────────────────────────────────────

#[test]
fn stores_an_image_in_the_conversation_directory_before_its_first_turn_and_serves_it_back() {
    let daemon = Daemon::start();
    let route = "/api/conversation/attachments";
    let saved = daemon.call("POST", route, &[("content-type", "image/png")], Some(PNG));
    assert_eq!(saved.status, 201);
    let body = saved.json();
    let path = body["path"].as_str().unwrap();
    let name = path.strip_prefix("attachments/").expect("a path under attachments/");
    let (stem, extension) = name.rsplit_once('.').unwrap();
    let (time, random) = stem.rsplit_once('-').unwrap();
    assert_eq!(extension, "png");
    assert!(!time.is_empty() && time.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase()), "{name}");
    assert!(random.len() == 8 && random.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{name}");
    assert_eq!(std::fs::read(daemon.conversation_dir.join(path)).unwrap(), PNG);
    // A directory holding only attachments is not a conversation yet: nothing is said in it, and there is nothing to start over from.
    assert_eq!(daemon.conversation(), nothing_said());
    assert_eq!(daemon.delete("/api/conversation").status, 404);

    let served = daemon.get(&format!("{route}/{name}"));
    assert_eq!(served.status, 200);
    assert_eq!(served.header("content-type"), Some("image/png"));
    assert_eq!(served.header("cache-control"), Some("private, max-age=31536000, immutable"));
    assert_eq!(served.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(served.header("content-length"), Some("16"));
    assert_eq!(served.body, PNG);
}

#[test]
fn refuses_what_is_not_an_image_and_serves_only_a_stored_one() {
    let daemon = Daemon::start();
    let route = "/api/conversation/attachments";
    let text = daemon.call("POST", route, &[("content-type", "image/png")], Some(b"not an image"));
    assert_eq!((text.status, text.code().as_str()), (415, "unsupported_media_type"));
    assert_eq!(daemon.call("POST", route, &[("content-type", "image/png")], None).status, 400);
    for name in ["..%2F.conversation.jsonl", "x.png", "abc-0000000g.png"] {
        let response = daemon.get(&format!("{route}/{name}"));
        assert_eq!((response.status, response.code().as_str()), (404, "not_found"), "{name}");
    }
}

// ── The bearer token ────────────────────────────────────────────────────

fn token() -> String {
    "a".repeat(64)
}

fn other_token() -> String {
    "b".repeat(64)
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// A daemon that requires the bearer token.
fn guarded() -> Daemon {
    Daemon::with(replies(&["hello there"]), |options| options.api_token = ApiToken::Fixed(token()))
}

#[test]
fn refuses_a_request_that_presents_no_token() {
    let daemon = guarded();
    let response = daemon.get("/api/ghost");
    assert_eq!(response.status, 401);
    // Without this a client cannot tell "wrong token" from "wrong route".
    assert_eq!(response.header("www-authenticate"), Some("Bearer"));
    assert_eq!(response.header("content-type"), Some("application/json; charset=utf-8"));
    assert_eq!(response.code(), "unauthorized");
    assert!(response.json()["error"]["message"].as_str().unwrap().contains("ghostd api-token"));
}

#[test]
fn refuses_a_request_that_presents_the_wrong_token() {
    let daemon = guarded();
    for wrong in [
        bearer(&other_token()),
        bearer(&token()[..63]),
        format!("{}a", bearer(&token())),
        format!("Basic {}", token()),
        token(),
        "Bearer".to_string(),
    ] {
        let response = daemon.get_as("/api/ghost", &[("authorization", &wrong)]);
        assert_eq!((response.status, response.header("www-authenticate")), (401, Some("Bearer")), "{wrong}");
    }
}

#[test]
fn refuses_a_token_smuggled_somewhere_other_than_the_authorization_header() {
    let daemon = guarded();
    // A query parameter would land in logs and in `Referer`; only the header counts.
    assert_eq!(daemon.get(&format!("/api/ghost?token={}", token())).status, 401);
    assert_eq!(daemon.get_as("/api/ghost", &[("x-ghost-api-token", &token())]).status, 401);
}

#[test]
fn lets_the_real_token_through() {
    // With no Origin: that is what a client that read the token file sends.
    let daemon = guarded();
    let response = daemon.get_as("/api/ghost", &[("authorization", &bearer(&token()))]);
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["name"], "casper");
    assert_eq!(response.header("www-authenticate"), None);
}

#[test]
fn accepts_the_scheme_case_insensitively_as_rfc_7235_requires() {
    let daemon = guarded();
    for scheme in ["bearer", "BEARER", "  Bearer  "] {
        assert_eq!(daemon.get_as("/api/ghost", &[("authorization", &format!("{scheme} {} ", token()))]).status, 200, "{scheme}");
    }
}

#[test]
fn guards_every_route_not_just_the_mutating_ones() {
    let daemon = guarded();
    for path in ["/api/ghost", "/api/conversation", "/api/hooks/config", "/api/nonsense", "/api", "/api/events", "/api/status"] {
        assert_eq!(daemon.get(path).status, 401, "{path}");
    }
    let turn = daemon.post("/api/messages", &first_turn());
    assert_eq!((turn.status, turn.code().as_str()), (401, "unauthorized"));
    assert!(daemon.fake.calls().is_empty());
}

#[test]
fn the_machine_local_token_is_minted_into_the_state_directory_and_required() {
    let daemon = Daemon::with(replies(&["hello there"]), |options| options.api_token = ApiToken::File);
    let path = crate::token::api_token_path(&daemon.env, &daemon.root.join(".owner"));
    assert!(path.starts_with(daemon.root.join(".state")), "{}", path.display());
    let minted = crate::token::read_api_token(&path).unwrap().expect("a minted token");
    assert_eq!(daemon.get("/api/ghost").status, 401);
    assert_eq!(daemon.get_as("/api/ghost", &[("authorization", &bearer(&minted))]).status, 200);
}

#[test]
fn refuses_a_foreign_origin_even_when_the_token_is_right() {
    let daemon = guarded();
    let response = daemon.get_as("/api/ghost", &[("authorization", &bearer(&token())), ("origin", "https://evil.example")]);
    assert_eq!(response.status, 403);
    assert_eq!(response.code(), "forbidden_origin");
    assert_eq!(response.header("access-control-allow-origin"), None);
}

#[test]
fn refuses_a_foreign_origin_before_it_even_looks_at_the_token() {
    let daemon = guarded();
    let response = daemon.get_as("/api/ghost", &[("origin", "https://evil.example")]);
    assert_eq!((response.status, response.header("www-authenticate")), (403, None));
}

#[test]
fn refuses_the_text_plain_post_that_is_the_whole_csrf_vector() {
    let daemon = guarded();
    // Even holding the token, this shape must not be reachable: it is the one
    // a cross-site form post can produce without a preflight.
    let body = json!({ "prompt": "hello" }).to_string();
    let headers = [("authorization", bearer(&token())), ("content-type", "text/plain;charset=UTF-8".to_string())];
    let headers: Vec<(&str, &str)> = headers.iter().map(|(name, value)| (*name, value.as_str())).collect();
    let response = daemon.call("POST", "/api/messages", &headers, Some(body.as_bytes()));
    assert_eq!(response.status, 415);
    assert_eq!(response.code(), "unsupported_media_type");
    assert!(daemon.fake.calls().is_empty());
}

#[test]
fn refuses_the_other_simple_request_types_and_a_post_with_no_content_type() {
    let daemon = guarded();
    let authorization = bearer(&token());
    for kind in ["application/x-www-form-urlencoded", "multipart/form-data", "", "text/json", "application/jsonx"] {
        let response = daemon.call("POST", "/api/messages", &[("authorization", &authorization), ("content-type", kind)], Some(b"prompt=hello"));
        assert_eq!(response.status, 415, "{kind}");
    }
    let bare = daemon.call("POST", "/api/messages", &[("authorization", &authorization)], Some(b"{}"));
    assert_eq!((bare.status, bare.code().as_str()), (415, "unsupported_media_type"));
    let put = daemon.call("PUT", "/api/character", &[("authorization", &authorization), ("content-type", "text/plain")], Some(b"{}"));
    assert_eq!(put.status, 415);
}

#[test]
fn accepts_application_json_with_parameters() {
    let daemon = guarded();
    let authorization = bearer(&token());
    let body = json!({ "body": "# Casper\n" }).to_string();
    for kind in ["application/json; charset=utf-8", "Application/JSON", " application/json ;x=y"] {
        let response = daemon.call("PUT", "/api/character", &[("authorization", &authorization), ("content-type", kind)], Some(body.as_bytes()));
        assert_eq!(response.status, 200, "{kind}");
    }
}

#[test]
fn leaves_get_and_delete_alone_since_a_bodyless_request_has_nothing_to_smuggle() {
    let daemon = guarded();
    let authorization = bearer(&token());
    assert_eq!(daemon.get_as("/api/ghost", &[("authorization", &authorization), ("content-type", "text/plain")]).status, 200);
    // Nothing has been said, so there is nothing to start over from: the handler's answer, not the gate's.
    let deleted = daemon.call("DELETE", "/api/conversation", &[("authorization", &authorization), ("content-type", "text/plain")], None);
    assert_eq!(deleted.status, 404);
}

// ── Tailnet identity ────────────────────────────────────────────────────

/// Someone else on the owner's tailnet.
const OTHER: (&str, &str) = ("tailscale-user-login", "other@example.com");
const OWNER: (&str, &str) = ("tailscale-user-login", "owner@example.com");

/// A token-guarded daemon that admits the owner calling over the tailnet.
fn remote(configure: impl FnOnce(&mut ServerOptions)) -> Daemon {
    Daemon::with(replies(&["hello"]), |options| {
        options.api_token = ApiToken::Fixed(token());
        options.remote = tailnet(None);
        configure(options);
    })
}

#[test]
fn admits_the_owner_and_no_one_else_on_the_tailnet() {
    let daemon = remote(|_| {});
    assert_eq!(daemon.get("/api/ghost").status, 401);

    // Anyone else on the tailnet is not admitted at all.
    for (method, path) in [("GET", "/api/remote/whoami"), ("GET", "/api/ghost"), ("GET", "/api/conversation"), ("DELETE", "/api/conversation")] {
        assert_eq!(daemon.call(method, path, &[OTHER], None).status, 401, "{method} {path}");
    }
    let write = daemon.call("PUT", "/api/character", &[OTHER, JSON], Some(json!({ "body": "# Intruder\n" }).to_string().as_bytes()));
    assert_eq!(write.status, 401);

    assert_eq!(daemon.get_as("/api/remote/whoami", &[OWNER]).json(), json!({ "role": "owner" }));
    let owner_write = daemon.call(
        "PUT",
        "/api/character",
        &[("tailscale-user-login", "OWNER@example.com"), JSON],
        Some(json!({ "body": "# Casper\n" }).to_string().as_bytes()),
    );
    assert_eq!(owner_write.status, 200);
    assert_eq!(std::fs::read_to_string(daemon.ghost_dir.join("character.md")).unwrap(), "# Casper\n");
    assert_eq!(daemon.get_as("/api/ghost", &[OWNER, ("origin", "https://evil.example")]).status, 403);

    assert_eq!(daemon.get_as("/api/remote/whoami", &[("authorization", &bearer(&token()))]).json(), json!({ "role": "owner" }));
}

#[test]
fn shows_the_owner_what_runs_the_daemon() {
    let started_at = crate::clock::now_ms();
    let commit = "0123456789abcdef0123456789abcdef01234567";
    let daemon = remote(|options| {
        options.running_source = RunningSource {
            version: "1.4.0".to_string(),
            commit: Some(commit.to_string()),
            root: Some(PathBuf::from("/home/owner/src/ghost")),
            entry: std::env::current_exe().unwrap(),
            started_at,
        };
    });

    let owner = daemon.get_as("/api/status", &[("authorization", &bearer(&token()))]);
    assert_eq!(owner.status, 200);
    assert_eq!(
        owner.json(),
        json!({
            "version": "1.4.0",
            "source": { "commit": commit, "root": "/home/owner/src/ghost" },
            "startedAt": crate::clock::iso(started_at),
            "restartNeeded": false,
        })
    );
}

#[test]
fn honours_a_configured_owner_login() {
    let daemon = remote(|options| options.remote = tailnet(Some("other@example.com")));
    let refused = daemon.get_as("/api/ghost", &[OWNER]);
    assert_eq!((refused.status, refused.header("www-authenticate")), (401, Some("Bearer")));
    assert_eq!(daemon.get_as("/api/remote/whoami", &[OTHER]).json(), json!({ "role": "owner" }));
}

#[test]
fn admits_no_identity_when_the_server_has_no_remote_access() {
    let daemon = remote(|options| options.remote = None);
    assert_eq!(daemon.get_as("/api/ghost", &[OWNER]).status, 401);
}

#[test]
fn serves_no_page_since_everything_outside_the_api_is_a_404() {
    let daemon = remote(|_| {});
    for path in ["/", "/manifest.webmanifest", "/remote"] {
        for headers in [&[OWNER][..], &[]] {
            let response = daemon.get_as(path, headers);
            assert_eq!((response.status, response.code().as_str()), (404, "not_found"), "{path}");
        }
    }
}

#[test]
fn refuses_a_page_on_the_tailnet_host_itself_since_only_remote_apps_are_origins() {
    let daemon = remote(|_| {});
    let response = daemon.get_as("/api/ghost", &[OWNER, ("origin", "https://ghostbox.example.ts.net")]);
    assert_eq!((response.status, response.code().as_str()), (403, "forbidden_origin"));
}

// ── Remote status ───────────────────────────────────────────────────────

// Serve is the owner's to turn on with Tailscale's own command: ghostd reads its state and changes nothing.
#[test]
fn reports_remote_status_and_has_no_route_that_changes_it() {
    let (calls, runner) = fake_tailscale();
    let daemon = remote(|options| options.remote_serve = serve_over(runner));
    let off = json!({
        "state": "off",
        "hostname": FAKE_HOSTNAME,
        "owner": "owner@example.com",
        "app": null,
        "command": format!("tailscale serve --bg --https=443 {FAKE_TARGET}"),
        "problem": null,
    });
    let authorization = bearer(&token());
    let headers = [("authorization", authorization.as_str()), JSON];
    assert_eq!(daemon.get_as("/api/remote", &headers[..1]).json(), off);
    assert_eq!(daemon.get_as("/api/remote", &[OWNER]).json(), off);
    let posted = daemon.call("POST", "/api/remote", &headers, Some(json!({ "enabled": true }).to_string().as_bytes()));
    assert_eq!(posted.status, 405);
    let calls = calls.lock().unwrap();
    assert!(!calls.is_empty() && calls.iter().all(|call| call.ends_with("status --json")), "{calls:?}");
}

// ── A web app in remote.apps ────────────────────────────────────────────

const FROM_APP: (&str, &str) = ("origin", APP);

fn with_app() -> Daemon {
    remote(|options| options.remote_apps = vec![APP.to_string()])
}

#[test]
fn an_app_is_admitted_by_tailnet_identity_with_cors_for_its_origin() {
    let daemon = with_app();
    let owner = daemon.get_as("/api/ghost", &[FROM_APP, OWNER]);
    assert_eq!(owner.status, 200);
    assert_eq!(owner.header("access-control-allow-origin"), Some(APP));
    assert_eq!(owner.header("vary"), Some("origin"));
    assert_eq!(owner.header("access-control-allow-credentials"), None);
    assert_eq!(owner.header("access-control-allow-private-network"), None);

    let anonymous = daemon.get_as("/api/ghost", &[FROM_APP]);
    assert_eq!(anonymous.status, 401);
    assert_eq!(anonymous.header("access-control-allow-origin"), Some(APP));
    assert_eq!(anonymous.header("www-authenticate"), Some("Bearer"));
}

#[test]
fn refuses_the_bearer_token_from_an_app_origin_even_the_right_one() {
    let daemon = with_app();
    let authorization = bearer(&token());
    for headers in [&[FROM_APP, ("authorization", &authorization)][..], &[FROM_APP, OWNER, ("authorization", &authorization)]] {
        let response = daemon.get_as("/api/ghost", headers);
        assert_eq!((response.status, response.code().as_str()), (403, "app_token_refused"));
        assert_eq!(response.header("access-control-allow-origin"), Some(APP));
    }
}

#[test]
fn answers_the_preflight_with_the_apps_methods_and_headers_and_private_network_when_asked() {
    let daemon = with_app();
    let preflight = daemon.call(
        "OPTIONS",
        "/api/messages",
        &[FROM_APP, ("access-control-request-method", "POST"), ("access-control-request-private-network", "true")],
        None,
    );
    assert_eq!(preflight.status, 204);
    assert!(preflight.body.is_empty());
    assert_eq!(preflight.header("access-control-allow-origin"), Some(APP));
    assert_eq!(preflight.header("vary"), Some("origin"));
    assert_eq!(preflight.header("access-control-allow-methods"), Some("GET, POST, PUT, DELETE, OPTIONS"));
    assert_eq!(preflight.header("access-control-allow-headers"), Some("content-type"));
    assert_eq!(preflight.header("access-control-allow-private-network"), Some("true"));

    let plain = daemon.call("OPTIONS", "/api/ghost", &[FROM_APP], None);
    assert_eq!((plain.status, plain.header("access-control-allow-private-network")), (204, None));
}

#[test]
fn an_app_is_an_ordinary_foreign_origin_when_not_listed_or_when_remote_apps_is_empty() {
    for apps in [vec!["https://lab.summonghost.com".to_string()], Vec::new()] {
        let daemon = remote(|options| options.remote_apps = apps.clone());
        let response = daemon.get_as("/api/ghost", &[FROM_APP, OWNER]);
        assert_eq!((response.status, response.code().as_str()), (403, "forbidden_origin"), "{apps:?}");
        assert_eq!(response.header("access-control-allow-origin"), None, "{apps:?}");
    }
}

#[test]
fn answers_each_route_the_app_calls_admitted_by_tailnet_identity_alone() {
    let daemon = Daemon::with(replies(&["hello"]), |options| {
        options.api_token = ApiToken::Fixed(token());
        let config = RemoteConfig { owner: None, apps: Vec::new() };
        options.remote = Some(Arc::new(RemoteAccess::with_self_login(&config, Box::new(|| Some("owner@example.com".to_string())))));
        options.remote_apps = vec![APP.to_string()];
    });
    let owner = [FROM_APP, OWNER];
    let json_headers = [FROM_APP, OWNER, JSON];
    let get = |path: &str| daemon.get_as(&format!("/api{path}"), &owner);
    let send = |method: &str, path: &str, body: Value| daemon.call(method, &format!("/api{path}"), &json_headers, Some(body.to_string().as_bytes()));

    assert_eq!(get("/remote/whoami").json(), json!({ "role": "owner" }));
    assert_eq!(get("/remote/machines").status, 200);
    assert_eq!(get("/ghost").status, 200);
    // An EventSource stays open, so this one is opened and left.
    let stream = daemon.open("GET", "/api/events", &owner, None);
    assert_eq!(stream.status, 200);
    assert_eq!(stream.header("content-type"), Some("text/event-stream; charset=utf-8"));
    assert_eq!(stream.header("access-control-allow-origin"), Some(APP));
    drop(stream);

    let turn = send("POST", "/messages", json!({ "prompt": "hi" }));
    assert_eq!(turn.status, 200);
    assert_eq!(turn.header("access-control-allow-origin"), Some(APP));
    assert_eq!(deltas(&turn.events()), ["hello"]);
    assert_eq!(get("/conversation").json()["preview"], "hi");
    let transcript = get("/conversation/transcript").json();
    assert_eq!(get("/conversation/transcript?offset=0").status, 200);
    assert_eq!(send("PUT", "/conversation/read", json!({ "readThrough": transcript["readThrough"] })).status, 200);
    let attached = daemon.call("POST", "/api/conversation/attachments", &[FROM_APP, OWNER, ("content-type", "image/png")], Some(PNG));
    assert_eq!(attached.status, 201);
    let path = attached.json()["path"].as_str().unwrap().to_string();
    assert_eq!(get(&format!("/conversation/{path}")).status, 200);
    assert_eq!(get("/conversation/queue").json()["streaming"], false);
    // Idle, so these answer the contract's idle refusal rather than an auth or routing one.
    daemon.wait_settled();
    for (path, body) in [("/queue", json!({ "text": "more" })), ("/stop", json!({}))] {
        let response = send("POST", &format!("/conversation{path}"), body);
        assert_eq!((response.status, response.code().as_str()), (409, "conversation_not_streaming"), "{path}");
    }
    if daemon.can_trash() {
        assert_eq!(daemon.call("DELETE", "/api/conversation", &owner, None).status, 200);
    }
}

// ── GET /api/remote/machines ────────────────────────────────────────────

#[test]
fn lists_the_owners_other_machines_to_the_owner() {
    let daemon = with_app();
    let response = daemon.get_as("/api/remote/machines", &[FROM_APP, OWNER]);
    assert_eq!(response.status, 200);
    assert_eq!(
        response.json(),
        json!({ "machines": [{ "hostname": "laptop.example.ts.net", "online": true }, { "hostname": "phone.example.ts.net", "online": false }] })
    );
    assert_eq!(daemon.get_as("/api/remote/machines", &[("authorization", &bearer(&token()))]).status, 200);
    assert_eq!(daemon.get_as("/api/remote/machines", &[OTHER]).status, 401);
}

#[test]
fn machines_is_a_503_when_tailscale_does_not_answer() {
    let missing: TailscaleRunner = Arc::new(|_| Err(CommandFailure::Missing));
    let daemon = remote(|options| options.remote_serve = serve_over(missing));
    let response = daemon.get_as("/api/remote/machines", &[("authorization", &bearer(&token()))]);
    assert_eq!((response.status, response.code().as_str()), (503, "tailscale_unavailable"));
    // Status still answers, saying why.
    let status = daemon.get_as("/api/remote", &[("authorization", &bearer(&token()))]).json();
    assert_eq!((&status["state"], &status["problem"]["code"]), (&json!("unavailable"), &json!("tailscale_missing")));
}

// ── PUT|DELETE /api/push/subscription, POST /api/push/test ──────────────

const DEVICE_KEY: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

fn device(name: &str) -> Value {
    json!({
        "endpoint": format!("https://fcm.googleapis.com/fcm/send/{name}"),
        "p256dh": DEVICE_KEY,
        "auth": "BTBZMqHH6r4Tts7J_aSIgg",
        "vapidKey": "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    })
}

#[test]
fn a_subscribed_device_is_alerted_when_a_turn_ends_and_forgotten_when_it_unsubscribes() {
    let daemon = Daemon::answering(replies(&["The report is done.", "again"]));
    let subscribed = daemon.put("/api/push/subscription", &device("phone"));
    assert_eq!((subscribed.status, subscribed.json()), (200, json!({ "ok": true })));
    // A device its push service has dropped is forgotten at the first alert.
    daemon.put("/api/push/subscription", &device("gone"));
    let link = format!("{APP}/#/{FAKE_HOSTNAME}");
    *daemon.app_url.lock().unwrap() = Some(link.clone());

    daemon.post_turn(&first_turn());
    let pushed = wait_for(|| Some(daemon.pushed.lock().unwrap().clone()).filter(|pushed| pushed.len() == 2));
    let (endpoint, alert) = &pushed[0];
    assert_eq!(endpoint, "https://fcm.googleapis.com/fcm/send/phone");
    // The ghost's name, the reply, and the app's link to this machine; nothing names a conversation.
    assert_eq!(alert, &json!({ "title": "casper", "body": "The report is done.", "url": link }));

    let tested = daemon.post("/api/push/test", &json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/phone" }));
    assert_eq!((tested.status, tested.json()), (200, json!({ "ok": true, "delivered": true })));
    let test_alert = json!({ "title": "casper", "body": "Alerts from this machine reach this device.", "url": null });
    assert_eq!(daemon.pushed.lock().unwrap().last().unwrap().1, test_alert);
    // The dropped device is no longer known.
    assert_eq!(daemon.post("/api/push/test", &json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/gone" })).status, 400);

    // A device that unsubscribed is alerted no more: the next turn's alert goes to the one still subscribed, alone.
    daemon.put("/api/push/subscription", &device("tablet"));
    let removed = daemon.send_json("DELETE", "/api/push/subscription", &json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/phone" }));
    assert_eq!((removed.status, removed.json()), (200, json!({ "ok": true, "removed": true })));
    let again = daemon.send_json("DELETE", "/api/push/subscription", &json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/phone" }));
    assert_eq!((again.status, again.json()), (200, json!({ "ok": true, "removed": false })));
    let sent = daemon.pushed.lock().unwrap().len();
    daemon.wait_settled();
    daemon.post_turn(&turn_body("more"));
    let later = wait_for(|| Some(daemon.pushed.lock().unwrap()[sent..].to_vec()).filter(|later| !later.is_empty()));
    assert_eq!(later.iter().map(|(endpoint, _)| endpoint.as_str()).collect::<Vec<_>>(), ["https://fcm.googleapis.com/fcm/send/tablet"]);
    assert_eq!(later[0].1["body"], "again");
}

#[test]
fn refuses_a_subscription_that_is_not_a_browsers_push_service_or_has_bad_keys() {
    let daemon = Daemon::answering(replies(&["one"]));
    let mut elsewhere = device("phone");
    elsewhere["endpoint"] = json!("https://example.com/collect");
    let mut short = device("phone");
    short["auth"] = json!("abc");
    for bad in [elsewhere, short, json!({})] {
        let refused = daemon.put("/api/push/subscription", &bad);
        assert_eq!((refused.status, refused.json()["error"]["code"].clone()), (400, json!("invalid_request")), "{bad}");
    }
    assert!(!daemon.root.join(".state/ghost/push.json").exists());
}
