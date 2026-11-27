//! The CLI against a scripted daemon: every test starts its own tiny server
//! on a free loopback port, with a scratch home, config path and token file,
//! and points the CLI at it through the runtime's environment.
use super::args::{ArgsSpec, Flag, parse_args};
use super::client::EXIT_CODES;
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

    /// Every request in order, each as its line and the JSON it carried.
    fn requests(&self) -> Vec<(String, Option<Value>)> {
        self.seen().into_iter().map(|request| (request.line(), request.body)).collect()
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

/// The conversation's row as ghostd sends it before anything is said.
fn empty_conversation() -> Value {
    json!({ "preview": null, "updatedAt": null, "messageCount": 0, "unread": false, "running": false, "question": null })
}

fn sent(line: &str, body: Value) -> (String, Option<Value>) {
    (line.to_string(), Some(body))
}

fn write_token(path: &Path, letter: char) {
    std::fs::write(path, format!("{}\n", letter.to_string().repeat(64))).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

// ── The conversation ────────────────────────────────────────────────────

#[test]
fn stop_stops_the_running_turn_in_a_sentence_and_q_prints_nothing() {
    let daemon = fake(|request, responder| match request.line().as_str() {
        "POST /api/conversation/stop" => responder.json(200, &json!({ "stopped": true })),
        _ => unexpected(responder),
    });
    let said = daemon.run(&["stop"]);
    assert_eq!((said.code, said.stdout.as_str()), (0, "Stopped.\n"));
    let quiet = daemon.run(&["stop", "-q"]);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""));
    let json = daemon.run(&["stop", "--json"]);
    assert_eq!((json.code, json.stdout.as_str()), (0, "{\"stopped\":true}\n"));
    assert_eq!(daemon.requests(), vec![sent("POST /api/conversation/stop", json!({})); 3]);
}

// Starting over is the one verb that discards something, so it asks nothing of the daemon until --yes is given.
#[test]
fn new_starts_over_only_behind_yes() {
    let daemon = fake(|request, responder| match request.line().as_str() {
        "DELETE /api/conversation" => responder.json(200, &json!({ "ok": true })),
        _ => unexpected(responder),
    });
    let unconfirmed = daemon.run(&["new"]);
    assert_eq!((unconfirmed.code, unconfirmed.stdout.as_str(), unconfirmed.stderr.as_str()), (2, "", "ghost: ghost new requires --yes\n"));
    assert_eq!(daemon.run(&["new", "--json", "-q"]).code, 2);
    assert_eq!(daemon.run(&["new", "casper", "--yes"]).stderr, "ghost: Usage: ghost new --yes [--json] [-q]\n");
    assert!(daemon.seen().is_empty());
    let started = daemon.run(&["new", "--yes"]);
    assert_eq!((started.code, started.stdout.as_str()), (0, "Started over; the conversation so far is in Trash.\n"));
    let quiet = daemon.run(&["new", "--yes", "-q"]);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""));
    let json = daemon.run(&["new", "--yes", "--json"]);
    assert_eq!((json.code, json.stdout.as_str()), (0, "{\"ok\":true}\n"));
    assert_eq!(daemon.requests(), vec![("DELETE /api/conversation".to_string(), None); 3]);
}

#[test]
fn new_exits_5_with_nothing_to_start_over_and_6_while_a_turn_runs() {
    let refusing = |status: u16, code: &'static str, message: &'static str| {
        let daemon = fake(move |_, responder| responder.json(status, &json!({ "error": { "code": code, "message": message } })));
        let result = daemon.run(&["new", "--yes"]);
        assert_eq!(daemon.lines(), ["DELETE /api/conversation"]);
        (result.code, result.stdout, result.stderr)
    };
    assert_eq!(refusing(404, "not_found", "There is no conversation."), (5, String::new(), "ghost: There is no conversation.\n".to_string()));
    assert_eq!(refusing(409, "conversation_busy", "A turn is running."), (6, String::new(), "ghost: A turn is running.\n".to_string()));
}

#[test]
fn turns_a_follow_up_with_no_turn_running_into_the_next_turn() {
    let daemon = fake(|request, responder| match request.line().as_str() {
        "POST /api/conversation/queue" => responder.json(409, &json!({ "error": { "code": "conversation_not_streaming", "message": "idle" } })),
        "POST /api/messages" => events(responder, &[json!({ "type": "text_delta", "delta": "Noted." }), json!({ "type": "done" })]),
        _ => unexpected(responder),
    });
    let result = daemon.run(&["say", "--follow-up", "-q", "job finished"]);
    assert_eq!((result.code, result.stdout.as_str()), (0, "Noted.\n"));
    assert_eq!(
        daemon.requests(),
        [sent("POST /api/conversation/queue", json!({ "text": "job finished" })), sent("POST /api/messages", json!({ "prompt": "job finished" }))]
    );
}

#[test]
fn acknowledges_a_follow_up_queued_into_a_live_turn_and_q_prints_nothing() {
    let daemon = fake(|request, responder| match request.line().as_str() {
        "POST /api/conversation/queue" => responder.json(200, &json!({ "streaming": true, "followUp": ["job finished"] })),
        _ => unexpected(responder),
    });
    let human = daemon.run(&["say", "--follow-up", "job finished"]);
    assert_eq!((human.code, human.stdout.as_str()), (0, "Queued.\n"));
    let quiet = daemon.run(&["say", "--follow-up", "-q", "job finished"]);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""));
    assert_eq!(daemon.requests(), vec![sent("POST /api/conversation/queue", json!({ "text": "job finished" })); 2]);
}

#[test]
fn show_prints_a_long_conversations_newest_page_and_says_which_messages_it_is() {
    let daemon = fake(|request, responder| {
        let parameter = |key: &str, fallback: i64| {
            request.query.split('&').find_map(|pair| pair.strip_prefix(&format!("{key}="))).map_or(fallback, |value| value.parse().unwrap())
        };
        let (total, limit, offset) = (5, parameter("limit", 1000), parameter("offset", 0));
        let messages: Vec<Value> = (offset..(offset + limit).min(total))
            .map(|index| json!({ "role": "user", "entryId": format!("e{index}"), "content": [{ "type": "text", "text": format!("message {}", index + 1) }] }))
            .collect();
        responder.json(200, &json!({ "truncated": (messages.len() as i64) < total, "messages": messages, "total": total, "readThrough": null }));
    });
    let queries = |daemon: &Fake| -> Vec<String> {
        let seen = std::mem::take(&mut *daemon.seen.lock().unwrap());
        seen.into_iter()
            .map(|request| {
                assert_eq!(request.line(), "GET /api/conversation/transcript");
                request.query
            })
            .collect()
    };
    let newest = daemon.run(&["show", "--limit", "2"]);
    assert_eq!(newest.code, 0);
    assert_eq!(queries(&daemon), ["limit=2", "limit=2&offset=3"]);
    assert_eq!(newest.stdout, "**you:**\n\nmessage 4\n\n**you:**\n\nmessage 5\n\n(messages 4–5 of 5; --offset/--limit for others)\n");

    let oldest = daemon.run(&["show", "--limit", "2", "--offset", "0"]);
    assert_eq!(queries(&daemon), ["limit=2&offset=0"]);
    assert!(oldest.stdout.contains("message 1"));
    assert!(oldest.stdout.contains("(messages 1–2 of 5; --offset/--limit for others)"));

    let whole = daemon.run(&["show"]);
    assert_eq!(queries(&daemon), [""]);
    assert!(!whole.stdout.contains("(messages"));

    let past = daemon.run(&["show", "--offset", "9"]);
    assert_eq!((past.code, past.stdout.as_str()), (0, "(no messages from 10; 5 in all)\n"));
    let quiet = daemon.run(&["show", "--offset", "9", "-q"]);
    assert_eq!((quiet.code, quiet.stdout.as_str()), (0, ""));
}

#[test]
fn show_renders_tool_calls_hook_messages_and_an_empty_conversation() {
    let daemon = answering(json!({ "total": 2, "truncated": false, "readThrough": null, "messages": [
        { "role": "assistant", "content": [{ "type": "text", "text": "On it." }, { "type": "thinking", "text": "List it.\nThen say." }, { "type": "toolCall", "name": "bash", "arguments": { "command": "ls" }, "output": "a.txt\n" }, { "type": "text", "text": "" }, { "type": "toolCall", "name": "ask", "arguments": { "question": "Which?", "options": ["A", "B"] } }, { "type": "text", "text": "Which?\n\n1. A\n2. B" }] },
        { "role": "hook", "content": [{ "type": "text", "text": "Not done." }] },
    ] }));
    let shown = daemon.run(&["show"]);
    assert_eq!(
        shown.stdout,
        "**ghost:**\n\nOn it.\n> List it.\n> Then say.\n```\n$ ls\na.txt\n```\n> ⚙ ask\nWhich?\n\n1. A\n2. B\n\n**Stop hook:**\n\nNot done.\n"
    );
    assert_eq!(daemon.lines(), ["GET /api/conversation/transcript"]);
    let empty = answering(json!({ "total": 0, "truncated": false, "readThrough": null, "messages": [] })).run(&["show"]);
    assert_eq!((empty.code, empty.stdout.as_str()), (0, "No messages.\n"));
}

#[test]
fn q_keeps_a_read_verbs_primary_output() {
    let daemon = fake(|request, responder| match request.path.as_str() {
        "/api/character" => responder.json(200, &json!({ "body": "# Casper\nFriendly.\n" })),
        "/api/conversation/transcript" => {
            let offset: i64 = request.query.split('&').find_map(|pair| pair.strip_prefix("offset=")).map_or(0, |value| value.parse().unwrap());
            let message = json!({ "role": "user", "entryId": format!("e{offset}"), "content": [{ "type": "text", "text": format!("message {}", offset + 1) }] });
            responder.json(200, &json!({ "messages": [message], "total": 3, "truncated": true, "readThrough": null }));
        }
        _ => unexpected(responder),
    });
    let show = daemon.run(&["show", "-q", "--limit", "1"]);
    assert_eq!((show.code, show.stdout.as_str()), (0, "**you:**\n\nmessage 3\n"));
    let character = daemon.run(&["character", "show", "-q"]);
    assert_eq!((character.code, character.stdout.as_str()), (0, "# Casper\nFriendly.\n"));
}

#[test]
fn still_fails_a_follow_up_on_any_other_conflict() {
    let daemon = fake(|request, responder| match request.line().as_str() {
        "POST /api/conversation/queue" => responder.json(409, &json!({ "error": { "code": "conversation_busy", "message": "busy" } })),
        _ => unexpected(responder),
    });
    let result = daemon.run(&["say", "--follow-up", "x"]);
    assert_eq!(Some(&(result.code, "busy or conflict")), EXIT_CODES.iter().find(|(_, meaning)| *meaning == "busy or conflict"));
    assert_eq!(result.stderr, "ghost: busy\n");
    assert_eq!(daemon.lines(), ["POST /api/conversation/queue"]);
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
fn parses_long_equals_long_value_boolean_and_terminator_forms() {
    let spec = ArgsSpec { boolean: vec![], value: vec!["limit", "offset"] };
    let parsed = parse_args(&strings(&["--offset=3", "--limit", "5", "--json", "--", "--literal"]), &spec).unwrap();
    assert_eq!(parsed.positionals, ["--literal"]);
    assert_eq!(parsed.flags, [("offset".to_string(), Flag::Text("3".into())), ("limit".into(), Flag::Text("5".into())), ("json".into(), Flag::On)]);
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
    assert!(parse_error(&["--limit", "--json"], &["limit"]).contains("'--limit' argument is ambiguous"));
    assert!(parse_error(&["--limit"], &["limit"]).contains("argument missing"));
    assert_eq!(parse_error(&["--limit="], &["limit"]), "--limit requires a value.");
    let parsed = parse_args(&strings(&["--q", "model", "-q"]), &ArgsSpec { boolean: vec![], value: vec!["q"] }).unwrap();
    assert!(parsed.positionals.is_empty());
    assert_eq!(parsed.flags, [("q".to_string(), Flag::Text("model".into())), ("quiet".into(), Flag::On)]);
}

/// The parser's established sentences, which scripts have seen.
#[test]
fn words_every_parse_error_as_the_first_cli_did() {
    let paging = &["limit", "offset"];
    assert_eq!(
        parse_error(&["-g", "x"], paging),
        "Unknown option '-g'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-g\""
    );
    assert_eq!(
        parse_error(&["--wat=1"], paging),
        "Unknown option '--wat'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--wat\""
    );
    assert!(parse_error(&["-qg"], paging).starts_with("Unknown option 'g'."));
    assert_eq!(
        parse_error(&["--limit", "-5"], paging),
        "Option '--limit' argument is ambiguous.\nDid you forget to specify the option argument for '--limit'?\nTo specify an option argument starting with a dash use '--limit=-XYZ'."
    );
    assert_eq!(parse_error(&["--limit"], paging), "Option '--limit <value>' argument missing");
    assert_eq!(parse_error(&["--help=x"], paging), "Option '-h, --help' does not take an argument");
    assert_eq!(parse_error(&["--json=true"], paging), "Option '--json' does not take an argument");
    let parse = |args: &[&str]| parse_args(&strings(args), &ArgsSpec { boolean: vec![], value: paging.to_vec() }).unwrap();
    let grouped = parse(&["-qh", "word", "--limit=-5", "--offset", "-", "--offset", "9"]);
    assert_eq!(grouped.positionals, ["word"]);
    assert!(grouped.boolean("quiet") && grouped.boolean("help"));
    assert_eq!((grouped.text("offset"), grouped.text("limit")), (Some("9"), Some("-5")));
    assert_eq!(parse(&["--limit=a=b"]).text("limit"), Some("a=b"));
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
fn help_is_available_without_contacting_the_daemon_for_every_command() {
    for command in commands() {
        let result = offline(&[command.doc.verb, "--help"], &[]);
        assert_eq!(result.code, 0, "{}", command.doc.verb);
        assert!(result.stdout.starts_with(&format!("Usage: ghost {}", command.doc.verb)), "{}", result.stdout);
    }
    let say = offline(&["say", "-h"], &[]);
    assert_eq!(
        say.stdout,
        "Usage: ghost say [text] [--follow-up] [--json] [-q]\n\nSend a turn, or follow up on the running one.\n\nExample: ghost say \"What is on today?\"\n"
    );
    let new = offline(&["new", "--help"], &[]);
    assert_eq!(
        new.stdout,
        "Usage: ghost new --yes [--json] [-q]\n\nStart over: move the conversation to recoverable Trash.\n\nExample: ghost new --yes\n"
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
    assert!(bare.stdout.contains(&format!("\n  {:<widest$}  Stop the running turn.\n", "stop [--json] [-q]")), "{}", bare.stdout);
    assert!(
        bare.stdout.contains(&format!("\n  {:<widest$}  Send a turn, or follow up on the running one.\n", "say [text] [--follow-up] [--json] [-q]"))
    );
    assert!(bare.stdout.contains(&format!("\n  {:<widest$}  Start over: move the conversation to recoverable Trash.\n", "new --yes [--json] [-q]")));
    let listed = bare.stdout.split_once("\nCommands:\n").unwrap().1.split_once("\n\n").unwrap().0;
    let verbs: Vec<&str> = listed.lines().map(|line| line.split_whitespace().next().unwrap()).collect();
    assert_eq!(verbs, ["say", "stop", "show", "new", "hooks", "character", "status", "help"]);
    assert!(bare.stdout.contains("\n  -v, --version            Show the ghost package version\n"));
    assert!(bare.stdout.ends_with("answered by a model on this machine); ghost talks to the ghost.\n"));
}

#[test]
fn refuses_a_malformed_verb_before_asking_the_daemon_anything() {
    let daemon = fake(|_, responder| unexpected(responder));
    let cases: [&[&str]; 12] = [
        &["ask"],
        &["ask", "--clear", "Ship it?"],
        &["character", "edit"],
        &["character", "set"],
        &["hooks", "show", "extra"],
        &["character", "show", "extra"],
        &["say", "hello", "-m", "world"],
        &["say", "--follow-up"],
        &["say"],
        &["show", "extra"],
        &["new", "extra", "--yes"],
        &["status", "extra"],
    ];
    for args in cases {
        let result = daemon.run(args);
        assert_eq!(result.code, 2, "{args:?}: {}", result.stderr);
    }
    assert!(daemon.seen().is_empty());
    assert_eq!(daemon.run(&["stop", "now"]).stderr, "ghost: Usage: ghost stop [--json] [-q]\n");
    assert_eq!(daemon.run(&["say"]).stderr, "ghost: Message text cannot be empty.\n");
    assert_eq!(daemon.run(&["hooks", "edit"]).stderr, "ghost: ghost hooks does not know \"edit\"; use status, show, or set.\n");
}

// There is one conversation and one ghost, so no verb takes a flag naming either.
#[test]
fn refuses_s_session_new_and_g_as_unknown_options_on_every_verb() {
    let daemon = fake(|_, responder| unexpected(responder));
    let verbs = ["say hi", "stop", "show", "new --yes", "hooks", "character", "status", "help memory"];
    let flags: [&[&str]; 5] = [&["-s", "conv-1"], &["--session", "conv-1"], &["--session=conv-1"], &["--new"], &["-g", "casper"]];
    for (verb, flag) in verbs.iter().flat_map(|verb| flags.iter().map(move |flag| (verb, flag))) {
        let args = [verb.split(' ').collect(), flag.to_vec()].concat();
        let result = daemon.run(&args);
        let named = flag[0].split('=').next().unwrap();
        assert_eq!(result.code, 2, "{args:?}");
        assert!(result.stderr.starts_with(&format!("ghost: Unknown option '{named}'. ")), "{args:?}: {}", result.stderr);
    }
    assert!(daemon.seen().is_empty());
    assert_eq!(
        daemon.run(&["say", "hi", "-s", "conv-1"]).stderr,
        "ghost: Unknown option '-s'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-s\"\n"
    );
    assert_eq!(
        daemon.run(&["say", "--new", "hi"]).stderr,
        "ghost: Unknown option '--new'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--new\"\n"
    );
}

#[test]
fn refuses_another_verbs_flag_on_a_verb_whose_usage_does_not_list_it() {
    let daemon = fake(|_, responder| unexpected(responder));
    let cases: [(&[&str], &str); 5] = [
        (&["stop", "--yes"], "--yes"),
        (&["status", "--follow-up"], "--follow-up"),
        (&["say", "hi", "--limit", "5"], "--limit"),
        (&["character", "--offset=2"], "--offset"),
        (&["show", "--yes"], "--yes"),
    ];
    for (args, flag) in cases {
        let result = daemon.run(args);
        assert_eq!(result.code, 2, "{args:?}");
        assert!(result.stderr.starts_with(&format!("ghost: Unknown option '{flag}'. ")), "{args:?}: {}", result.stderr);
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
    let verbs: [&[&str]; 11] = [
        &["list"],
        &["use", "casper"],
        &["rename", "wisp"],
        &["browser"],
        &["browser", "allow"],
        &["sessions"],
        &["rm", "--yes"],
        &["title", "Release notes"],
        &["pin"],
        &["unpin"],
        &["read"],
    ];
    for verb in verbs {
        let result = offline(verb, &[]);
        assert_eq!((result.code, result.stderr), (2, format!("ghost: Unknown command: {}\n", verb[0])));
    }
}

// ── How the CLI reads the API ───────────────────────────────────────────

fn answering(body: Value) -> Fake {
    fake(move |_, responder| responder.json(200, &body))
}

fn hooks_document() -> Value {
    json!({ "hooks": {
        "session_stop": [{ "hooks": [
            { "type": "command", "command": "/bin/true", "name": "Review", "description": "Reviews the pass." },
            { "type": "command", "command": "/bin/true" },
        ] }],
    } })
}

#[test]
fn hooks_status_prints_each_hooks_event_name_and_description() {
    let daemon = answering(json!({ "path": "/home/owner/.config/ghost/hooks.json", "document": hooks_document() }));
    assert_eq!(
        daemon.run(&["hooks"]).stdout,
        "EVENT         NAME                       DESCRIPTION\n\
         session_stop  Review                     Reviews the pass.\n\
         session_stop  Session-stop command hook  Runs after the assistant pass and may continue it.\n"
    );
    assert_eq!(daemon.run(&["hooks", "status", "-q"]).stdout, "Review\nSession-stop command hook\n");
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
    assert_eq!(refused(json!({ "hooks": { "turn_end": [] } })), "ghost: /h.json: unsupported hook event \"turn_end\".\n");
    assert_eq!(refused(json!({ "hooks": { "session_stop": {} } })), "ghost: /h.json: \"hooks.session_stop\" must be an array.\n");
    assert_eq!(
        refused(json!({ "hooks": { "session_stop": [{ "hooks": [{ "type": "command", "command": " " }] }] } })),
        "ghost: /h.json: hooks.session_stop[0].hooks[0] must be a command hook with a non-empty NUL-free command.\n"
    );
    assert_eq!(
        refused(json!({ "hooks": { "session_stop": [{ "hooks": [{ "type": "command", "command": "x", "timeout": 601 }] }] } })),
        "ghost: /h.json: hooks.session_stop[0].hooks[0].timeout must be a number in (0, 600].\n"
    );
    assert_eq!(
        refused(json!({ "hooks": { "session_stop": [{ "hooks": [{ "type": "command", "command": "x", "name": "" }] }] } })),
        "ghost: /h.json: hooks.session_stop[0].hooks[0].name must be a non-empty string of at most 80 characters.\n"
    );
}

#[test]
fn hooks_set_acknowledges_in_words_json_keeps_the_api_body_and_q_prints_nothing() {
    let document = json!({ "hooks": { "session_stop": [{ "hooks": [{ "type": "command", "command": "/bin/true" }, { "type": "command", "command": "/bin/false" }] }] } });
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

const SERVE_COMMAND: &str = "tailscale serve --bg --https=443 http://127.0.0.1:7717";

/// A daemon answering `ghost status`'s four reads, `/api/status` with `daemon`, while Tailscale is stopped.
fn status_daemon(ghost: Value, daemon: Value, conversation: Value) -> Fake {
    let stopped = json!({ "state": "unavailable", "hostname": null, "guests": "read-only", "owner": null, "app": null, "command": SERVE_COMMAND,
        "problem": { "code": "tailscale_stopped", "message": "Tailscale is not running." } });
    status_daemon_with(ghost, daemon, stopped, conversation)
}

fn status_daemon_with(ghost: Value, daemon: Value, remote: Value, conversation: Value) -> Fake {
    fake(move |request, responder| match request.line().as_str() {
        "GET /api/ghost" => responder.json(200, &ghost),
        "GET /api/status" => responder.json(200, &daemon),
        "GET /api/remote" => responder.json(200, &remote),
        "GET /api/conversation" => responder.json(200, &conversation),
        _ => responder.json(404, &json!({ "error": { "code": "not_found", "message": "Not found." } })),
    })
}

// Remote access is Tailscale Serve, the owner's to turn on: status names the
// command while it is off, and the app's link to this machine once it is on.
#[test]
fn status_names_tailscales_command_while_serve_is_off_and_the_app_link_once_it_is_on() {
    let running =
        json!({ "version": "1.4.0", "source": { "commit": null, "root": null }, "startedAt": "2026-10-28T12:40:53.000Z", "restartNeeded": false });
    let app = |url: Value| json!({ "origin": "https://summonghost.com", "url": url });
    let off = json!({ "state": "off", "hostname": "box.tail.ts.net", "app": app(Value::Null), "command": SERVE_COMMAND, "problem": null });
    let stdout = status_daemon_with(json!({ "name": "casper" }), running.clone(), off, empty_conversation()).run(&["status"]).stdout;
    assert!(stdout.ends_with(&format!("\nremote         off; turn on: {SERVE_COMMAND}\nconversation   empty\n")), "{stdout}");
    let on = json!({ "state": "on", "hostname": "box.tail.ts.net", "app": app(json!("https://summonghost.com/#add=box.tail.ts.net")),
        "command": SERVE_COMMAND, "problem": null });
    let stdout = status_daemon_with(json!({ "name": "casper" }), running, on, empty_conversation()).run(&["status"]).stdout;
    assert!(
        stdout.ends_with("\nremote         on box.tail.ts.net\napp            https://summonghost.com/#add=box.tail.ts.net\nconversation   empty\n"),
        "{stdout}"
    );
}

#[test]
fn reports_the_running_daemons_version_commit_source_root_and_remote_access() {
    let source = json!({ "commit": "0123456789abcdef0123456789abcdef01234567", "root": "/home/owner/src/ghost" });
    let running = json!({ "version": "1.4.0", "source": source, "startedAt": "2026-10-28T12:40:53.000Z", "restartNeeded": false });
    let daemon = status_daemon(json!({ "name": "casper" }), running, empty_conversation());
    let response = daemon.run_env(&["status"], &[("GHOSTD_VERSION", "3.2.1")]);
    let (url, token) = (format!("http://127.0.0.1:{}", daemon.server.address.port()), daemon.token_file().display().to_string());
    assert_eq!(
        response.stdout,
        format!(
            "daemon         {url}\ntoken file     {token}\nghost          casper\nversion        3.2.1\ndaemon version 1.4.0\n\
             daemon commit  0123456789abcdef0123456789abcdef01234567\ndaemon source  /home/owner/src/ghost\n\
             daemon started 2026-10-28T12:40:53.000Z\nremote         unavailable (Tailscale is not running.)\nconversation   empty\n"
        )
    );
    assert_eq!(daemon.lines(), ["GET /api/ghost", "GET /api/remote", "GET /api/status", "GET /api/conversation"]);
    assert_eq!(daemon.run(&["status", "-q"]).stdout, "ok\n");
    let json: Value = serde_json::from_str(&daemon.run_env(&["status", "--json"], &[("GHOSTD_VERSION", "3.2.1")]).stdout).unwrap();
    let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        ["daemon", "tokenFile", "ghost", "version", "daemonVersion", "source", "daemonStartedAt", "restartNeeded", "remote", "conversation"]
    );
    assert_eq!(
        (&json["daemon"], &json["tokenFile"], &json["ghost"], &json["version"]),
        (&json!(url), &json!(token), &json!("casper"), &json!("3.2.1"))
    );
    assert_eq!((&json["daemonVersion"], &json["source"], &json["restartNeeded"]), (&json!("1.4.0"), &source, &json!(false)));
    assert_eq!(json["remote"]["state"], "unavailable");
    assert_eq!(json["conversation"], empty_conversation());
}

// An update that was not restarted into still answers under the same
// version; status says so, and points at the safe way to restart.
#[test]
fn says_when_the_code_on_disk_is_newer_than_the_running_daemon() {
    let running =
        json!({ "version": "1.4.0", "source": { "commit": null, "root": null }, "startedAt": "2026-10-28T12:40:53.000Z", "restartNeeded": true });
    let stdout = status_daemon(json!([]), running, empty_conversation()).run(&["status"]).stdout;
    assert!(stdout.contains("\nghost          —\n"), "{stdout}");
    assert!(stdout.contains("\ndaemon commit  unknown\ndaemon source  packaged install\ndaemon started 2026-10-28T12:40:53.000Z\n"), "{stdout}");
    assert!(stdout.contains("\nrestart needed code on disk is newer than this daemon (ghost help self)\n"), "{stdout}");
}

// The last line is the conversation: its length, then when it last moved,
// then what it waits on, running before asking before unread.
#[test]
fn status_says_how_long_the_conversation_is_when_it_moved_and_what_it_waits_on() {
    let running =
        json!({ "version": "1.4.0", "source": { "commit": null, "root": null }, "startedAt": "2026-10-28T12:40:53.000Z", "restartNeeded": false });
    let status = |conversation: &Value, args: &[&str]| {
        let result = status_daemon(json!({ "name": "casper" }), running.clone(), conversation.clone()).run(args);
        assert_eq!((result.code, result.stderr.as_str()), (0, ""));
        result.stdout
    };
    let last_line = |conversation: &Value| {
        let stdout = status(conversation, &["status"]);
        let (before, line) = stdout.trim_end_matches('\n').rsplit_once('\n').unwrap();
        assert!(before.ends_with("\nremote         unavailable (Tailscale is not running.)"), "{stdout}");
        line.to_string()
    };
    let ago = |minutes: i64| json!(crate::clock::iso(crate::clock::now_ms() - minutes * 60_000));
    let row = |count: u64, updated: Value, running: bool, question: Value, unread: bool| json!({ "preview": "Ship it?", "updatedAt": updated, "messageCount": count, "unread": unread, "running": running, "question": question });
    let question = json!({ "text": "Ship it?", "options": ["Yes", "No"], "askedAt": "2026-11-26T09:00:00.000Z" });

    assert_eq!(last_line(&empty_conversation()), "conversation   empty");
    assert_eq!(last_line(&row(1, ago(0), false, Value::Null, false)), "conversation   1 message, updated now");
    let busy = row(12, ago(150), true, question.clone(), true);
    assert_eq!(last_line(&busy), "conversation   12 messages, updated 2h, running, asking, unread");
    assert_eq!(last_line(&row(2, ago(3 * 24 * 60 + 5), false, Value::Null, true)), "conversation   2 messages, updated 3d, unread");
    assert_eq!(last_line(&row(4, ago(7), false, question, false)), "conversation   4 messages, updated 7m, asking");
    assert_eq!(last_line(&row(3, ago(0), true, Value::Null, false)), "conversation   3 messages, updated now, running");

    // --json carries the row as ghostd sent it; -q stays the one word.
    assert_eq!(serde_json::from_str::<Value>(&status(&busy, &["status", "--json"])).unwrap()["conversation"], busy);
    assert_eq!(status(&busy, &["status", "-q"]), "ok\n");
}

// ── ghost say ───────────────────────────────────────────────────────────

/// A daemon that plays `first` for a turn and `resumed` for a resumed stream.
fn turn_daemon(first: Vec<Value>, resumed: Vec<Value>) -> Fake {
    fake(move |request, responder| match request.line().as_str() {
        "GET /api/conversation/stream" => events(responder, &resumed),
        "POST /api/messages" => events(responder, &first),
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
    let result = daemon.run(&["say", "book the boat"]);
    assert_eq!((result.code, result.stdout.as_str(), result.stderr.as_str()), (0, "Which pier?\n\n1. North\n2. South\n", "⚙ ask\n"));
}

// The turn is the only request: nothing is listed first and no conversation is named, there being one.
#[test]
fn say_streams_text_reports_tool_activity_and_posts_the_prompt_alone() {
    let daemon = turn_daemon(success_events(), vec![]);
    let result = daemon.run(&["say", "hello", "there"]);
    assert_eq!((result.code, result.stdout.as_str(), result.stderr.as_str()), (0, "hello there\n", "$ pwd\nwhoami\n"));
    assert_eq!(daemon.requests(), [sent("POST /api/messages", json!({ "prompt": "hello there" }))]);
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
    let result = daemon.run(&["say", "hi"]);
    assert_eq!((result.code, result.stdout.as_str()), (0, "hello\n"));
    assert_eq!(daemon.requests(), [sent("POST /api/messages", json!({ "prompt": "hi" })), ("GET /api/conversation/stream".to_string(), None)]);
    assert_eq!(daemon.seen()[1].query, "turn=turn-1&from=2");
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
    let result = daemon.run(&["say", "!ls"]);
    assert_eq!((result.code, result.stdout.as_str()), (0, "a\nb\nls: c: No such file\n"));
    assert!(!result.stderr.contains('✗'));
    assert_eq!(daemon.run(&["say", "!ls", "-q"]).stdout, "a\nb\nls: c: No such file\n");
}

#[test]
fn say_reports_a_failed_tool_and_the_other_secondary_lines() {
    let daemon = turn_daemon(
        vec![
            json!({ "type": "pass" }),
            json!({ "type": "owner_message", "text": "and another thing" }),
            json!({ "type": "thinking", "delta": "It should " }),
            json!({ "type": "thinking", "delta": "be there." }),
            json!({ "type": "tool_execution_start", "id": "1", "toolName": "bash", "arguments": { "command": "cat /x\nls /" } }),
            json!({ "type": "tool_execution_end", "id": "1", "toolName": "bash", "isError": true, "summary": "no such file", "output": "cat: /x: no such file\n(exit 1)\n" }),
            json!({ "type": "session_stop_continued", "reason": "tests are red" }),
            json!({ "type": "done" }),
        ],
        vec![],
    );
    let result = daemon.run(&["say", "go"]);
    assert_eq!(result.stdout, "and another thing\nStop hook · tests are red\n");
    // Nothing is held back: the reasoning, the whole command, and all it printed.
    assert_eq!(result.stderr, "It should be there.\n$ cat /x\nls /\ncat: /x: no such file\n(exit 1)\n✗ bash\n");
    let quiet = daemon.run(&["say", "go", "-q"]);
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
    assert_eq!(daemon.run(&["say", "why", "-q"]).stdout, "I'll check the log.\n\nIt failed at 3am.\n");
    assert_eq!(daemon.run(&["say", "why"]).stdout, "I'll check the log.\n\nIt failed at 3am.\n");
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
        let running = scope.spawn(|| run_unlocked(ghost_cli, &["say", "hold on"], &daemon.env, &daemon.dir, terminal()));
        // The stream is open, so the command's handler is in place: the signal sets its flag and kills nothing.
        assert!(opened.wait(Duration::from_secs(20)));
        // SAFETY: raises a signal this process is handling.
        unsafe { libc::raise(libc::SIGINT) };
        running.join().unwrap()
    });
    assert_eq!((result.code, result.stderr.as_str()), (130, "ghost: Turn aborted.\n"));
    assert_eq!(daemon.requests(), [sent("POST /api/messages", json!({ "prompt": "hold on" })), sent("POST /api/conversation/stop", json!({}))]);
}

#[test]
fn say_emits_every_event_as_one_json_line() {
    let daemon = turn_daemon(success_events(), vec![]);
    let result = daemon.run(&["say", "hello", "--json"]);
    assert_eq!((result.code, result.stderr.as_str()), (0, ""));
    assert_eq!(json_lines(&result.stdout), success_events());
}

#[test]
fn say_reads_piped_stdin() {
    let daemon = turn_daemon(success_events(), vec![]);
    let piped = run_with(&["say", "-q"], &daemon.env, &daemon.dir, Stdin::Text("from stdin".into()));
    assert_eq!(piped.code, 0);
    assert_eq!(posted(&daemon)["prompt"], "from stdin");
    let stream = Stdin::Stream { reader: Box::new(&b"from a pipe"[..]), is_tty: false };
    assert_eq!(run_with(&["say", "-q", "-"], &daemon.env, &daemon.dir, stream).code, 0);
    assert_eq!(daemon.seen().last().unwrap().body.as_ref().unwrap()["prompt"], "from a pipe");
}

#[test]
fn say_returns_one_for_an_error_event() {
    let failing = vec![json!({ "type": "start" }), json!({ "type": "error", "reason": "model", "errorMessage": "broken", "usage": {} })];
    let daemon = turn_daemon(failing.clone(), vec![]);
    let result = daemon.run(&["say", "hello"]);
    assert_eq!((result.code, result.stderr.as_str()), (1, "ghost: broken\n"));
    // JSON error events stay machine-readable, and the failure is still reported on stderr.
    let json = daemon.run(&["say", "hello", "--json"]);
    assert_eq!((json.code, json.stderr.as_str()), (1, "ghost: broken\n"));
    assert_eq!(json_lines(&json.stdout), failing);
}

#[test]
fn say_fails_a_stream_that_ends_without_a_terminal_event_or_is_refused() {
    let cut = turn_daemon(vec![json!({ "type": "text_delta", "delta": "half" })], vec![]).run(&["say", "hello"]);
    assert_eq!((cut.code, cut.stdout.as_str(), cut.stderr.as_str()), (1, "half", "ghost: turn stream ended without a terminal event\n"));
    let busy =
        fake(|_, responder| responder.json(409, &json!({ "error": { "code": "conversation_busy", "message": "A turn is already running." } })));
    let refused = busy.run(&["say", "hello"]);
    assert_eq!((refused.code, refused.stderr.as_str()), (6, "ghost: A turn is already running.\n"));
    let garbled = fake(|_, responder| responder.event_stream().unwrap().write("data: {not json\n\n").unwrap());
    let invalid = garbled.run(&["say", "hello"]);
    assert_eq!((invalid.code, invalid.stderr.as_str()), (1, "ghost: daemon sent invalid SSE JSON\n"));
}

// ── The daemon's verbs, its token, and a daemon that is gone ────────────

/// A daemon holding a character and an empty conversation, which checks the bearer token like ghostd.
fn guarded_daemon() -> Fake {
    let character = Mutex::new("# Casper\n".to_string());
    let daemon = fake(move |request, responder| {
        if request.authorization.as_deref() != Some(&format!("Bearer {}", "a".repeat(64))) {
            return responder.json(401, &json!({ "error": { "code": "unauthorized", "message": "Unauthorized." } }));
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/ghost") => responder.json(200, &json!({ "name": "casper", "dir": "/tmp/casper" })),
            ("GET", "/api/status") => {
                responder.json(200, &json!({ "version": "1", "source": { "commit": null, "root": null }, "startedAt": "x", "restartNeeded": false }))
            }
            ("GET", "/api/remote") => responder.json(200, &json!({ "state": "off", "hostname": null, "app": null, "problem": null })),
            ("GET", "/api/conversation") => responder.json(200, &empty_conversation()),
            ("GET", "/api/character") => responder.json(200, &json!({ "body": *character.lock().unwrap() })),
            ("PUT", "/api/character") => {
                *character.lock().unwrap() = request.body.as_ref().unwrap()["body"].as_str().unwrap().to_string();
                responder.json(200, &json!({ "ok": true }));
            }
            _ => responder.json(404, &json!({ "error": { "code": "not_found", "message": "Not found." } })),
        }
    });
    write_token(&daemon.token_file(), 'a');
    daemon
}

#[test]
fn reports_status_with_the_token() {
    let daemon = guarded_daemon();
    let unknown = daemon.run(&["status", "--ghost", "casper"]);
    assert_eq!(unknown.code, 2);
    assert!(unknown.stderr.contains("Unknown option '--ghost'"));
    let kept = daemon.run(&["status", "--keep"]);
    assert_eq!(kept.code, 2);
    assert!(kept.stderr.contains("keep"));

    let status: Value = serde_json::from_str(&daemon.run(&["status", "--json"]).stdout).unwrap();
    assert_eq!(status["daemon"], format!("http://127.0.0.1:{}", daemon.server.address.port()));
    assert_eq!(status["tokenFile"], daemon.token_file().display().to_string());
    assert_eq!((&status["ghost"], &status["version"]), (&json!("casper"), &json!(crate::VERSION)));
    assert_eq!(status["conversation"], empty_conversation());
}

#[test]
fn prints_and_replaces_the_character_through_its_verb() {
    let daemon = guarded_daemon();
    assert_eq!(daemon.run(&["character"]).stdout, "# Casper\n");
    let file = daemon.dir.join("character.md").display().to_string();
    std::fs::write(&file, "# Casper\n\nA quiet ghost.\n").unwrap();
    assert_eq!(daemon.run(&["character", "set", &file, "--json"]).stdout, "{\"ok\":true}\n");
    assert_eq!(daemon.run(&["character", "set", &file]).stdout, "Character replaced.\n");
    assert_eq!(daemon.run(&["character"]).stdout, "# Casper\n\nA quiet ghost.\n");

    let refused = daemon.run(&["hooks"]);
    assert_eq!((refused.code, refused.stderr.as_str()), (5, "ghost: Not found.\n"));
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
            return responder.json(200, &json!({ "body": "# Casper\n" }));
        }
        write_token(&rotate, 'a');
        responder.json(401, &json!({ "error": { "code": "unauthorized", "message": "Unauthorized." } }));
    });
    let result = daemon.run_env(&["character", "-q"], &[("GHOSTD_API_TOKEN_FILE", token_file.to_str().unwrap())]);
    assert_eq!((result.code, result.stdout.as_str(), result.stderr.as_str()), (0, "# Casper\n", ""));
    assert_eq!(daemon.lines(), ["GET /api/character"; 2]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn maps_a_closed_daemon_to_exit_3_and_other_refusals_to_their_codes() {
    let gone = offline(&["status"], &[]);
    assert_eq!(gone.code, 3);
    assert!(gone.stderr.starts_with("ghost: cannot reach ghostd: "), "{}", gone.stderr);
    for (status, code) in [(403, 4), (404, 5), (409, 6), (400, 1), (500, 1)] {
        let refused = fake(move |_, responder| responder.json(status, &json!({ "error": { "code": "x", "message": "Refused." } }))).run(&["stop"]);
        assert_eq!((refused.code, refused.stderr.as_str()), (code, "ghost: Refused.\n"), "{status}");
    }
    let bare = fake(|_, responder| responder.empty(502)).run(&["stop"]);
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
