use super::*;
use crate::log::{Level, Record};
use std::sync::Arc;
use std::time::Instant;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ghost-hooks-{}", crate::random::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    /// Write `hooks.json` (or another name) and return its path.
    fn config(&self, name: &str, document: &Value) -> PathBuf {
        let path = self.path(name);
        std::fs::write(&path, document.to_string()).unwrap();
        path
    }
    /// Write a script and return it quoted for a command line.
    fn script(&self, name: &str, body: &str) -> String {
        let path = self.path(name);
        std::fs::write(&path, body).unwrap();
        quote(&path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A path as one bash word. Scratch paths hold no single quote.
fn quote(path: &Path) -> String {
    format!("'{}'", path.display())
}

fn here() -> PathBuf {
    std::env::current_dir().unwrap()
}

fn base(kind: &str, cwd: &Path) -> Value {
    json!({
        "type": kind,
        "turn_id": "turn-1",
        "transcript_path": here().join(".conversation.jsonl").to_string_lossy(),
        "ghost_name": "casper",
        "ghost_home": here().to_string_lossy(),
        "cwd": cwd.to_string_lossy(),
    })
}

fn stop_event_in(cwd: &Path, abort: &Abort, extra: Value) -> HookEvent {
    let mut payload = base("session_stop", cwd);
    let fields = json!({ "owner_prompt": "Continue", "messages": [], "last_assistant_message": null, "stop_hook_active": false });
    for (key, value) in fields.as_object().unwrap().iter().chain(extra.as_object().unwrap()) {
        payload[key] = value.clone();
    }
    HookEvent { payload, cwd: cwd.to_path_buf(), abort: abort.clone() }
}

fn stop_event() -> HookEvent {
    stop_event_in(&here(), &Abort::new(), json!({}))
}

fn configured(path: &Path) -> HookRunner {
    HookRunner::from_config(path, Logger::silent(), crate::env::current()).unwrap()
}

fn load_error(path: &Path) -> String {
    HookRunner::from_config(path, Logger::silent(), crate::env::current()).err().expect("the configuration is refused")
}

fn warnings(records: &Mutex<Vec<Record>>) -> Vec<String> {
    records.lock().unwrap().iter().filter(|record| record.level == Level::Warn).map(|record| record.message.clone()).collect()
}

fn outcome(fields: HookCommandResult) -> HookCommandResult {
    HookCommandResult { exit_code: Some(0), ..fields }
}

fn group(handlers: Value) -> Value {
    json!([{ "hooks": handlers }])
}

fn command(command: &str) -> Value {
    json!({ "type": "command", "command": command })
}

// A killed descendant is reparented to init, and only init can reap it. Under
// a non-reaping PID 1 it stays a zombie for ever, and a zombie has already
// exited and dropped its pipes, so it is not a survivor.
fn is_alive(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        // "<pid> (<comm>) <state> ...", and comm can hold spaces and parens, so end it at the last ")".
        Ok(stat) => stat.rfind(')').and_then(|end| stat[end + 1..].split_whitespace().next()).is_some_and(|state| state != "Z"),
        Err(_) => false,
    }
}

/// The pids a test's own child wrote, once all `count` are there. A file seen
/// before its write lands is empty; an empty read is 0 pids, never pid 0.
fn read_pids(path: &Path, count: usize) -> Option<Vec<i32>> {
    let text = std::fs::read_to_string(path).ok()?;
    let pids: Vec<i32> = text.split_whitespace().filter_map(|word| word.parse().ok()).filter(|pid| *pid > 0).collect();
    (pids.len() == count).then_some(pids)
}

/// Poll for what has no signal to wait on: another process's files and exit.
fn wait_for<T>(what: &str, timeout: Duration, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(found) = check() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

const POLICY_PATH: &str = "/owner/hooks.json";

fn policy_config() -> Value {
    json!({
        "hooks": {
            "session_stop": group(json!([command("accept"), command("continue"), command("unreached"), { "type": "command", "command": "named", "name": "Named reviewer", "timeout": 0.5 }])),
        },
    })
}

// ── Hook policy ─────────────────────────────────────────────────────────

#[test]
fn keeps_local_admission_defaults_source_order_and_public_status() {
    let commands = parse_hooks_document(&policy_config(), POLICY_PATH).unwrap();
    let listed: Vec<(&str, u64)> = commands.iter().map(|hook| (hook.command.as_str(), hook.timeout_ms)).collect();
    assert_eq!(listed, [("accept", 30_000), ("continue", 30_000), ("unreached", 30_000), ("named", 500)]);
    assert_eq!(commands[3].name, "Named reviewer");
    assert_eq!(commands[2].name, "Session-stop command hook");
    assert_eq!(commands[0].description, "Runs after the assistant pass and may continue it.");
    assert_eq!(commands[1].source, "/owner/hooks.json#hooks.session_stop[0].hooks[1]");
    for invalid in [json!({ "hooks": { "other": [] } }), json!({ "hooks": { "session_stop": group(json!([command("a\0b")])) } })] {
        assert!(parse_hooks_document(&invalid, POLICY_PATH).is_err(), "{invalid}");
    }
}

#[test]
fn every_refusal_names_the_offending_field() {
    let refused = |document: Value| parse_hooks_document(&document, POLICY_PATH).unwrap_err();
    assert_eq!(refused(json!([])), "/owner/hooks.json must contain a JSON object.");
    assert_eq!(
        refused(json!({ "path": "/x", "document": {} })),
        "/owner/hooks.json has no top-level \"path\", \"document\"; send the document itself."
    );
    assert_eq!(refused(json!({ "hooks": [] })), "/owner/hooks.json: \"hooks\" must be an object.");
    assert_eq!(refused(json!({ "hooks": null })), "/owner/hooks.json: \"hooks\" must be an object.");
    assert_eq!(refused(json!({ "hooks": { "conversation_idle": [] } })), "/owner/hooks.json: unsupported hook event \"conversation_idle\".");
    assert_eq!(refused(json!({ "hooks": { "session_stop": {} } })), "/owner/hooks.json: \"hooks.session_stop\" must be an array.");
    assert_eq!(
        refused(json!({ "hooks": { "session_stop": [{ "hooks": "x" }] } })),
        "/owner/hooks.json: hooks.session_stop[0].hooks must be an array."
    );
    assert_eq!(refused(json!({ "hooks": { "session_stop": [[]] } })), "/owner/hooks.json: hooks.session_stop[0].hooks must be an array.");
    let handler = |handler: Value| refused(json!({ "hooks": { "session_stop": [{ "hooks": [] }, { "hooks": [command("ok"), handler] }] } }));
    let label = "/owner/hooks.json: hooks.session_stop[1].hooks[1]";
    for not_a_command in [json!("echo"), json!({ "type": "prompt", "command": "x" }), json!({ "type": "command", "command": 7 }), command("  \n")] {
        assert_eq!(handler(not_a_command), format!("{label} must be a command hook with a non-empty NUL-free command."));
    }
    for timeout in [json!(0), json!(-1), json!(600.5), json!("30"), json!(null)] {
        let refusal = handler(json!({ "type": "command", "command": "x", "timeout": timeout }));
        assert_eq!(refusal, format!("{label}.timeout must be a number in (0, 600]."), "{timeout}");
    }
    assert_eq!(
        handler(json!({ "type": "command", "command": "x", "name": " " })),
        format!("{label}.name must be a non-empty string of at most 80 characters.")
    );
    assert_eq!(
        handler(json!({ "type": "command", "command": "x", "description": "d".repeat(241) })),
        format!("{label}.description must be a non-empty string of at most 240 characters.")
    );
    // An empty document, and one with no events, admit no handlers.
    assert_eq!(parse_hooks_document(&json!({}), POLICY_PATH), Ok(Vec::new()));
    assert_eq!(parse_hooks_document(&json!({ "hooks": {} }), POLICY_PATH), Ok(Vec::new()));
}

#[test]
fn names_are_trimmed_and_measured_in_characters() {
    let named = |name: &str| {
        parse_hooks_document(
            &json!({ "hooks": { "session_stop": group(json!([{ "type": "command", "command": "x", "name": name }])) } }),
            POLICY_PATH,
        )
        .map(|commands| commands[0].name.clone())
    };
    assert_eq!(named("  Reviewer\n").as_deref(), Ok("Reviewer"));
    assert_eq!(named(&"n".repeat(80)).map(|name| name.len()), Ok(80));
    assert!(named(&"n".repeat(81)).is_err());
    assert!(named(&"🙂".repeat(80)).is_ok());
    assert!(named(&"🙂".repeat(81)).is_err());
    // White space alone is no command, and no name.
    assert!(parse_hooks_document(&json!({ "hooks": { "session_stop": group(json!([command(" \u{2028}")])) } }), POLICY_PATH).is_err());
    assert!(named(" \t").is_err());
    // A timeout is whole milliseconds, rounded down.
    let timed =
        parse_hooks_document(&json!({ "hooks": { "session_stop": group(json!([{ "type": "command", "command": "x", "timeout": 0.0015 }])) } }), "p");
    assert_eq!(timed.unwrap()[0].timeout_ms, 1);
}

#[test]
fn stops_at_the_first_real_continuation() {
    let called = Arc::new(Mutex::new(Vec::new()));
    let calls = called.clone();
    let runner = HookRunner::with_runner(
        policy_config(),
        Logger::silent(),
        Box::new(move |hook, _| {
            calls.lock().unwrap().push(hook.command.clone());
            let stdout = if hook.command == "continue" { r#"{"decision":"block","reason":"Revise"}"# } else { r#"{"continue":true}"# };
            outcome(HookCommandResult { stdout: stdout.to_string(), ..Default::default() })
        }),
    );
    assert!(runner.has_handlers());
    let observed = Mutex::new(Vec::new());
    let observer = |name: &str, running: bool| observed.lock().unwrap().push((name.to_string(), running));
    assert_eq!(runner.emit_session_stop(&stop_event(), Some(&observer)).as_deref(), Some("Revise"));
    // An empty continuation is no continuation, so the second handler still ran; the third never did.
    assert_eq!(*called.lock().unwrap(), ["accept", "continue"]);
    let name = "Session-stop command hook".to_string();
    assert_eq!(*observed.lock().unwrap(), [(name.clone(), true), (name.clone(), false), (name.clone(), true), (name, false)]);

    // A turn already stopped runs no handler at all.
    called.lock().unwrap().clear();
    let stopped = Abort::new();
    stopped.abort();
    assert_eq!(runner.emit_session_stop(&stop_event_in(&here(), &stopped, json!({})), None), None);
    assert!(called.lock().unwrap().is_empty());
}

#[test]
fn reads_every_shape_of_an_answer_and_fails_open_on_anything_else() {
    let commands = parse_hooks_document(&policy_config(), POLICY_PATH).unwrap();
    let stop = &commands[0];
    let warnings = Mutex::new(Vec::new());
    let warn = |message: &str, details: Value| warnings.lock().unwrap().push((message.to_string(), details));
    let exited = |fields: HookCommandResult| parse_command_result(stop, &fields, &warn);
    let answered = |stdout: &str| exited(outcome(HookCommandResult { stdout: stdout.to_string(), ..Default::default() }));
    // Silence, and an answer that asks for nothing, change nothing.
    assert_eq!(answered(" \n"), None);
    assert_eq!(answered("{}"), None);
    // Only `true` continues, and only strings are text.
    assert_eq!(answered(r#"{"continue":"yes","additionalContext":7,"reason":["x"]}"#), None);
    assert_eq!(answered(r#"{"continue":true}"#), None);
    // `continue` prefers the context, a block its reason; an empty one falls back to the other.
    assert_eq!(answered(" {\"continue\":true,\"additionalContext\":\"More.\",\"reason\":\"Why.\"}\n").as_deref(), Some("More."));
    assert_eq!(answered(r#"{"continue":true,"additionalContext":"","reason":"Why."}"#).as_deref(), Some("Why."));
    assert_eq!(answered(r#"{"decision":"block","additionalContext":"More.","reason":"Why."}"#).as_deref(), Some("Why."));
    assert_eq!(answered(r#"{"decision":"block","additionalContext":"More.","reason":""}"#).as_deref(), Some("More."));
    // Exit 2 blocks with what stderr said, or a stock reason; a stopped turn says nothing at all.
    let blocked = |stderr: &str| exited(HookCommandResult { exit_code: Some(2), stderr: stderr.into(), ..Default::default() });
    assert_eq!(blocked(" Blocked \n").as_deref(), Some("Blocked"));
    assert_eq!(blocked(" \n").as_deref(), Some("A Ghost hook blocked the stop."));
    assert_eq!(exited(HookCommandResult { aborted: true, exit_code: None, ..Default::default() }), None);
    assert!(warnings.lock().unwrap().is_empty());

    // Anything but an object, or a decision other than "block", is invalid output.
    for invalid in ["{bad", "[]", "\"block\"", "7", r#"{"decision":"allow"}"#, r#"{"decision":null}"#] {
        assert_eq!(answered(invalid), None, "{invalid}");
    }
    assert_eq!(warnings.lock().unwrap().len(), 6);
    assert!(warnings.lock().unwrap().iter().all(|(message, details)| {
        message == "session_stop hook returned invalid JSON" && *details == json!({ "source": stop.source, "error": "invalid hook output" })
    }));
    warnings.lock().unwrap().clear();

    // Every other failure is said by its kind, whatever the command printed or would have blocked.
    assert_eq!(exited(outcome(HookCommandResult { timed_out: true, ..Default::default() })), None);
    assert_eq!(exited(HookCommandResult { overflowed: true, exit_code: Some(2), stderr: "partial".into(), ..Default::default() }), None);
    assert_eq!(exited(outcome(HookCommandResult { execution_failed: true, ..Default::default() })), None);
    assert_eq!(exited(HookCommandResult { exit_code: None, ..Default::default() }), None);
    assert_eq!(
        *warnings.lock().unwrap(),
        [
            ("session_stop hook timed out".to_string(), json!({ "source": stop.source, "timeoutMs": 30_000 })),
            ("session_stop hook wrote more than 1 MB".to_string(), json!({ "source": stop.source })),
            ("session_stop hook failed open".to_string(), json!({ "source": stop.source, "error": "command execution failed" })),
            ("session_stop hook failed open".to_string(), json!({ "source": stop.source, "exitCode": null })),
        ]
    );
}

// ── Hooks ───────────────────────────────────────────────────────────────

#[test]
fn replaces_the_command_configuration_live() {
    let scratch = Scratch::new();
    let config = scratch.path("nested").join("hooks.json");
    let runner = configured(&config);
    assert_eq!(runner.config(), (config.clone(), json!({})));
    assert!(!runner.has_handlers());
    let on_disk = || serde_json::from_str::<Value>(&std::fs::read_to_string(&config).unwrap()).unwrap();

    let first = json!({ "hooks": { "session_stop": group(json!([{
        "type": "command",
        "command": "echo '{\"decision\":\"block\",\"reason\":\"Revise.\"}'",
        "name": "Reviewer",
    }])) } });
    assert_eq!(runner.replace_config(first.clone()), Ok((config.clone(), first.clone())));
    assert_eq!(on_disk(), first);
    // Private, and written whole: no temporary file is left beside it.
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&config).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_dir(config.parent().unwrap()).unwrap().count(), 1);
    assert!(runner.has_handlers());
    assert_eq!(runner.emit_session_stop(&stop_event(), None).as_deref(), Some("Revise."));
    assert_eq!(runner.config().1, first);

    let invalid = json!({ "hooks": { "session_stop": group(json!([command("")])) } });
    assert!(runner.replace_config(invalid).unwrap_err().contains("non-empty NUL-free command"));
    assert_eq!(on_disk(), first);
    assert!(runner.has_handlers());
    assert_eq!(runner.config().1, first);

    let second = json!({ "hooks": {} });
    runner.replace_config(second.clone()).unwrap();
    assert_eq!(on_disk(), second);
    assert!(!runner.has_handlers());
    assert_eq!(runner.emit_session_stop(&stop_event(), None), None);
}

#[test]
fn loads_claude_style_command_groups_and_passes_the_ghost_hook_payload() {
    let scratch = Scratch::new();
    let observed = scratch.path("observed.json");
    let ran_in = scratch.path("cwd.txt");
    let script = scratch.script(
        "hook.sh",
        &format!(
            "cat > {}\npwd > {}\nprintf '%s' '{{\"decision\":\"block\",\"reason\":\"Fix the final answer.\"}}'\n",
            quote(&observed),
            quote(&ran_in)
        ),
    );
    let config = scratch.config(
        "hooks.json",
        &json!({ "hooks": { "session_stop": group(json!([{ "type": "command", "command": format!("bash {script}"), "timeout": 5 }])) } }),
    );
    let runner = configured(&config);
    assert_eq!(runner.config().0, config);
    let event = stop_event_in(
        &scratch.0,
        &Abort::new(),
        json!({ "last_assistant_message": { "role": "assistant", "content": [{ "type": "text", "text": "draft" }] }, "stop_hook_active": true }),
    );
    assert_eq!(runner.emit_session_stop(&event, None).as_deref(), Some("Fix the final answer."));
    // The handler reads the whole event, as it was built, on its stdin; and runs where the event says.
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(&observed).unwrap()).unwrap();
    assert_eq!(seen, event.payload);
    assert_eq!(
        (&seen["type"], &seen["ghost_name"], &seen["owner_prompt"], &seen["stop_hook_active"]),
        (&json!("session_stop"), &json!("casper"), &json!("Continue"), &json!(true))
    );
    assert_eq!(std::fs::read_to_string(&ran_in).unwrap().trim_end(), std::fs::canonicalize(&scratch.0).unwrap().to_string_lossy());
}

// What ends a process group is `process.rs`'s to prove; this is that a hook's timeout reaches it.
#[test]
fn a_timeout_kills_the_hooks_whole_process_tree_and_is_said() {
    let scratch = Scratch::new();
    let pids_path = scratch.path("pids");
    // A leader and a descendant in its process group, both deaf to SIGTERM and both holding the hook's pipes.
    let script = scratch.script(
        "tree.sh",
        &format!(
            "trap '' TERM\nbash -c 'trap \"\" TERM; while :; do sleep 1; done' &\necho \"$$ $!\" > {tmp} && mv {tmp} {pids}\nwhile :; do sleep 1; done\n",
            tmp = quote(&scratch.path("pids.tmp")),
            pids = quote(&pids_path)
        ),
    );
    // Long enough for the command to start and record its pids under a loaded suite.
    let config = scratch.config(
        "hooks.json",
        &json!({ "hooks": { "session_stop": group(json!([{ "type": "command", "command": format!("bash {script}"), "timeout": 2 }])) } }),
    );
    let (logger, records) = Logger::recording();
    let runner = HookRunner::from_config(&config, logger, crate::env::current()).unwrap();
    assert_eq!(runner.emit_session_stop(&stop_event(), None), None);
    let pids = read_pids(&pids_path, 2).expect("the hook's pids");
    wait_for("the hook's process tree to end", Duration::from_secs(10), || pids.iter().all(|pid| !is_alive(*pid)).then_some(()));
    assert_eq!(warnings(&records), ["session_stop hook timed out"]);
    assert_eq!(records.lock().unwrap()[0].fields["timeoutMs"], json!(2000));
}

fn one_hook(command_line: &str) -> Value {
    json!({ "hooks": { "session_stop": group(json!([command(command_line)])) } })
}

#[test]
fn logs_categorical_command_failures_without_stdout_or_stderr_detail() {
    let document = json!({ "hooks": { "session_stop": group(json!([command("/bin/false"), command("/bin/true")])) } });
    let (stdout_sentinel, stderr_sentinel) = ("HOOK_STDOUT_SECRET_SENTINEL", "HOOK_STDERR_SECRET_SENTINEL");
    let calls = Arc::new(Mutex::new(0));
    let counted = calls.clone();
    let (logger, records) = Logger::recording();
    let runner = HookRunner::with_runner(
        document,
        logger,
        Box::new(move |_, _| {
            let mut calls = counted.lock().unwrap();
            *calls += 1;
            let stderr = stderr_sentinel.to_string();
            match *calls {
                1 => HookCommandResult { exit_code: Some(17), stdout: stdout_sentinel.to_string(), stderr, ..Default::default() },
                _ => HookCommandResult { exit_code: Some(0), stdout: format!("{{{stdout_sentinel}"), stderr, ..Default::default() },
            }
        }),
    );
    assert_eq!(runner.emit_session_stop(&stop_event(), None), None);
    assert_eq!(*calls.lock().unwrap(), 2);
    let records = records.lock().unwrap();
    let logged: Vec<(Level, &str, Value)> =
        records.iter().map(|record| (record.level, record.message.as_str(), Value::Object(record.fields.clone()))).collect();
    let bound = |fields: Value| {
        let mut all = json!({ "ghost": "casper" });
        all.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        all
    };
    assert_eq!(
        logged,
        [
            (Level::Warn, "session_stop hook failed open", bound(json!({ "source": "test#hooks.session_stop[0].hooks[0]", "exitCode": 17 }))),
            (
                Level::Warn,
                "session_stop hook returned invalid JSON",
                bound(json!({ "source": "test#hooks.session_stop[0].hooks[1]", "error": "invalid hook output" }))
            ),
        ]
    );
    let text = format!("{records:?}");
    assert!(!text.contains(stdout_sentinel) && !text.contains(stderr_sentinel));
}

#[test]
fn fails_process_startup_errors_open() {
    let scratch = Scratch::new();
    let config = scratch.config("startup-hooks.json", &one_hook("/bin/true"));
    let missing = scratch.path("missing-cwd");
    let (logger, records) = Logger::recording();
    let runner = HookRunner::from_config(&config, logger, crate::env::current()).unwrap();
    assert_eq!(runner.emit_session_stop(&stop_event_in(&missing, &Abort::new(), json!({})), None), None);
    assert_eq!(warnings(&records), ["session_stop hook failed open"]);
    assert!(records.lock().unwrap().iter().all(|record| record.fields["error"] == "command execution failed"));
}

#[test]
fn rejects_unsupported_configured_events_instead_of_silently_ignoring_them() {
    let scratch = Scratch::new();
    let config = scratch.config("hooks.json", &json!({ "hooks": { "conversation_idle": [] } }));
    assert!(load_error(&config).contains("unsupported hook event"));
    // A file that is not JSON, or not an object, is refused by name too.
    std::fs::write(&config, "{ not json").unwrap();
    assert!(load_error(&config).starts_with(&format!("Cannot load Ghost hooks from {}: ", config.display())));
    std::fs::write(&config, "[]").unwrap();
    assert_eq!(load_error(&config), format!("{} must contain a JSON object.", config.display()));
}

#[test]
fn a_real_command_reports_its_exit_its_stderr_and_an_overflow() {
    let scratch = Scratch::new();
    let run = |command_line: &str| {
        let config = scratch.config("hooks.json", &json!({ "hooks": { "session_stop": group(json!([command(command_line)])) } }));
        let (logger, records) = Logger::recording();
        let result = HookRunner::from_config(&config, logger, crate::env::current()).unwrap().emit_session_stop(&stop_event(), None);
        (result, warnings(&records))
    };
    // Exit 2 blocks with what the command said on stderr, whatever it printed.
    let (blocked, said) = run("echo ignored; echo ' Not yet. ' >&2; exit 2");
    assert_eq!((blocked.as_deref(), said.len()), (Some("Not yet."), 0));
    assert_eq!(run("exit 3"), (None, vec!["session_stop hook failed open".to_string()]));
    assert_eq!(run("true"), (None, Vec::new()));
    // More than 1 MB of stdout ends the command and fails open, even when it would have blocked.
    let (overflowed, said) = run("head -c 2000000 /dev/zero | tr '\\0' x; exit 2");
    assert_eq!((overflowed, said), (None, vec!["session_stop hook wrote more than 1 MB".to_string()]));
}
