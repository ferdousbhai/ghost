//! The CLI against a scripted daemon: every test starts its own tiny server
//! on a free loopback port, with a scratch home, config path and token file,
//! and points the CLI at it through the runtime's environment.
use super::args::{ArgsSpec, Flag, parse_args};
use super::client::EXIT_CODES;
use super::common::{latest_session, resolve_session_prefix};
use super::output::relative_time;
use super::{CliRuntime, Stdin, commands, ghost_cli, hook_complete_command, parse_hook_complete_input};
use crate::abort::Abort;
use crate::env::Env;
use crate::help_topics::{HELP_TOPICS, render_help_topic};
use crate::http::{Request, Responder, Server};
use serde_json::{Value, json};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// SIGINT reaches every `ghost say` in the process, so the one test that
/// raises it runs alone: it writes this lock, every other run reads it.
static SIGNALS: RwLock<()> = RwLock::new(());

struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| arg.to_string()).collect()
}

/// Stdin as a terminal nobody types at, the default of every run.
fn terminal() -> Stdin<'static> {
    Stdin::Stream { reader: Box::new(std::io::empty()), is_tty: true }
}

fn run_unlocked(command: fn(&[String], CliRuntime) -> i32, args: &[&str], env: &Env, home: &Path, stdin: Stdin) -> Output {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let runtime = CliRuntime { env, home, stdout: &mut stdout, stderr: &mut stderr, stdin, stdout_is_tty: false };
    let code = command(&strings(args), runtime);
    Output { code, stdout: String::from_utf8(stdout).unwrap(), stderr: String::from_utf8(stderr).unwrap() }
}

fn run_with(args: &[&str], env: &Env, home: &Path, stdin: Stdin) -> Output {
    let _shared = SIGNALS.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    run_unlocked(ghost_cli, args, env, home, stdin)
}

/// One request as the fake daemon saw it.
#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    /// The known query parameters, in the order the CLI writes them.
    query: String,
    body: Option<Value>,
    authorization: Option<String>,
}

impl Seen {
    fn line(&self) -> String {
        format!("{} {}", self.method, self.path)
    }
}

/// A scripted daemon and the scratch directory its client runs in.
struct Fake {
    server: Server,
    seen: Arc<Mutex<Vec<Seen>>>,
    dir: PathBuf,
    env: Env,
}

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ghost-cli-{}", crate::random::uuid()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// An environment that keeps the CLI inside `dir`: no real config, token or port.
fn scratch_env(dir: &Path, port: u16) -> Env {
    let mut env = Env::new();
    env.insert("GHOSTD_PORT".into(), port.to_string());
    env.insert("GHOSTD_CONFIG".into(), dir.join("config.json").display().to_string());
    env.insert("GHOSTD_API_TOKEN_FILE".into(), dir.join("api-token").display().to_string());
    env.insert("HOME".into(), dir.display().to_string());
    env
}

fn fake(handle: impl Fn(&Seen, Responder) + Send + Sync + 'static) -> Fake {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let server = Server::start("127.0.0.1:0".parse().unwrap(), move |mut request: Request, responder| {
        let query: Vec<String> =
            ["limit", "offset", "turn", "from"].iter().filter_map(|key| Some(format!("{key}={}", request.query(key)?))).collect();
        let request = Seen {
            method: request.method.clone(),
            path: request.path.clone(),
            query: query.join("&"),
            body: request.read_body(1 << 20).ok().map(|bytes| serde_json::from_slice(&bytes).unwrap()),
            authorization: request.header("authorization").map(str::to_string),
        };
        record.lock().unwrap().push(request.clone());
        handle(&request, responder);
    })
    .unwrap();
    let dir = scratch();
    let env = scratch_env(&dir, server.address.port());
    Fake { server, seen, dir, env }
}

impl Fake {
    fn run(&self, args: &[&str]) -> Output {
        run_with(args, &self.env, &self.dir, terminal())
    }

    fn run_env(&self, args: &[&str], extra: &[(&str, &str)]) -> Output {
        let mut env = self.env.clone();
        env.extend(extra.iter().map(|(key, value)| (key.to_string(), value.to_string())));
        run_with(args, &env, &self.dir, terminal())
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn lines(&self) -> Vec<String> {
        self.seen().iter().map(Seen::line).collect()
    }

    fn token_file(&self) -> PathBuf {
        self.dir.join("api-token")
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.server.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn unexpected(responder: Responder) {
    responder.json(500, &json!({ "error": { "message": "unexpected request" } }));
}

fn events(responder: Responder, events: &[Value]) {
    let mut stream = responder.event_stream().unwrap();
    for event in events {
        stream.write(&format!("data: {event}\n\n")).unwrap();
    }
}

fn session(id: &str) -> Value {
    json!({ "id": id, "title": null, "preview": null, "updatedAt": "2026-01-01T00:00:00.000Z", "messageCount": 0, "pinned": false, "unread": false, "running": false, "question": null })
}

fn two_sessions() -> Value {
    json!({ "sessions": [session("conv-other"), session("conv-mine")] })
}

const MINE: &[(&str, &str)] = &[("GHOST_SESSION", "conv-mine")];

fn write_token(path: &Path, letter: char) {
    std::fs::write(path, format!("{}\n", letter.to_string().repeat(64))).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

// ── A ghost's own shell addresses its conversation ──────────────────────

#[test]
fn reads_ghost_session_in_place_of_s() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        path if path.ends_with("/transcript") => {
            responder.json(200, &json!({ "id": "conv-mine", "title": null, "messages": [], "total": 0, "truncated": false }))
        }
        _ => unexpected(responder),
    });
    assert_eq!(daemon.run_env(&["show", "--json"], MINE).code, 0);
    assert!(daemon.lines().contains(&"GET /api/sessions/conv-mine/transcript".to_string()));
}

#[test]
fn ask_asks_in_its_own_conversation_and_clear_withdraws() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        path if path.ends_with("/question") => responder.json(200, &json!({ "ok": true })),
        _ => unexpected(responder),
    });
    let asked = daemon.run_env(&["ask", "Ship it tonight?", "yes", "wait for review"], MINE);
    assert_eq!((asked.code, asked.stdout.as_str()), (0, "Asked in conv-mine; the owner's next message there is the answer.\n"));
    let put = daemon.seen().into_iter().find(|request| request.line() == "PUT /api/sessions/conv-mine/question").unwrap();
    assert_eq!(put.body, Some(json!({ "text": "Ship it tonight?", "options": ["yes", "wait for review"] })));
    let cleared = daemon.run_env(&["ask", "--clear"], MINE);
    assert_eq!((cleared.code, cleared.stdout.as_str()), (0, "Cleared the question in conv-mine.\n"));
    assert!(daemon.lines().contains(&"DELETE /api/sessions/conv-mine/question".to_string()));
    assert_ne!(daemon.run_env(&["ask"], MINE).code, 0);
}

#[test]
fn a_change_verb_acknowledges_in_a_sentence_and_q_prints_nothing() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        path if path.ends_with("/title") => responder.json(200, &json!({ "ok": true, "title": request.body.as_ref().unwrap()["title"] })),
        path if path.ends_with("/pin") || path.ends_with("/stop") || path.ends_with("/read") => responder.json(200, &json!({ "ok": true })),
        _ => unexpected(responder),
    });
    let cases: [(&[&str], &str); 5] = [
        (&["title", "Release notes"], "Conversation conv-mine is now titled \"Release notes\".\n"),
        (&["pin"], "Pinned conv-mine.\n"),
        (&["unpin"], "Unpinned conv-mine.\n"),
        (&["stop"], "Stopped conv-mine.\n"),
        (&["read"], "Marked conv-mine read.\n"),
    ];
    for (args, sentence) in cases {
        let said = daemon.run_env(args, MINE);
        assert_eq!((said.code, said.stdout.as_str()), (0, sentence), "{args:?}");
        let quiet = daemon.run_env(&[args, &["-q"]].concat(), MINE);
        assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""), "{args:?}");
    }
    let bodies: Vec<Value> = daemon.seen().into_iter().filter(|request| request.path.ends_with("/pin")).filter_map(|request| request.body).collect();
    assert_eq!(bodies, [json!({ "pinned": true }), json!({ "pinned": true }), json!({ "pinned": false }), json!({ "pinned": false })]);
}

#[test]
fn stop_targets_the_running_turn() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        path if path.ends_with("/stop") => responder.json(200, &json!({ "stopped": true })),
        _ => unexpected(responder),
    });
    assert_eq!(daemon.run_env(&["stop"], MINE).code, 0);
    assert!(daemon.lines().contains(&"POST /api/sessions/conv-mine/stop".to_string()));
}

#[test]
fn turns_a_follow_up_to_an_idle_conversation_into_its_next_turn() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        path if path.ends_with("/queue") => responder.json(409, &json!({ "error": { "code": "session_not_streaming", "message": "idle" } })),
        "/api/messages" => events(responder, &[json!({ "type": "text_delta", "delta": "Noted." }), json!({ "type": "done" })]),
        _ => unexpected(responder),
    });
    let result = daemon.run_env(&["say", "--follow-up", "-q", "job finished"], MINE);
    assert_eq!((result.code, result.stdout.as_str()), (0, "Noted.\n"));
    let seen = daemon.seen();
    let queued = seen.iter().find(|request| request.path == "/api/sessions/conv-mine/queue").unwrap();
    assert_eq!((queued.method.as_str(), &queued.body), ("POST", &Some(json!({ "text": "job finished" }))));
    let turn = seen.iter().find(|request| request.path == "/api/messages").unwrap();
    assert_eq!(turn.body, Some(json!({ "prompt": "job finished", "sessionId": "conv-mine" })));
}

#[test]
fn acknowledges_a_follow_up_queued_into_a_live_turn_and_q_prints_nothing() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        path if path.ends_with("/queue") => responder.json(200, &json!({ "streaming": true, "followUp": ["job finished"] })),
        _ => unexpected(responder),
    });
    let human = daemon.run_env(&["say", "--follow-up", "job finished"], MINE);
    assert_eq!((human.code, human.stdout.as_str()), (0, "Queued for conv-mine.\n"));
    let quiet = daemon.run_env(&["say", "--follow-up", "-q", "job finished"], MINE);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""));
}

#[test]
fn show_prints_a_long_conversations_newest_page_and_says_which_messages_it_is() {
    let daemon = fake(|request, responder| {
        if request.path == "/api/sessions" {
            return responder.json(200, &two_sessions());
        }
        let parameter = |key: &str, fallback: i64| {
            request.query.split('&').find_map(|pair| pair.strip_prefix(&format!("{key}="))).map_or(fallback, |value| value.parse().unwrap())
        };
        let (total, limit, offset) = (5, parameter("limit", 1000), parameter("offset", 0));
        let messages: Vec<Value> = (offset..(offset + limit).min(total))
            .map(|index| json!({ "role": "user", "entryId": format!("e{index}"), "content": [{ "type": "text", "text": format!("message {}", index + 1) }] }))
            .collect();
        responder.json(
            200,
            &json!({ "id": "conv-mine", "truncated": (messages.len() as i64) < total, "messages": messages, "total": total, "readThrough": null }),
        );
    });
    let queries = |daemon: &Fake| -> Vec<String> {
        let all = daemon.seen().into_iter().filter(|request| request.path.ends_with("/transcript")).map(|request| request.query).collect();
        daemon.seen.lock().unwrap().clear();
        all
    };
    let newest = daemon.run_env(&["show", "--limit", "2"], MINE);
    assert_eq!(newest.code, 0);
    assert_eq!(queries(&daemon), ["limit=2", "limit=2&offset=3"]);
    assert_eq!(newest.stdout, "**you:**\n\nmessage 4\n\n**you:**\n\nmessage 5\n\n(messages 4–5 of 5; --offset/--limit for others)\n");

    let oldest = daemon.run_env(&["show", "--limit", "2", "--offset", "0"], MINE);
    assert_eq!(queries(&daemon), ["limit=2&offset=0"]);
    assert!(oldest.stdout.contains("message 1"));
    assert!(oldest.stdout.contains("(messages 1–2 of 5; --offset/--limit for others)"));

    let whole = daemon.run_env(&["show"], MINE);
    assert_eq!(queries(&daemon), [""]);
    assert!(!whole.stdout.contains("(messages"));

    let past = daemon.run_env(&["show", "--offset", "9"], MINE);
    assert_eq!((past.code, past.stdout.as_str()), (0, "(no messages from 10; 5 in all)\n"));
    let quiet = daemon.run_env(&["show", "--offset", "9", "-q"], MINE);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""));
}

#[test]
fn show_renders_tool_calls_hook_messages_and_an_empty_conversation() {
    let daemon = fake(|request, responder| {
        match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        "/api/sessions/conv-mine/transcript" => responder.json(
            200,
            &json!({ "total": 2, "truncated": false, "messages": [
                { "role": "assistant", "content": [{ "type": "text", "text": "On it." }, { "type": "toolCall", "name": "bash", "arguments": { "command": "ls" } }, { "type": "text", "text": "" }, { "type": "toolCall", "name": "ask", "arguments": { "question": "Which?", "options": ["A", "B"] } }, { "type": "text", "text": "Which?\n\n1. A\n2. B" }] },
                { "role": "hook", "content": [{ "type": "text", "text": "Not done." }] },
            ] }),
        ),
        _ => responder.json(200, &json!({ "total": 0, "truncated": false, "messages": [] })),
    }
    });
    let shown = daemon.run_env(&["show"], MINE);
    assert_eq!(shown.stdout, "**ghost:**\n\nOn it.\n> ⚙ bash({\"command\":\"ls\"})\n> ⚙ ask\nWhich?\n\n1. A\n2. B\n\n**Stop hook:**\n\nNot done.\n");
    let empty = daemon.run(&["show", "-s", "conv-other"]);
    assert_eq!((empty.code, empty.stdout.as_str()), (0, "No messages.\n"));
}

#[test]
fn q_keeps_a_read_verbs_primary_output() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        "/api/character" => responder.json(200, &json!({ "body": "# Casper\nFriendly.\n" })),
        _ => {
            let offset: i64 = request.query.split('&').find_map(|pair| pair.strip_prefix("offset=")).map_or(0, |value| value.parse().unwrap());
            let message = json!({ "role": "user", "entryId": format!("e{offset}"), "content": [{ "type": "text", "text": format!("message {}", offset + 1) }] });
            responder.json(200, &json!({ "id": "conv-mine", "messages": [message], "total": 3, "truncated": true, "readThrough": null }));
        }
    });
    let show = daemon.run_env(&["show", "-q", "--limit", "1"], MINE);
    assert_eq!((show.code, show.stdout.as_str()), (0, "**you:**\n\nmessage 3\n"));
    let character = daemon.run_env(&["character", "show", "-q"], MINE);
    assert_eq!((character.code, character.stdout.as_str()), (0, "# Casper\nFriendly.\n"));
}

#[test]
fn still_fails_a_follow_up_on_any_other_conflict() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &two_sessions()),
        path if path.ends_with("/queue") => responder.json(409, &json!({ "error": { "code": "session_busy", "message": "busy" } })),
        _ => unexpected(responder),
    });
    let result = daemon.run_env(&["say", "--follow-up", "x"], MINE);
    assert_eq!(Some(&(result.code, "busy or conflict")), EXIT_CODES.iter().find(|(_, meaning)| *meaning == "busy or conflict"));
    assert_eq!(result.stderr, "ghost: busy\n");
}

// ── Offline: help, usage, the parser, the helpers ───────────────────────

/// A run that must not reach a daemon: nothing listens on the port it is given.
fn offline(args: &[&str], extra: &[(&str, &str)]) -> Output {
    let dir = scratch();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut env = scratch_env(&dir, listener.local_addr().unwrap().port());
    drop(listener);
    env.extend(extra.iter().map(|(key, value)| (key.to_string(), value.to_string())));
    let output = run_with(args, &env, &dir, terminal());
    std::fs::remove_dir_all(dir).unwrap();
    output
}

#[test]
fn help_renders_every_recipe_without_a_daemon() {
    for topic in HELP_TOPICS {
        let result = offline(&["help", topic], &[("PATH", "/nonexistent")]);
        assert_eq!((result.code, result.stderr.as_str()), (0, ""), "{topic}");
        assert_eq!(Some(result.stdout), render_help_topic(topic), "{topic}");
    }
}

#[test]
fn parses_long_equals_short_value_boolean_and_terminator_forms() {
    let spec = ArgsSpec { boolean: vec![], value: vec!["harness", "session"] };
    let parsed = parse_args(&strings(&["--harness=claude", "-s", "abc", "--json", "--", "--literal"]), &spec).unwrap();
    assert_eq!(parsed.positionals, ["--literal"]);
    assert_eq!(
        parsed.flags,
        [("harness".to_string(), Flag::Text("claude".into())), ("session".into(), Flag::Text("abc".into())), ("json".into(), Flag::On)]
    );
}

fn parse_error(args: &[&str], value: &[&'static str]) -> String {
    let error = parse_args(&strings(args), &ArgsSpec { boolean: vec![], value: value.to_vec() }).unwrap_err();
    assert_eq!(error.exit_code, 2);
    error.message
}

#[test]
fn keeps_a_lone_dash_positional_and_rejects_unknown_flags() {
    assert_eq!(parse_args(&strings(&["-"]), &ArgsSpec::default()).unwrap().positionals, ["-"]);
    assert!(parse_error(&["--wat"], &[]).starts_with("Unknown option '--wat'"));
    assert!(parse_error(&["--session", "--json"], &["session"]).contains("'--session' argument is ambiguous"));
    assert!(parse_error(&["--session"], &["session"]).contains("argument missing"));
    assert_eq!(parse_error(&["--session="], &["session"]), "--session requires a value.");
    let parsed = parse_args(&strings(&["--q", "model", "-q"]), &ArgsSpec { boolean: vec![], value: vec!["q"] }).unwrap();
    assert!(parsed.positionals.is_empty());
    assert_eq!(parsed.flags, [("q".to_string(), Flag::Text("model".into())), ("quiet".into(), Flag::On)]);
}

/// The sentences `util.parseArgs` gave under Bun, which scripts have seen.
#[test]
fn words_every_parse_error_as_the_first_cli_did() {
    let session = &["session", "limit"];
    assert_eq!(
        parse_error(&["-g", "x"], session),
        "Unknown option '-g'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-g\""
    );
    assert_eq!(
        parse_error(&["--wat=1"], session),
        "Unknown option '--wat'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--wat\""
    );
    assert!(parse_error(&["-qg"], session).starts_with("Unknown option 'g'."));
    assert_eq!(
        parse_error(&["-s", "--json"], session),
        "Option '-s' argument is ambiguous.\nDid you forget to specify the option argument for '-s'?\nTo specify an option argument starting with a dash use '--session=-XYZ' or '-s-XYZ'."
    );
    assert_eq!(
        parse_error(&["--limit", "-5"], session),
        "Option '--limit' argument is ambiguous.\nDid you forget to specify the option argument for '--limit'?\nTo specify an option argument starting with a dash use '--limit=-XYZ'."
    );
    assert_eq!(parse_error(&["-s"], session), "Option '-s, --session <value>' argument missing");
    assert_eq!(parse_error(&["-qs"], session), "Option '-s, --session <value>' argument missing");
    assert_eq!(parse_error(&["--limit"], session), "Option '--limit <value>' argument missing");
    assert_eq!(parse_error(&["--help=x"], session), "Option '-h, --help' does not take an argument");
    assert_eq!(parse_error(&["--json=true"], session), "Option '--json' does not take an argument");
    let parse = |args: &[&str]| parse_args(&strings(args), &ArgsSpec { boolean: vec![], value: session.to_vec() }).unwrap();
    let grouped = parse(&["-qhsabc", "word", "--limit=-5", "-s", "-", "-s", "last"]);
    assert_eq!(grouped.positionals, ["word"]);
    assert!(grouped.boolean("quiet") && grouped.boolean("help"));
    assert_eq!((grouped.text("session"), grouped.text("limit")), (Some("last"), Some("-5")));
    assert_eq!(parse(&["-s=x"]).text("session"), Some("=x"));
    assert_eq!(parse(&["-qs", "x"]).text("session"), Some("x"));
    assert_eq!(parse(&["--session=a=b"]).text("session"), Some("a=b"));
}

#[test]
fn formats_relative_times() {
    let now = crate::clock::parse_iso("2026-08-29T12:00:00.000Z").unwrap();
    assert_eq!(relative_time("2026-08-29T11:57:00.000Z", now), "3m");
    assert_eq!(relative_time("2026-08-29T10:00:00.000Z", now), "2h");
    assert_eq!(relative_time("2026-08-25T12:00:00.000Z", now), "4d");
    assert_eq!(relative_time("2026-08-29T11:59:30.000Z", now), "now");
    assert_eq!(relative_time("soon", now), "—");
}

#[test]
fn resolves_exact_and_unique_prefixes_and_refuses_ambiguity() {
    let rows = [session("alpha"), session("alpine")];
    assert_eq!(resolve_session_prefix(&rows, "alpha").unwrap()["id"], "alpha");
    assert_eq!(resolve_session_prefix(&rows, "alph").unwrap()["id"], "alpha");
    let ambiguous = resolve_session_prefix(&rows, "al").unwrap_err();
    assert_eq!((ambiguous.exit_code, ambiguous.message.as_str()), (2, "Session prefix \"al\" is ambiguous: alpha, alpine"));
    let missing = resolve_session_prefix(&rows, "beta").unwrap_err();
    assert_eq!((missing.exit_code, missing.message.as_str()), (5, "session \"beta\" was not found"));
}

#[test]
fn selects_the_newest_update() {
    let mut pinned = session("older");
    pinned["pinned"] = json!(true);
    let mut recent = session("recent");
    recent["updatedAt"] = json!("2026-01-02T00:00:00.000Z");
    assert_eq!(latest_session(&[pinned.clone(), recent.clone()]), Some(&recent));
    assert_eq!(latest_session(&[pinned.clone(), session("tied")]), Some(&pinned));
    assert_eq!(latest_session(&[]), None);
}

#[test]
fn help_is_available_without_contacting_the_daemon_for_every_command() {
    for command in commands() {
        let result = offline(&[command.doc.verb, "--help"], &[]);
        assert_eq!(result.code, 0, "{}", command.doc.verb);
        assert!(result.stdout.starts_with(&format!("Usage: ghost {}", command.doc.verb)), "{}", result.stdout);
    }
    let say = offline(&["say", "-h"], &[]);
    assert_eq!(
        say.stdout,
        "Usage: ghost say [text] [--new|--follow-up] [-s <id>] [--json] [-q]\n\nSend a turn, or follow up on one.\n\nExample: ghost say --new \"Start fresh\"\n"
    );
}

#[test]
fn prints_the_usage_screen_with_no_verb() {
    let bare = offline(&[], &[]);
    assert_eq!(bare.code, 0);
    assert_eq!(bare.stdout, offline(&["help"], &[]).stdout);
    assert!(bare.stdout.starts_with("ghost — talk to your ghost through ghostd\n\nUsage:\n  ghost <verb> [args] [flags]\n"));
    // Every summary starts in one column, two spaces past the longest usage (`help`, which lists the topics).
    let widest = format!("help [command|exit-codes|{}]", HELP_TOPICS.join("|")).len();
    assert!(bare.stdout.contains(&format!("\n  {:<widest$}  List conversations.\n", "sessions [--json] [-q]")), "{}", bare.stdout);
    assert!(
        bare.stdout
            .contains(&format!("\n  {:<widest$}  Send a turn, or follow up on one.\n", "say [text] [--new|--follow-up] [-s <id>] [--json] [-q]"))
    );
    assert!(bare.stdout.contains("\n  -v, --version            Show the ghost package version\n"));
    assert!(bare.stdout.ends_with("answered by a model on this machine); ghost talks to the ghost.\n"));
}

#[test]
fn refuses_a_malformed_verb_before_asking_the_daemon_anything() {
    let daemon = fake(|_, responder| unexpected(responder));
    let cases: [&[&str]; 9] = [
        &["ask"],
        &["ask", "--clear", "Ship it?"],
        &["character", "edit"],
        &["character", "set"],
        &["hooks", "show", "extra"],
        &["character", "show", "extra"],
        &["say", "hello", "-m", "world"],
        &["say", "--new", "--follow-up", "hello"],
        &["say"],
    ];
    for args in cases {
        let result = daemon.run_env(args, &[("GHOST_SESSION", "conv-1")]);
        assert_eq!(result.code, 2, "{args:?}: {}", result.stderr);
    }
    assert!(daemon.seen().is_empty());
    assert_eq!(daemon.run(&["title"]).stderr, "ghost: Usage: ghost title <text> [-s <id>] [--json] [-q]\n");
    assert_eq!(daemon.run(&["say"]).stderr, "ghost: Message text cannot be empty.\n");
    assert_eq!(daemon.run(&["remote", "maybe"]).stderr, "ghost: ghost remote does not know \"maybe\"; use status, on, or off.\n");
    assert_eq!(daemon.run(&["hooks", "edit"]).stderr, "ghost: ghost hooks does not know \"edit\"; use status, show, or set.\n");
}

#[test]
fn refuses_s_on_a_verb_whose_usage_does_not_list_it_and_g_everywhere() {
    let daemon = fake(|_, responder| unexpected(responder));
    let stray_session = ["sessions", "character", "status"].map(|verb| vec![verb, "-s", "conv-1"]);
    let stray_ghost = ["say hi", "sessions", "show", "hooks", "remote", "status", "help memory"]
        .map(|verb| [verb.split(' ').collect(), vec!["-g", "casper"]].concat());
    for args in stray_session.iter().chain(&stray_ghost) {
        let result = daemon.run_env(args, &[("GHOST_SESSION", "conv-1")]);
        assert_eq!(result.code, 2, "{args:?}");
        assert!(result.stderr.contains("Unknown option"), "{args:?}: {}", result.stderr);
    }
    assert!(daemon.seen().is_empty());
}

#[test]
fn refuses_a_missing_or_malformed_input_file_before_asking_the_daemon_anything() {
    let daemon = fake(|_, responder| unexpected(responder));
    let missing = daemon.dir.join("missing.json").display().to_string();
    let malformed = daemon.dir.join("malformed.json").display().to_string();
    std::fs::write(&malformed, "{ not json").unwrap();
    let hooks = daemon.run(&["hooks", "set", &malformed]);
    assert_eq!((hooks.code, hooks.stderr), (2, format!("ghost: {malformed} is not valid JSON\n")));
    let character = daemon.run(&["character", "set", &missing]);
    assert_eq!((character.code, character.stderr), (2, format!("ghost: ENOENT: no such file or directory, open '{missing}'\n")));
    assert!(daemon.seen().is_empty());
}

#[test]
fn prints_the_embedded_version_and_stable_exit_code_reference_offline() {
    let version = offline(&["--version"], &[("GHOSTD_VERSION", "9.8.7")]);
    assert_eq!((version.code, version.stdout.as_str()), (0, "9.8.7\n"));
    assert_eq!(offline(&["-v"], &[]).stdout, format!("{}\n", crate::VERSION));
    let codes = offline(&["help", "exit-codes"], &[]);
    assert_eq!(codes.code, 0);
    assert_eq!(
        codes.stdout,
        "ghost exit codes\n\n    0  success\n    1  turn or action failed\n    2  usage error\n    3  daemon unreachable\n    4  unauthorized\n    5  not found\n    6  busy or conflict\n  130  interrupted at the terminal (Ctrl-C)\n"
    );
}

#[test]
fn lists_the_recipes_in_its_usage() {
    assert!(offline(&["help", "help"], &[]).stdout.contains(&format!("help [command|exit-codes|{}]", HELP_TOPICS.join("|"))));
}

#[test]
fn refuses_a_topic_or_a_verb_it_does_not_know() {
    let topic = offline(&["help", "memor"], &[]);
    assert_eq!((topic.code, topic.stdout.as_str(), topic.stderr.as_str()), (2, "", "ghost: Unknown help topic: memor\n"));
    for verb in [&["list"][..], &["new", "probe"], &["use", "casper"], &["rename", "wisp"], &["browser"], &["browser", "allow"]] {
        let result = offline(verb, &[]);
        assert_eq!((result.code, result.stderr), (2, format!("ghost: Unknown command: {}\n", verb[0])));
    }
}

// ── How the CLI reads the API ───────────────────────────────────────────

fn answering(body: Value) -> Fake {
    fake(move |_, responder| responder.json(200, &body))
}

#[test]
fn remote_prints_a_problems_message_not_the_object() {
    let problem = json!({ "code": "tailscale_stopped", "message": "Tailscale is not running", "action": "sudo tailscale up" });
    let off = answering(json!({ "state": "off", "hostname": null, "problem": problem }));
    assert_eq!(off.run(&["remote"]).stdout, "off (Tailscale is not running)\n");
    assert_eq!(off.run(&["remote", "-q"]).stdout, "off\n");
    assert_eq!(off.lines(), ["GET /api/remote", "GET /api/remote"]);
    let unavailable = answering(json!({ "state": "unavailable", "hostname": null, "app": null, "problem": problem }));
    assert_eq!(unavailable.run(&["remote"]).stdout, "unavailable (Tailscale is not running)\n");
    let refused = unavailable.run(&["remote", "on"]);
    assert_eq!(refused.stderr, "ghost: remote access is unavailable: Tailscale is not running (sudo tailscale up)\n");
}

#[test]
fn remote_prints_the_app_link_and_says_when_there_is_no_app() {
    let app = json!({ "origin": "https://summonghost.com", "url": "https://summonghost.com/#add=box.tail.ts.net" });
    let linked = answering(json!({ "state": "on", "hostname": "box.tail.ts.net", "problem": null, "app": app }));
    let on = linked.run(&["remote", "on"]);
    assert_eq!((on.code, on.stdout.as_str()), (0, "Remote access is on at box.tail.ts.net.\napp https://summonghost.com/#add=box.tail.ts.net\n"));
    let sent = linked.seen().remove(0);
    assert_eq!((sent.line().as_str(), sent.body), ("POST /api/remote", Some(json!({ "enabled": true }))));
    assert_eq!(linked.run(&["remote"]).stdout, "on box.tail.ts.net\napp https://summonghost.com/#add=box.tail.ts.net\n");
    let bare = answering(json!({ "state": "on", "hostname": "box.tail.ts.net", "problem": null, "app": null }));
    assert_eq!(
        bare.run(&["remote", "on"]).stdout,
        "Remote access is on at box.tail.ts.net.\nno app: remote.apps is empty, so nothing can reach Ghost remotely\n"
    );
}

#[test]
fn remote_on_or_off_exits_1_on_stderr_when_the_state_is_not_what_was_asked() {
    let refused = json!({ "state": "off", "hostname": "box.tail.ts.net", "app": { "origin": "https://summonghost.com", "url": null },
        "problem": { "code": "https_required", "message": "This tailnet has no HTTPS certificates." } });
    let daemon = answering(refused.clone());
    let plain = daemon.run(&["remote", "on"]);
    assert_eq!(
        (plain.code, plain.stdout.as_str(), plain.stderr.as_str()),
        (1, "", "ghost: remote access is off: This tailnet has no HTTPS certificates.\n")
    );
    let json = daemon.run(&["remote", "on", "--json"]);
    assert_eq!(json.code, 1);
    assert_eq!(serde_json::from_str::<Value>(&json.stdout).unwrap(), refused);
    // No problem named, but still on after `off`.
    let still_on = answering(json!({ "state": "on", "hostname": "box.tail.ts.net", "app": null, "problem": null }));
    let stuck = still_on.run(&["remote", "off"]);
    assert_eq!((stuck.code, stuck.stdout.as_str(), stuck.stderr.as_str()), (1, "", "ghost: remote access is on: ghostd did not turn it off\n"));
    let off = answering(json!({ "state": "off", "hostname": "box.tail.ts.net", "app": null, "problem": null })).run(&["remote", "off"]);
    assert_eq!((off.code, off.stdout.as_str(), off.stderr.as_str()), (0, "Remote access is off.\n", ""));
}

#[test]
fn an_empty_list_says_so_in_a_sentence_and_q_prints_nothing() {
    let daemon = answering(json!({ "sessions": [] }));
    let human = daemon.run(&["sessions"]);
    assert_eq!((human.code, human.stdout.as_str()), (0, "No conversations.\n"));
    let quiet = daemon.run(&["sessions", "-q"]);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""));
}

#[test]
fn sessions_prints_a_table_of_titles_ages_counts_and_states() {
    let mut asking = session("conv-asking");
    asking["title"] = json!("A title that is far longer than the forty-two units the column holds");
    asking["question"] = json!({ "text": "Ship?" });
    asking["pinned"] = json!(true);
    asking["messageCount"] = json!(12);
    asking["updatedAt"] = json!(crate::clock::now_iso());
    let mut previewed = session("c2");
    previewed["preview"] = json!("hello");
    previewed["running"] = json!(true);
    previewed["unread"] = json!(true);
    previewed["updatedAt"] = json!("never");
    let daemon = answering(json!({ "sessions": [asking, previewed] }));
    assert_eq!(
        daemon.run(&["sessions"]).stdout,
        "ID           TITLE                                       UPDATED  MESSAGES  STATE\n\
         conv-asking  A title that is far longer than the forty…  now      12        asking,pinned\n\
         c2           hello                                       —        0         running,unread\n"
    );
    assert_eq!(daemon.run(&["sessions", "-q"]).stdout, "conv-asking\nc2\n");
}

fn hooks_document() -> Value {
    json!({ "hooks": {
        "session_stop": [{ "hooks": [{ "type": "command", "command": "/bin/true", "name": "Review", "description": "Reviews the pass." }] }],
        "turn_end": [{ "hooks": [{ "type": "command", "command": "/bin/true" }] }],
    } })
}

#[test]
fn hooks_status_prints_each_hooks_event_name_and_description() {
    let daemon = answering(json!({ "path": "/home/owner/.config/ghost/hooks.json", "document": hooks_document() }));
    assert_eq!(
        daemon.run(&["hooks"]).stdout,
        "EVENT         NAME                   DESCRIPTION\n\
         session_stop  Review                 Reviews the pass.\n\
         turn_end      Turn-end command hook  Observes final turn success or failure without continuing it.\n"
    );
    assert_eq!(daemon.run(&["hooks", "status", "-q"]).stdout, "Review\nTurn-end command hook\n");
    let shown = daemon.run(&["hooks", "show"]);
    assert!(
        shown.stdout.starts_with("{\n  \"path\": \"/home/owner/.config/ghost/hooks.json\",\n  \"document\": {\n    \"hooks\": {\n"),
        "{}",
        shown.stdout
    );
    assert_eq!(shown.stdout, daemon.run(&["hooks", "show", "-q"]).stdout);
    assert_eq!(daemon.lines(), ["GET /api/hooks/config"; 4]);
    assert_eq!(answering(json!({ "path": "/h.json", "document": {} })).run(&["hooks"]).stdout, "No hooks configured.\n");
}

#[test]
fn hooks_refuses_a_document_ghostd_would_not_run() {
    let refused = |document: Value| {
        let result = answering(json!({ "path": "/h.json", "document": document })).run(&["hooks"]);
        assert_eq!((result.code, result.stdout.as_str()), (1, ""));
        result.stderr
    };
    assert_eq!(refused(json!([])), "ghost: /h.json must contain a JSON object.\n");
    assert_eq!(refused(json!({ "path": "x", "hooks": {} })), "ghost: /h.json has no top-level \"path\"; send the document itself.\n");
    assert_eq!(refused(json!({ "hooks": { "pre_tool": [] } })), "ghost: /h.json: unsupported hook event \"pre_tool\".\n");
    assert_eq!(refused(json!({ "hooks": { "turn_end": {} } })), "ghost: /h.json: \"hooks.turn_end\" must be an array.\n");
    assert_eq!(
        refused(json!({ "hooks": { "turn_end": [{ "hooks": [{ "type": "command", "command": " " }] }] } })),
        "ghost: /h.json: hooks.turn_end[0].hooks[0] must be a command hook with a non-empty NUL-free command.\n"
    );
    assert_eq!(
        refused(json!({ "hooks": { "turn_end": [{ "hooks": [{ "type": "command", "command": "x", "timeout": 601 }] }] } })),
        "ghost: /h.json: hooks.turn_end[0].hooks[0].timeout must be a number in (0, 600].\n"
    );
    assert_eq!(
        refused(json!({ "hooks": { "turn_end": [{ "hooks": [{ "type": "command", "command": "x", "name": "" }] }] } })),
        "ghost: /h.json: hooks.turn_end[0].hooks[0].name must be a non-empty string of at most 80 characters.\n"
    );
}

#[test]
fn hooks_set_acknowledges_in_words_json_keeps_the_api_body_and_q_prints_nothing() {
    let document = json!({ "hooks": { "turn_end": [{ "hooks": [{ "type": "command", "command": "/bin/true" }, { "type": "command", "command": "/bin/false" }] }] } });
    let config = json!({ "path": "/home/owner/.config/ghost/hooks.json", "document": document });
    let daemon = answering(config.clone());
    let file = daemon.dir.join("hooks.json").display().to_string();
    std::fs::write(&file, document.to_string()).unwrap();
    let set = daemon.run(&["hooks", "set", &file]);
    assert_eq!((set.code, set.stdout.as_str()), (0, "Replaced /home/owner/.config/ghost/hooks.json (2 hooks).\n"));
    assert_eq!(serde_json::from_str::<Value>(&daemon.run(&["hooks", "set", &file, "--json"]).stdout).unwrap(), config);
    let quiet = daemon.run(&["hooks", "set", &file, "-q"]);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""));
    for request in daemon.seen() {
        assert_eq!((request.line().as_str(), request.body), ("PUT /api/hooks/config", Some(document.clone())));
    }
}

/// A daemon answering `ghost status`'s three reads, `/api/status` with `daemon`.
fn status_daemon(ghost: Value, daemon: Value) -> Fake {
    fake(move |request, responder| match request.path.as_str() {
        "/api/ghost" => responder.json(200, &ghost),
        "/api/status" => responder.json(200, &daemon),
        "/api/remote" => responder.json(
            200,
            &json!({ "state": "off", "hostname": null, "guests": "read-only", "owner": null, "app": null,
                "problem": { "code": "https_required", "message": "This tailnet has no HTTPS certificates." } }),
        ),
        _ => responder.json(404, &json!({ "error": { "code": "not_found", "message": "Not found." } })),
    })
}

#[test]
fn reports_the_running_daemons_version_commit_source_root_and_remote_access() {
    let source = json!({ "commit": "0123456789abcdef0123456789abcdef01234567", "root": "/home/owner/src/ghost" });
    let running = json!({ "version": "1.4.0", "source": source, "startedAt": "2026-10-28T12:40:53.000Z", "restartNeeded": false });
    let daemon = status_daemon(json!({ "name": "casper" }), running);
    let response = daemon.run_env(&["status"], &[("GHOSTD_VERSION", "3.2.1")]);
    let (url, token) = (format!("http://127.0.0.1:{}", daemon.server.address.port()), daemon.token_file().display().to_string());
    assert_eq!(
        response.stdout,
        format!(
            "daemon         {url}\ntoken file     {token}\nghost          casper\nversion        3.2.1\ndaemon version 1.4.0\n\
             daemon commit  0123456789abcdef0123456789abcdef01234567\ndaemon source  /home/owner/src/ghost\n\
             daemon started 2026-10-28T12:40:53.000Z\nremote         off (This tailnet has no HTTPS certificates.)\n"
        )
    );
    assert_eq!(daemon.run(&["status", "-q"]).stdout, "ok\n");
    let json: Value = serde_json::from_str(&daemon.run_env(&["status", "--json"], &[("GHOSTD_VERSION", "3.2.1")]).stdout).unwrap();
    let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["daemon", "tokenFile", "ghost", "version", "daemonVersion", "source", "daemonStartedAt", "restartNeeded", "remote"]);
    assert_eq!(
        (&json["daemon"], &json["tokenFile"], &json["ghost"], &json["version"]),
        (&json!(url), &json!(token), &json!("casper"), &json!("3.2.1"))
    );
    assert_eq!((&json["daemonVersion"], &json["source"], &json["restartNeeded"]), (&json!("1.4.0"), &source, &json!(false)));
    assert_eq!(json["remote"]["state"], "off");
}

// An update that was not restarted into still answers under the same
// version; status says so, and points at the safe way to restart.
#[test]
fn says_when_the_code_on_disk_is_newer_than_the_running_daemon() {
    let running =
        json!({ "version": "1.4.0", "source": { "commit": null, "root": null }, "startedAt": "2026-10-28T12:40:53.000Z", "restartNeeded": true });
    let stdout = status_daemon(json!([]), running).run(&["status"]).stdout;
    assert!(stdout.contains("\nghost          —\n"), "{stdout}");
    assert!(stdout.contains("\ndaemon commit  unknown\ndaemon source  packaged install\ndaemon started 2026-10-28T12:40:53.000Z\n"), "{stdout}");
    assert!(stdout.contains("\nrestart needed code on disk is newer than this daemon (ghost help self)\n"), "{stdout}");
}

// ── ghost say ───────────────────────────────────────────────────────────

/// A daemon with no conversations that plays `first` for a turn and `resumed` for a resumed stream.
fn turn_daemon(first: Vec<Value>, resumed: Vec<Value>) -> Fake {
    fake(move |request, responder| match (request.method.as_str(), request.path.as_str()) {
        ("GET", path) if path.ends_with("/stream") => events(responder, &resumed),
        ("GET", "/api/sessions") => responder.json(200, &json!({ "sessions": [] })),
        ("POST", "/api/messages") => events(responder, &first),
        _ => unexpected(responder),
    })
}

fn success_events() -> Vec<Value> {
    vec![
        json!({ "type": "start" }),
        json!({ "type": "pass" }),
        json!({ "type": "text_delta", "contentIndex": 0, "delta": "hel" }),
        json!({ "type": "text_delta", "contentIndex": 0, "delta": "lo " }),
        json!({ "type": "text_delta", "contentIndex": 0, "delta": "there" }),
        json!({ "type": "tool_execution_start", "id": "1", "toolName": "bash", "arguments": { "command": "pwd\nwhoami" }, "cwd": "/tmp" }),
        json!({ "type": "tool_execution_end", "id": "1", "toolName": "bash", "isError": false }),
        json!({ "type": "done", "usage": {} }),
    ]
}

fn posted(daemon: &Fake) -> Value {
    daemon.seen().into_iter().find(|request| request.path == "/api/messages").unwrap().body.unwrap()
}

fn is_new_cli_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    let lower = |text: &str, digits: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit() || digits.as_bytes().contains(&b));
    matches!(parts[..], ["cli", stamp, random] if lower(stamp, "abcdefghijklmnopqrstuvwxyz") && random.len() == 8 && lower(random, "abcdef"))
}

fn json_lines(text: &str) -> Vec<Value> {
    text.trim().split('\n').map(|line| serde_json::from_str(line).unwrap()).collect()
}

#[test]
fn say_prints_a_question_and_its_answers_as_the_reply() {
    let daemon = turn_daemon(
        vec![
            json!({ "type": "start" }),
            json!({ "type": "pass" }),
            json!({ "type": "tool_execution_start", "id": "1", "toolName": "ask", "arguments": { "question": "Which pier?", "options": ["North", "South"] }, "cwd": "/tmp" }),
            json!({ "type": "text_delta", "contentIndex": 0, "delta": "Which pier?\n\n1. North\n2. South" }),
            json!({ "type": "tool_execution_end", "id": "1", "toolName": "ask", "isError": false }),
            json!({ "type": "done", "usage": {} }),
        ],
        vec![],
    );
    let result = daemon.run(&["say", "book the boat", "--new"]);
    assert_eq!((result.code, result.stdout.as_str(), result.stderr.as_str()), (0, "Which pier?\n\n1. North\n2. South\n", "⚙ ask\n"));
}

#[test]
fn say_streams_text_reports_tool_activity_and_sends_a_new_raw_cli_id() {
    let daemon = turn_daemon(success_events(), vec![]);
    let result = daemon.run(&["say", "hello", "--new"]);
    assert_eq!((result.code, result.stdout.as_str(), result.stderr.as_str()), (0, "hello there\n", "⚙ bash: pwd\n"));
    let sent = posted(&daemon);
    assert_eq!(sent["prompt"], "hello");
    assert!(is_new_cli_id(sent["sessionId"].as_str().unwrap()), "{sent}");
    assert_eq!(daemon.lines(), ["POST /api/messages"]);
}

#[test]
fn say_joins_the_latest_conversation_or_starts_one_when_there_is_none() {
    let none = turn_daemon(success_events(), vec![]);
    assert_eq!(none.run(&["say", "hello", "there"]).code, 0);
    assert_eq!(none.lines(), ["GET /api/sessions", "POST /api/messages"]);
    assert_eq!(posted(&none)["prompt"], "hello there");
    assert!(is_new_cli_id(posted(&none)["sessionId"].as_str().unwrap()));

    let mut recent = session("conv-recent");
    recent["updatedAt"] = json!("2026-02-01T00:00:00.000Z");
    let listed = json!({ "sessions": [session("conv-old"), recent] });
    let some = fake(move |request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &listed),
        _ => events(responder, &[json!({ "type": "done" })]),
    });
    assert_eq!(some.run(&["say", "hi"]).code, 0);
    assert_eq!(posted(&some)["sessionId"], "conv-recent");
    assert_eq!(some.run(&["say", "hi", "-s", "conv-o"]).code, 0);
    assert_eq!(some.seen().last().unwrap().body.as_ref().unwrap()["sessionId"], "conv-old");
    // One no message has landed in yet is not listed, and is addressed as given.
    assert_eq!(some.run(&["say", "-s", "fresh-1", "-q", "hi"]).code, 0);
    assert_eq!(some.seen().last().unwrap().body.as_ref().unwrap()["sessionId"], "fresh-1");
    let ambiguous = some.run(&["say", "hi", "-s", "conv-"]);
    assert_eq!((ambiguous.code, ambiguous.stderr.as_str()), (2, "ghost: Session prefix \"conv-\" is ambiguous: conv-old, conv-recent\n"));
}

#[test]
fn say_follows_a_cut_turn_into_its_resumed_stream() {
    let first = vec![
        json!({ "type": "start" }),
        json!({ "type": "text_delta", "contentIndex": 0, "delta": "hel" }),
        json!({ "type": "resume", "turn": "turn-1", "from": 2 }),
    ];
    let resumed = vec![json!({ "type": "text_delta", "contentIndex": 0, "delta": "lo" }), json!({ "type": "done" })];
    let daemon = turn_daemon(first, resumed);
    let result = daemon.run(&["say", "hi", "--new"]);
    assert_eq!((result.code, result.stdout.as_str()), (0, "hello\n"));
    let resume = daemon.seen().into_iter().find(|request| request.path.ends_with("/stream")).unwrap();
    let id = posted(&daemon)["sessionId"].as_str().unwrap().to_string();
    assert_eq!((resume.method.as_str(), resume.path, resume.query.as_str()), ("GET", format!("/api/sessions/{id}/stream"), "turn=turn-1&from=2"));
}

#[test]
fn say_prints_an_owner_commands_output_the_turns_whole_answer() {
    let daemon = turn_daemon(
        vec![
            json!({ "type": "start" }),
            json!({ "type": "tool_execution_start", "id": "bash-1", "toolName": "bash", "arguments": { "command": "ls" }, "cwd": "/home/owner" }),
            json!({ "type": "tool_execution_update", "id": "bash-1", "summary": "a" }),
            json!({ "type": "tool_execution_end", "id": "bash-1", "toolName": "bash", "isError": true, "summary": "a\nb\nls: c: No such file" }),
            json!({ "type": "done" }),
        ],
        vec![],
    );
    let result = daemon.run(&["say", "!ls", "--new"]);
    assert_eq!((result.code, result.stdout.as_str()), (0, "a\nb\nls: c: No such file\n"));
    assert!(!result.stderr.contains('✗'));
    assert_eq!(daemon.run(&["say", "!ls", "--new", "-q"]).stdout, "a\nb\nls: c: No such file\n");
}

#[test]
fn say_reports_a_failed_tool_and_the_other_secondary_lines() {
    let daemon = turn_daemon(
        vec![
            json!({ "type": "pass" }),
            json!({ "type": "owner_message", "text": "and another thing" }),
            json!({ "type": "tool_execution_start", "id": "1", "toolName": "read", "arguments": { "path": "/x" } }),
            json!({ "type": "tool_execution_end", "id": "1", "toolName": "read", "isError": true, "summary": "no such file" }),
            json!({ "type": "session_stop_continued", "reason": "tests are red" }),
            json!({ "type": "done" }),
        ],
        vec![],
    );
    let result = daemon.run(&["say", "go", "--new"]);
    assert_eq!(result.stdout, "and another thing\nStop hook · tests are red\n");
    assert_eq!(result.stderr, "⚙ read: {\"path\":\"/x\"}\n✗ read: no such file\n");
    let quiet = daemon.run(&["say", "go", "--new", "-q"]);
    assert_eq!((quiet.code, quiet.stdout.as_str(), quiet.stderr.as_str()), (0, "", ""));
}

#[test]
fn say_starts_each_text_block_on_its_own_paragraph() {
    let daemon = turn_daemon(
        vec![
            json!({ "type": "start" }),
            json!({ "type": "pass" }),
            json!({ "type": "text_start", "contentIndex": 0 }),
            json!({ "type": "text_delta", "contentIndex": 0, "delta": "I'll check the log." }),
            json!({ "type": "tool_execution_start", "id": "1", "toolName": "bash", "arguments": { "command": "tail log" } }),
            json!({ "type": "tool_execution_end", "id": "1", "toolName": "bash", "isError": false }),
            json!({ "type": "text_start", "contentIndex": 1 }),
            json!({ "type": "text_delta", "contentIndex": 1, "delta": "It failed at 3am." }),
            json!({ "type": "done" }),
        ],
        vec![],
    );
    assert_eq!(daemon.run(&["say", "why", "--new", "-q"]).stdout, "I'll check the log.\n\nIt failed at 3am.\n");
    assert_eq!(daemon.run(&["say", "why", "--new"]).stdout, "I'll check the log.\n\nIt failed at 3am.\n");
}

#[test]
fn say_stops_the_turn_in_ghostd_on_ctrl_c_and_exits_interrupted() {
    let _alone = SIGNALS.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (opened, stopped) = (Abort::new(), Abort::new());
    let (turn_open, stop_seen) = (opened.clone(), stopped.clone());
    let daemon = fake(move |request, responder| {
        if request.path == "/api/messages" {
            let mut stream = responder.event_stream().unwrap();
            stream.write(&format!("data: {}\n\n", json!({ "type": "start" }))).unwrap();
            turn_open.abort();
            assert!(stop_seen.wait(Duration::from_secs(20)));
            stream.write(&format!("data: {}\n\n", json!({ "type": "error", "reason": "aborted", "errorMessage": "Turn aborted." }))).unwrap();
        } else {
            responder.json(200, &json!({}));
            stop_seen.abort();
        }
    });
    let result = std::thread::scope(|scope| {
        let running = scope.spawn(|| run_unlocked(ghost_cli, &["say", "hold on", "--new"], &daemon.env, &daemon.dir, terminal()));
        // The stream is open, so the command's handler is in place: the signal sets its flag and kills nothing.
        assert!(opened.wait(Duration::from_secs(20)));
        // SAFETY: raises a signal this process is handling.
        unsafe { libc::raise(libc::SIGINT) };
        running.join().unwrap()
    });
    assert_eq!((result.code, result.stderr.as_str()), (130, "ghost: Turn aborted.\n"));
    let id = posted(&daemon)["sessionId"].as_str().unwrap().to_string();
    let stop = daemon.seen().into_iter().find(|request| request.path.ends_with("/stop")).unwrap();
    assert_eq!((stop.line(), stop.body), (format!("POST /api/sessions/{id}/stop"), Some(json!({}))));
}

#[test]
fn stops_a_conversations_running_turn_with_ghost_stop() {
    let row = json!({ "id": "remote-1", "title": "Photo", "updatedAt": crate::clock::now_iso(), "messageCount": 2, "pinned": false, "unread": false, "running": true });
    let daemon = fake(move |request, responder| match request.path.as_str() {
        "/api/sessions" => responder.json(200, &json!({ "sessions": [row] })),
        _ => responder.json(200, &json!({ "stopped": true })),
    });
    let result = daemon.run(&["stop", "-s", "remote-1"]);
    assert_eq!((result.code, result.stdout.as_str()), (0, "Stopped remote-1.\n"));
    assert!(daemon.lines().contains(&"POST /api/sessions/remote-1/stop".to_string()));
}

#[test]
fn say_emits_every_event_as_one_json_line() {
    let daemon = turn_daemon(success_events(), vec![]);
    let result = daemon.run(&["say", "hello", "--new", "--json"]);
    assert_eq!((result.code, result.stderr.as_str()), (0, ""));
    assert_eq!(json_lines(&result.stdout), success_events());
}

#[test]
fn say_reads_piped_stdin() {
    let daemon = turn_daemon(success_events(), vec![]);
    let piped = run_with(&["say", "--new", "-q"], &daemon.env, &daemon.dir, Stdin::Text("from stdin".into()));
    assert_eq!(piped.code, 0);
    assert_eq!(posted(&daemon)["prompt"], "from stdin");
    let stream = Stdin::Stream { reader: Box::new(&b"from a pipe"[..]), is_tty: false };
    assert_eq!(run_with(&["say", "--new", "-q", "-"], &daemon.env, &daemon.dir, stream).code, 0);
    assert_eq!(daemon.seen().last().unwrap().body.as_ref().unwrap()["prompt"], "from a pipe");
}

#[test]
fn say_returns_one_for_an_error_event() {
    let failing = vec![json!({ "type": "start" }), json!({ "type": "error", "reason": "model", "errorMessage": "broken", "usage": {} })];
    let daemon = turn_daemon(failing.clone(), vec![]);
    let result = daemon.run(&["say", "hello", "--new"]);
    assert_eq!((result.code, result.stderr.as_str()), (1, "ghost: broken\n"));
    // JSON error events stay machine-readable, and the failure is still reported on stderr.
    let json = daemon.run(&["say", "hello", "--new", "--json"]);
    assert_eq!((json.code, json.stderr.as_str()), (1, "ghost: broken\n"));
    assert_eq!(json_lines(&json.stdout), failing);
}

#[test]
fn say_fails_a_stream_that_ends_without_a_terminal_event_or_is_refused() {
    let cut = turn_daemon(vec![json!({ "type": "text_delta", "delta": "half" })], vec![]).run(&["say", "hello", "--new"]);
    assert_eq!((cut.code, cut.stdout.as_str(), cut.stderr.as_str()), (1, "half", "ghost: turn stream ended without a terminal event\n"));
    let busy = fake(|_, responder| responder.json(409, &json!({ "error": { "code": "session_busy", "message": "A turn is already running." } })));
    let refused = busy.run(&["say", "hello", "--new"]);
    assert_eq!((refused.code, refused.stderr.as_str()), (6, "ghost: A turn is already running.\n"));
    let garbled = fake(|_, responder| responder.event_stream().unwrap().write("data: {not json\n\n").unwrap());
    let invalid = garbled.run(&["say", "hello", "--new"]);
    assert_eq!((invalid.code, invalid.stderr.as_str()), (1, "ghost: daemon sent invalid SSE JSON\n"));
}

// ── The daemon's verbs, its token, and a daemon that is gone ────────────

/// A daemon holding one conversation and a character, which checks the bearer token like ghostd.
fn guarded_daemon() -> Fake {
    let character = Mutex::new("# Casper\n".to_string());
    let daemon = fake(move |request, responder| {
        if request.authorization.as_deref() != Some(&format!("Bearer {}", "a".repeat(64))) {
            return responder.json(401, &json!({ "error": { "code": "unauthorized", "message": "Unauthorized." } }));
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/sessions") => responder.json(200, &json!({ "sessions": [session("conv-1")] })),
            ("GET", "/api/ghost") => responder.json(200, &json!({ "name": "casper", "dir": "/tmp/casper" })),
            ("GET", "/api/status") => {
                responder.json(200, &json!({ "version": "1", "source": { "commit": null, "root": null }, "startedAt": "x", "restartNeeded": false }))
            }
            ("GET", "/api/remote") => responder.json(200, &json!({ "state": "off", "hostname": null, "app": null, "problem": null })),
            ("GET", "/api/character") => responder.json(200, &json!({ "body": *character.lock().unwrap() })),
            ("PUT", "/api/character") => {
                *character.lock().unwrap() = request.body.as_ref().unwrap()["body"].as_str().unwrap().to_string();
                responder.json(200, &json!({ "ok": true }));
            }
            ("PUT", "/api/sessions/conv-1/read") | ("DELETE", "/api/sessions/conv-1") => responder.json(200, &json!({ "ok": true })),
            _ => responder.json(404, &json!({ "error": { "code": "not_found", "message": "Not found." } })),
        }
    });
    write_token(&daemon.token_file(), 'a');
    daemon
}

#[test]
fn lists_sessions_and_reports_status_with_the_token() {
    let daemon = guarded_daemon();
    let sessions = daemon.run(&["sessions", "--json"]);
    assert_eq!(sessions.code, 0, "{}", sessions.stderr);
    assert_eq!(serde_json::from_str::<Value>(&sessions.stdout).unwrap(), json!({ "sessions": [session("conv-1")] }));
    let quiet = daemon.run(&["sessions", "-q"]);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, "conv-1\n"));
    let unknown = daemon.run(&["sessions", "--ghost", "casper"]);
    assert_eq!(unknown.code, 2);
    assert!(unknown.stderr.contains("Unknown option '--ghost'"));
    let kept = daemon.run(&["sessions", "--keep"]);
    assert_eq!(kept.code, 2);
    assert!(kept.stderr.contains("keep"));

    let status: Value = serde_json::from_str(&daemon.run(&["status", "--json"]).stdout).unwrap();
    assert_eq!(status["daemon"], format!("http://127.0.0.1:{}", daemon.server.address.port()));
    assert_eq!(status["tokenFile"], daemon.token_file().display().to_string());
    assert_eq!((&status["ghost"], &status["version"]), (&json!("casper"), &json!(crate::VERSION)));
}

#[test]
fn reaches_ghost_admin_and_conversation_state_through_named_verbs() {
    let daemon = guarded_daemon();
    assert_eq!(daemon.run(&["character"]).stdout, "# Casper\n");
    let file = daemon.dir.join("character.md").display().to_string();
    std::fs::write(&file, "# Casper\n\nA quiet ghost.\n").unwrap();
    assert_eq!(daemon.run(&["character", "set", &file, "--json"]).stdout, "{\"ok\":true}\n");
    assert_eq!(daemon.run(&["character", "set", &file]).stdout, "Character replaced.\n");
    assert_eq!(daemon.run(&["character"]).stdout, "# Casper\n\nA quiet ghost.\n");

    let read = daemon.run(&["read", "-s", "conv", "--json"]);
    assert_eq!((read.code, read.stdout.as_str()), (0, "{\"ok\":true}\n"));
    assert!(daemon.lines().contains(&"PUT /api/sessions/conv-1/read".to_string()));
    let remote = daemon.run(&["remote"]);
    assert_eq!((remote.code, remote.stdout.as_str()), (0, "off\n"));
    let missing = daemon.run(&["read", "-s", "nope"]);
    assert_eq!((missing.code, missing.stderr.as_str()), (5, "ghost: session \"nope\" was not found\n"));
    let refused = daemon.run(&["title", "x", "-s", "conv-1"]);
    assert_eq!((refused.code, refused.stderr.as_str()), (5, "ghost: Not found.\n"));
}

#[test]
fn trashes_a_conversation_only_when_named_with_s_behind_yes() {
    let daemon = guarded_daemon();
    let unconfirmed = daemon.run(&["rm", "-s", "conv-1"]);
    assert_eq!((unconfirmed.code, unconfirmed.stderr.as_str()), (2, "ghost: ghost rm requires --yes\n"));
    let unnamed = daemon.run_env(&["rm", "--yes"], &[("GHOST_SESSION", "conv-1")]);
    assert_eq!((unnamed.code, unnamed.stderr.as_str()), (2, "ghost: ghost rm needs -s <id>\n"));
    assert_eq!(daemon.run(&["rm", "casper", "--yes"]).code, 2);
    assert!(daemon.seen().is_empty());
    let trashed = daemon.run(&["rm", "-s", "conv-1", "--yes"]);
    assert_eq!((trashed.code, trashed.stdout.as_str()), (0, "Trashed conv-1.\n"));
    assert_eq!(daemon.lines(), ["GET /api/sessions", "DELETE /api/sessions/conv-1"]);
}

#[test]
fn maps_a_wrong_token_to_exit_4_with_the_owner_hint() {
    let daemon = guarded_daemon();
    write_token(&daemon.token_file(), 'b');
    let result = daemon.run(&["status"]);
    let hint = format!("ghost: unauthorized; run `ghostd api-token` as the machine owner (token file: {})\n", daemon.token_file().display());
    assert_eq!((result.code, result.stderr), (4, hint));
    // Asked once, then once more with the token read again.
    assert_eq!(daemon.lines(), ["GET /api/ghost", "GET /api/ghost"]);
}

#[test]
fn re_reads_a_rotated_token_once_after_a_401() {
    let dir = scratch();
    let token_file = dir.join("rotated-token");
    write_token(&token_file, 'b');
    let rotate = token_file.clone();
    let daemon = fake(move |request, responder| {
        if request.authorization.as_deref() == Some(&format!("Bearer {}", "a".repeat(64))) {
            return responder.json(200, &json!({ "sessions": [session("conv-1")] }));
        }
        write_token(&rotate, 'a');
        responder.json(401, &json!({ "error": { "code": "unauthorized", "message": "Unauthorized." } }));
    });
    let result = daemon.run_env(&["sessions", "-q"], &[("GHOSTD_API_TOKEN_FILE", token_file.to_str().unwrap())]);
    assert_eq!((result.code, result.stdout.as_str(), result.stderr.as_str()), (0, "conv-1\n", ""));
    assert_eq!(daemon.seen().len(), 2);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn maps_a_closed_daemon_to_exit_3_and_other_refusals_to_their_codes() {
    let gone = offline(&["status"], &[]);
    assert_eq!(gone.code, 3);
    assert!(gone.stderr.starts_with("ghost: cannot reach ghostd: "), "{}", gone.stderr);
    for (status, code) in [(403, 4), (404, 5), (409, 6), (400, 1), (500, 1)] {
        let refused =
            fake(move |_, responder| responder.json(status, &json!({ "error": { "code": "x", "message": "Refused." } }))).run(&["sessions"]);
        assert_eq!((refused.code, refused.stderr.as_str()), (code, "ghost: Refused.\n"), "{status}");
    }
    let bare = fake(|_, responder| responder.empty(502)).run(&["sessions"]);
    assert_eq!((bare.code, bare.stderr.as_str()), (1, "ghost: daemon returned HTTP 502\n"));
    let config = offline(&["status"], &[("GHOSTD_PORT", "70000")]);
    assert_eq!(config.code, 2);
    assert!(config.stderr.starts_with("ghost: invalid daemon configuration: Invalid port from GHOSTD_PORT"), "{}", config.stderr);
}

// ── ghostd hook-complete ────────────────────────────────────────────────

fn hook_complete(daemon: &Fake, stdin: &str) -> Output {
    run_unlocked(hook_complete_command, &[], &daemon.env, &daemon.dir, Stdin::Text(stdin.to_string()))
}

#[test]
fn hook_complete_asks_its_own_daemon_and_prints_the_completion() {
    let daemon = answering(json!({ "text": "APPROVE" }));
    write_token(&daemon.token_file(), 'a');
    let result = hook_complete(&daemon, &json!({ "ghost_home": "/g/casper", "prompt": "Review this." }).to_string());
    assert_eq!((result.code, result.stdout.as_str(), result.stderr.as_str()), (0, "{\"text\":\"APPROVE\"}\n", ""));
    let asked = daemon.seen().remove(0);
    assert_eq!((asked.line().as_str(), asked.body), ("POST /api/complete", Some(json!({ "prompt": "Review this." }))));
    assert_eq!(asked.authorization, Some(format!("Bearer {}", "a".repeat(64))));
    let piped = Stdin::Stream { reader: Box::new(&b"{\"prompt\":\"Again.\"}"[..]), is_tty: false };
    assert_eq!(run_unlocked(hook_complete_command, &[], &daemon.env, &daemon.dir, piped).stdout, "{\"text\":\"APPROVE\"}\n");
}

#[test]
fn hook_complete_sets_no_deadline_of_its_own_so_the_hooks_timeout_bounds_the_call() {
    // Longer than a control request may take: only a call without a deadline gets the answer.
    let wait = super::client::CONTROL_REQUEST_TIMEOUT + Duration::from_millis(400);
    let daemon = fake(move |_, responder| {
        std::thread::sleep(wait);
        responder.json(200, &json!({ "text": "APPROVE" }));
    });
    let started = Instant::now();
    let result = hook_complete(&daemon, "{\"prompt\":\"Review this.\"}");
    assert_eq!((result.code, result.stdout.as_str()), (0, "{\"text\":\"APPROVE\"}\n"), "{}", result.stderr);
    assert!(started.elapsed() >= wait);
}

#[test]
fn hook_complete_fails_when_its_request_closes_or_the_daemon_refuses() {
    let closing = fake(|_, responder| drop(responder));
    let closed = hook_complete(&closing, "{\"prompt\":\"Review this.\"}");
    assert_eq!((closed.code, closed.stdout.as_str()), (1, ""));
    let refusing =
        fake(|_, responder| responder.json(502, &json!({ "error": { "code": "completion_failed", "message": "The model gave no answer." } })));
    let refused = hook_complete(&refusing, "{\"prompt\":\"Review this.\"}");
    assert_eq!((refused.code, refused.stderr.as_str()), (1, "The model gave no answer.\n"));
}

#[test]
fn hook_complete_rejects_bad_input_before_asking() {
    let daemon = answering(json!({ "text": "APPROVE" }));
    let empty = hook_complete(&daemon, "{\"prompt\":\"   \"}");
    assert_eq!((empty.code, empty.stderr.as_str()), (1, "prompt must be a non-empty string.\n"));
    assert_eq!(hook_complete(&daemon, "[]").stderr, "stdin must contain a JSON object.\n");
    let arguments = run_unlocked(hook_complete_command, &["--prompt", "x"], &daemon.env, &daemon.dir, Stdin::Text("{}".into()));
    assert_eq!((arguments.code, arguments.stderr.as_str()), (2, "hook-complete accepts JSON on stdin and no arguments.\n"));
    let flood = Stdin::Stream { reader: Box::new(std::io::repeat(b' ').take(1024 * 1024 + 1)), is_tty: false };
    assert_eq!(run_unlocked(hook_complete_command, &[], &daemon.env, &daemon.dir, flood).stderr, "stdin exceeds 1048576 bytes.\n");
    assert!(daemon.seen().is_empty());
}

#[test]
fn hook_complete_says_so_clearly_when_its_daemon_is_not_running() {
    let daemon = answering(json!({}));
    let port = daemon.server.address.port();
    // A port nothing listens on: bound, then released.
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mut env = daemon.env.clone();
    env.insert("GHOSTD_PORT".into(), free.to_string());
    assert_ne!(port, free);
    let result = run_unlocked(hook_complete_command, &[], &env, &daemon.dir, Stdin::Text("{\"prompt\":\"x\"}".into()));
    assert_eq!(result.code, 1);
    assert!(result.stderr.starts_with("cannot reach ghostd: "), "{}", result.stderr);
    assert!(result.stderr.ends_with(&format!(" at http://127.0.0.1:{free}; is it running? (systemctl --user status ghostd)\n")), "{}", result.stderr);
}

#[test]
fn hook_complete_takes_a_string_prompt_from_a_json_object_and_refuses_anything_else() {
    assert_eq!(parse_hook_complete_input("{\"ghost_home\":\"/g/casper\",\"prompt\":\"hi\",\"extra\":1}"), Ok("hi".to_string()));
    assert!(parse_hook_complete_input("not json").unwrap_err().starts_with("stdin is not valid JSON: "));
    assert_eq!(parse_hook_complete_input("[]").unwrap_err(), "stdin must contain a JSON object.");
    assert_eq!(parse_hook_complete_input("{\"ghost_home\":\"/g\",\"prompt\":7}").unwrap_err(), "stdin must contain a string prompt field.");
}
