use super::*;
use crate::log::{Level, Record};
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
        "session_id": "session-1",
        "transcript_path": here().join(".conversation.jsonl").to_string_lossy(),
        "ghost_name": "casper",
        "ghost_home": here().to_string_lossy(),
        "cwd": cwd.to_string_lossy(),
        "conversation_id": "session-1",
    })
}

fn stop_event_in(cwd: &Path, abort: &Abort, extra: Value) -> HookEvent {
    let mut payload = base("session_stop", cwd);
    let fields = json!({ "owner_prompt": "Continue", "messages": [], "last_assistant_message": null, "stop_hook_active": false });
    for (key, value) in fields.as_object().unwrap().iter().chain(extra.as_object().unwrap()) {
        payload[key] = value.clone();
    }
    HookEvent { name: HookEventName::SessionStop, payload, cwd: cwd.to_path_buf(), abort: abort.clone() }
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

fn reason(result: Option<StopResult>) -> Option<String> {
    continuation(result.as_ref())
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

/// SIGKILL to a process this test's own hook started; one already gone is fine.
fn kill_if_alive(path: &Path) {
    if let Some(pids) = read_pids(path, 1) {
        // SAFETY: a plain syscall on a pid this test's child recorded; ESRCH is success.
        unsafe {
            libc::kill(pids[0], libc::SIGKILL);
        }
    }
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
    let listed: Vec<(&str, &str, u64)> = commands.iter().map(|hook| (hook.event.as_str(), hook.command.as_str(), hook.timeout_ms)).collect();
    assert_eq!(
        listed,
        [
            ("session_stop", "accept", 30_000),
            ("session_stop", "continue", 30_000),
            ("session_stop", "unreached", 30_000),
            ("session_stop", "named", 500),
        ]
    );
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
fn names_are_trimmed_and_measured_as_the_earlier_daemon_did() {
    let named = |name: &str| {
        parse_hooks_document(
            &json!({ "hooks": { "session_stop": group(json!([{ "type": "command", "command": "x", "name": name }])) } }),
            POLICY_PATH,
        )
        .map(|commands| commands[0].name.clone())
    };
    assert_eq!(named("  Reviewer\u{feff}\n").as_deref(), Ok("Reviewer"));
    assert_eq!(named(&"n".repeat(80)).map(|name| name.len()), Ok(80));
    assert!(named(&"n".repeat(81)).is_err());
    // The limit is in UTF-16 units: 40 of these are 80 units, 41 are 82.
    assert!(named(&"🙂".repeat(40)).is_ok());
    assert!(named(&"🙂".repeat(41)).is_err());
    // What JavaScript trims away leaves no command, and no name.
    assert!(parse_hooks_document(&json!({ "hooks": { "session_stop": group(json!([command("\u{feff}\u{2028}")])) } }), POLICY_PATH).is_err());
    assert!(named("\u{feff}").is_err());
    // A timeout is whole milliseconds, rounded down.
    let timed =
        parse_hooks_document(&json!({ "hooks": { "session_stop": group(json!([{ "type": "command", "command": "x", "timeout": 0.0015 }])) } }), "p");
    assert_eq!(timed.unwrap()[0].timeout_ms, 1);
}

#[test]
fn stops_at_the_first_real_continuation() {
    let commands = parse_hooks_document(&policy_config(), POLICY_PATH).unwrap();
    let called = Arc::new(Mutex::new(Vec::new()));
    let calls = called.clone();
    let runner = HookRunner::with_runner(
        commands,
        Logger::silent(),
        Box::new(move |hook, _| {
            calls.lock().unwrap().push(hook.command.clone());
            let stdout = if hook.command == "continue" { r#"{"decision":"block","reason":"Revise"}"# } else { r#"{"continue":true}"# };
            Ok(outcome(HookCommandResult { stdout: stdout.to_string(), ..Default::default() }))
        }),
    );
    assert!(runner.has_handlers(HookEventName::SessionStop));
    let observed = Mutex::new(Vec::new());
    let observer = |name: &str, event: HookEventName, running: bool| observed.lock().unwrap().push((name.to_string(), event, running));
    let result = runner.emit_session_stop(&stop_event(), Some(&observer));
    assert_eq!(result, Some(StopResult { block: true, reason: Some("Revise".to_string()), ..Default::default() }));
    // An empty continuation is no continuation, so the second handler still ran; the third never did.
    assert_eq!(*called.lock().unwrap(), ["accept", "continue"]);
    let name = "Session-stop command hook".to_string();
    let stop = HookEventName::SessionStop;
    assert_eq!(*observed.lock().unwrap(), [(name.clone(), stop, true), (name.clone(), stop, false), (name.clone(), stop, true), (name, stop, false)]);

    // A turn already stopped runs no handler at all.
    called.lock().unwrap().clear();
    let stopped = Abort::new();
    stopped.abort();
    assert_eq!(runner.emit_session_stop(&stop_event_in(&here(), &stopped, json!({})), None), None);
    assert!(called.lock().unwrap().is_empty());
}

#[test]
fn preserves_exit_code_invalid_output_and_fail_open_interpretation() {
    let commands = parse_hooks_document(&policy_config(), POLICY_PATH).unwrap();
    let stop = &commands[0];
    let warnings = Mutex::new(Vec::new());
    let warn = |message: &str, _: Value| warnings.lock().unwrap().push(message.to_string());
    let read = |hook: &CommandHook, fields: HookCommandResult| parse_command_result(hook, &outcome(fields), &warn);
    let blocked = || HookCommandResult { stderr: "Blocked".to_string(), ..Default::default() };
    assert_eq!(
        parse_command_result(stop, &HookCommandResult { exit_code: Some(2), ..blocked() }, &warn),
        Some(StopResult { block: true, reason: Some("Blocked".to_string()), ..Default::default() })
    );
    assert_eq!(read(stop, HookCommandResult { stdout: "{bad".to_string(), ..Default::default() }), None);
    assert_eq!(read(stop, HookCommandResult { timed_out: true, ..Default::default() }), None);
    let overflowed = HookCommandResult { overflowed: true, exit_code: Some(2), stderr: "partial".to_string(), ..Default::default() };
    assert_eq!(parse_command_result(stop, &overflowed, &warn), None);
    assert_eq!(read(stop, HookCommandResult { execution_failed: true, ..Default::default() }), None);
    assert_eq!(
        *warnings.lock().unwrap(),
        [
            "session_stop hook returned invalid JSON",
            "session_stop hook timed out",
            "session_stop hook wrote more than 1 MB",
            "session_stop hook failed open",
        ]
    );
    let proceed = |fields: StopResult| continuation(Some(&fields));
    assert_eq!(proceed(StopResult { continue_turn: true, ..Default::default() }), None);
    assert_eq!(
        proceed(StopResult { continue_turn: true, additional_context: Some("Revise".into()), ..Default::default() }).as_deref(),
        Some("Revise")
    );
    assert_eq!(continuation(None), None);
}

#[test]
fn reads_every_shape_of_a_clean_answer() {
    let commands = parse_hooks_document(&policy_config(), POLICY_PATH).unwrap();
    let stop = &commands[0];
    let warnings = Mutex::new(Vec::new());
    let warn = |message: &str, details: Value| warnings.lock().unwrap().push((message.to_string(), details));
    let answered = |hook: &CommandHook, stdout: &str| {
        parse_command_result(hook, &outcome(HookCommandResult { stdout: stdout.to_string(), ..Default::default() }), &warn)
    };
    // Silence, and an answer that asks for nothing, change nothing.
    assert_eq!(answered(stop, " \n"), None);
    assert_eq!(answered(stop, "{}"), Some(StopResult::default()));
    assert_eq!(continuation(answered(stop, "{}").as_ref()), None);
    // Only `true` continues, and only strings are text.
    let loose = answered(stop, r#"{"continue":"yes","additionalContext":7,"reason":["x"]}"#);
    assert_eq!(loose, Some(StopResult::default()));
    let both = answered(stop, "\u{feff}{\"continue\":true,\"additionalContext\":\"More.\",\"reason\":\"Why.\"}\n").unwrap();
    assert_eq!(both, StopResult { continue_turn: true, additional_context: Some("More.".into()), block: false, reason: Some("Why.".into()) });
    // `continue` prefers the context, a block its reason; an empty one falls back to the other.
    assert_eq!(continuation(Some(&both)).as_deref(), Some("More."));
    assert_eq!(continuation(Some(&StopResult { block: true, continue_turn: false, ..both.clone() })).as_deref(), Some("Why."));
    assert_eq!(continuation(Some(&StopResult { additional_context: Some(String::new()), ..both.clone() })).as_deref(), Some("Why."));
    assert_eq!(continuation(Some(&StopResult { block: true, continue_turn: false, reason: Some(String::new()), ..both })).as_deref(), Some("More."));
    assert!(warnings.lock().unwrap().is_empty());

    // Anything but an object, or a decision other than "block", is invalid output.
    for invalid in ["[]", "\"block\"", "7", r#"{"decision":"allow"}"#, r#"{"decision":null}"#] {
        assert_eq!(answered(stop, invalid), None, "{invalid}");
    }
    assert_eq!(warnings.lock().unwrap().len(), 5);
    assert!(warnings.lock().unwrap().iter().all(|(message, details)| {
        message == "session_stop hook returned invalid JSON" && *details == json!({ "source": stop.source, "error": "invalid hook output" })
    }));
    warnings.lock().unwrap().clear();

    // Exit 2 blocks with what stderr said, or a stock reason; a stopped turn says nothing at all.
    let exited = |fields: HookCommandResult| parse_command_result(stop, &fields, &warn);
    assert_eq!(
        exited(HookCommandResult { exit_code: Some(2), stderr: " \n".into(), ..Default::default() }).unwrap().reason.as_deref(),
        Some("A Ghost hook blocked the stop.")
    );
    assert_eq!(exited(HookCommandResult { aborted: true, exit_code: None, ..Default::default() }), None);
    assert!(warnings.lock().unwrap().is_empty());
    assert_eq!(exited(HookCommandResult { exit_code: None, ..Default::default() }), None);
    assert_eq!(*warnings.lock().unwrap(), [("session_stop hook failed open".to_string(), json!({ "source": stop.source, "exitCode": null }))]);
}

// ── Hooks ───────────────────────────────────────────────────────────────

#[test]
fn runs_session_stop_hooks_in_order_and_returns_the_first_continuation() {
    let scratch = Scratch::new();
    let order = scratch.path("order.txt");
    // Each hook appends before answering, so the file is the observed order.
    let step = |name: &str, answer: &str| command(&format!("echo {name} >> {}; printf '%s' '{answer}'", quote(&order)));
    let config = scratch.config(
        "hooks.json",
        &json!({ "hooks": { "session_stop": group(json!([
            // An empty continuation is intentionally ignored, so the second hook still runs.
            step("first", r#"{"continue":true}"#),
            step("second", r#"{"decision":"block","reason":"Revise this answer."}"#),
            step("third", "{}"),
        ])) } }),
    );
    let result = configured(&config).emit_session_stop(&stop_event(), None);
    assert_eq!(std::fs::read_to_string(&order).unwrap(), "first\nsecond\n");
    assert_eq!(reason(result).as_deref(), Some("Revise this answer."));
}

#[test]
fn replaces_the_command_configuration_live() {
    let scratch = Scratch::new();
    let config = scratch.path("nested").join("hooks.json");
    let runner = configured(&config);
    assert_eq!(runner.config(), Some((config.clone(), json!({}))));
    assert!(!runner.has_handlers(HookEventName::SessionStop));
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
    assert!(runner.has_handlers(HookEventName::SessionStop));
    assert_eq!(reason(runner.emit_session_stop(&stop_event(), None)).as_deref(), Some("Revise."));
    assert_eq!(runner.config().unwrap().1, first);

    let invalid = json!({ "hooks": { "session_stop": group(json!([command("")])) } });
    assert!(runner.replace_config(invalid).unwrap_err().contains("non-empty NUL-free command"));
    assert_eq!(on_disk(), first);
    assert!(runner.has_handlers(HookEventName::SessionStop));
    assert_eq!(runner.config().unwrap().1, first);

    let second = json!({ "hooks": {} });
    runner.replace_config(second.clone()).unwrap();
    assert_eq!(on_disk(), second);
    assert!(!runner.has_handlers(HookEventName::SessionStop));
    assert_eq!(runner.emit_session_stop(&stop_event(), None), None);
}

#[test]
fn has_no_configuration_to_replace_when_built_without_a_file() {
    let runner = HookRunner::new(Vec::new(), Logger::silent(), crate::env::current());
    assert_eq!(runner.config(), None);
    assert!(runner.replace_config(json!({ "hooks": {} })).unwrap_err().contains("no configuration file"));
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
    assert_eq!(runner.config().unwrap().0, config);
    let event = stop_event_in(
        &scratch.0,
        &Abort::new(),
        json!({ "last_assistant_message": { "role": "assistant", "content": [{ "type": "text", "text": "draft" }] }, "stop_hook_active": true }),
    );
    assert_eq!(reason(runner.emit_session_stop(&event, None)).as_deref(), Some("Fix the final answer."));
    // The handler reads the whole event, as it was built, on its stdin; and runs where the event says.
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(&observed).unwrap()).unwrap();
    assert_eq!(seen, event.payload);
    assert_eq!(
        (&seen["type"], &seen["ghost_name"], &seen["owner_prompt"], &seen["stop_hook_active"]),
        (&json!("session_stop"), &json!("casper"), &json!("Continue"), &json!(true))
    );
    assert_eq!(std::fs::read_to_string(&ran_in).unwrap().trim_end(), std::fs::canonicalize(&scratch.0).unwrap().to_string_lossy());
}

#[test]
fn kills_the_owned_command_process_tree_on_timeout_and_abort() {
    for mode in ["timeout", "abort"] {
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
        let timeout = if mode == "timeout" { 2 } else { 30 };
        let config = scratch.config(
            "hooks.json",
            &json!({ "hooks": { "session_stop": group(json!([{ "type": "command", "command": format!("bash {script}"), "timeout": timeout }])) } }),
        );
        let (logger, records) = Logger::recording();
        let runner = HookRunner::from_config(&config, logger, crate::env::current()).unwrap();
        let abort = Abort::new();
        let event = stop_event_in(&here(), &abort, json!({}));
        let (result, pids) = std::thread::scope(|scope| {
            let running = scope.spawn(|| runner.emit_session_stop(&event, None));
            let pids = wait_for("the hook's pids", Duration::from_secs(20), || read_pids(&pids_path, 2));
            if mode == "abort" {
                abort.abort();
            }
            (running.join().unwrap(), pids)
        });
        assert_eq!(result, None, "{mode}");
        wait_for("the hook's process tree to end", Duration::from_secs(10), || pids.iter().all(|pid| !is_alive(*pid)).then_some(()));
        // A timeout is said; a stopped turn's hook is not.
        let expected: &[&str] = if mode == "timeout" { &["session_stop hook timed out"] } else { &[] };
        assert_eq!(warnings(&records), expected, "{mode}");
        if mode == "timeout" {
            assert_eq!(records.lock().unwrap()[0].fields["timeoutMs"], json!(2000));
        }
    }
}

#[test]
fn ends_a_hook_with_its_own_process_when_a_setsid_descendant_keeps_the_pipes_open() {
    let scratch = Scratch::new();
    let (pid_path, gate, outcome, ready) =
        (scratch.path("background.pid"), scratch.path("write-late"), scratch.path("pipe-state"), scratch.path("ready"));
    let publish =
        |text: &str, path: &Path| format!("echo {text} > {tmp} && mv {tmp} {path}", tmp = quote(&path.with_extension("tmp")), path = quote(path));
    // Once the gate opens it writes to the hook's stdout until that fails. The
    // runner lets go of the pipe as the hook ends, give or take the write that
    // tells it so; a pipe still open after 5 s is the leak.
    let descendant = scratch.script(
        "descendant.sh",
        &format!(
            "trap '' PIPE\n{ready}\nwhile [ ! -e {gate} ]; do sleep 0.01; done\ndeadline=$((SECONDS + 5))\nwhile :; do\n  if ! echo late 2>/dev/null; then {closed}; exit 0; fi\n  if [ \"$SECONDS\" -ge \"$deadline\" ]; then {open}; exit 0; fi\n  sleep 0.02\ndone\n",
            ready = publish("$$", &ready),
            gate = quote(&gate),
            closed = publish("closed", &outcome),
            open = publish("open", &outcome),
        ),
    );
    // The documented background pattern, without redirecting output: the
    // descendant leaves the hook's process group but still holds its stdout.
    let config = scratch.config(
        "hooks.json",
        &json!({ "hooks": { "session_stop": group(json!([command(&format!(
            "setsid bash {descendant} & echo $! > {}; echo '{{\"decision\":\"block\",\"reason\":\"Keep going.\"}}'",
            quote(&pid_path)
        ))])) } }),
    );
    let runner = configured(&config);
    let started = Instant::now();
    let result = runner.emit_session_stop(&stop_event(), None);
    let finish = || {
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(reason(result).as_deref(), Some("Keep going."));
        // A loaded machine can start the descendant late; wait for it before
        // opening the gate, so its deadline measures only the write.
        wait_for("the descendant to start", Duration::from_secs(20), || ready.exists().then_some(()));
        std::fs::write(&gate, "ready").unwrap();
        wait_for("the pipe's outcome", Duration::from_secs(20), || outcome.exists().then_some(()));
        assert_eq!(std::fs::read_to_string(&outcome).unwrap().trim(), "closed");
    };
    let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(finish));
    kill_if_alive(&pid_path);
    if let Err(panic) = checked {
        std::panic::resume_unwind(panic);
    }
}

#[test]
fn kills_a_term_ignoring_descendant_when_the_stopped_hook_leader_exits_first() {
    let scratch = Scratch::new();
    let pid_path = scratch.path("child.pid");
    // The descendant holds none of the hook's pipes and ignores SIGTERM; the leader dies of it.
    let child = scratch.script(
        "child.sh",
        &format!(
            "trap '' TERM\necho $$ > {tmp} && mv {tmp} {pid}\nwhile :; do sleep 1; done\n",
            tmp = quote(&scratch.path("child.tmp")),
            pid = quote(&pid_path)
        ),
    );
    let parent = scratch.script("parent.sh", &format!("bash {child} < /dev/null > /dev/null 2>&1 &\nwhile :; do sleep 1; done\n"));
    let config = scratch.config("hooks.json", &json!({ "hooks": { "session_stop": group(json!([command(&format!("bash {parent}"))])) } }));
    let runner = configured(&config);
    let abort = Abort::new();
    let event = stop_event_in(&here(), &abort, json!({}));
    let pid = std::thread::scope(|scope| {
        let running = scope.spawn(|| runner.emit_session_stop(&event, None));
        let found = std::panic::catch_unwind(|| wait_for("the descendant's pid", Duration::from_secs(20), || read_pids(&pid_path, 1)));
        abort.abort();
        assert_eq!(running.join().unwrap(), None);
        found
    });
    let gone = pid
        .map(|pids| std::panic::catch_unwind(|| wait_for("the descendant to end", Duration::from_secs(10), || (!is_alive(pids[0])).then_some(()))));
    kill_if_alive(&pid_path);
    match gone {
        Ok(Ok(())) => {}
        Ok(Err(panic)) | Err(panic) => std::panic::resume_unwind(panic),
    }
}

fn one_hook(command_line: &str) -> Value {
    json!({ "hooks": { "session_stop": group(json!([command(command_line)])) } })
}

#[test]
fn rejects_nul_commands_and_fails_a_hook_open_on_execution_rejection() {
    let scratch = Scratch::new();
    let nul = scratch.config("nul-hooks.json", &json!({ "hooks": { "session_stop": group(json!([command("echo before\0after")])) } }));
    assert!(load_error(&nul).contains("NUL-free command"));

    let (logger, records) = Logger::recording();
    let commands = parse_hooks_document(&one_hook("/bin/true"), "/owner/throwing-hooks.json").unwrap();
    let runner = HookRunner::with_runner(commands, logger, Box::new(|_, _| Err("must-not-leak execution sentinel".to_string())));
    assert_eq!(runner.emit_session_stop(&stop_event(), None), None);
    assert_eq!(warnings(&records), ["session_stop hook failed open"]);
    let records = records.lock().unwrap();
    assert_eq!(records[0].fields["source"], "/owner/throwing-hooks.json#hooks.session_stop[0].hooks[0]");
    assert_eq!(records[0].fields["error"], "command execution failed");
    assert!(!format!("{records:?}").contains("must-not-leak"));
}

#[test]
fn logs_categorical_command_failures_without_stdout_or_stderr_detail() {
    let path = "/owner/redacted-command-hooks.json";
    let commands =
        parse_hooks_document(&json!({ "hooks": { "session_stop": group(json!([command("/bin/false"), command("/bin/true")])) } }), path).unwrap();
    let (stdout_sentinel, stderr_sentinel) = ("HOOK_STDOUT_SECRET_SENTINEL", "HOOK_STDERR_SECRET_SENTINEL");
    let calls = Arc::new(Mutex::new(0));
    let counted = calls.clone();
    let (logger, records) = Logger::recording();
    let runner = HookRunner::with_runner(
        commands,
        logger,
        Box::new(move |_, _| {
            let mut calls = counted.lock().unwrap();
            *calls += 1;
            let stderr = stderr_sentinel.to_string();
            Ok(match *calls {
                1 => HookCommandResult { exit_code: Some(17), stdout: stdout_sentinel.to_string(), stderr, ..Default::default() },
                _ => HookCommandResult { exit_code: Some(0), stdout: format!("{{{stdout_sentinel}"), stderr, ..Default::default() },
            })
        }),
    );
    assert_eq!(runner.emit_session_stop(&stop_event(), None), None);
    assert_eq!(*calls.lock().unwrap(), 2);
    let records = records.lock().unwrap();
    let logged: Vec<(Level, &str, Value)> =
        records.iter().map(|record| (record.level, record.message.as_str(), Value::Object(record.fields.clone()))).collect();
    let bound = |fields: Value| {
        let mut all = json!({ "ghost": "casper", "conversation": "session-1" });
        all.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        all
    };
    assert_eq!(
        logged,
        [
            (
                Level::Warn,
                "session_stop hook failed open",
                bound(json!({ "source": format!("{path}#hooks.session_stop[0].hooks[0]"), "exitCode": 17 }))
            ),
            (
                Level::Warn,
                "session_stop hook returned invalid JSON",
                bound(json!({ "source": format!("{path}#hooks.session_stop[0].hooks[1]"), "error": "invalid hook output" }))
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
    assert_eq!((reason(blocked).as_deref(), said.len()), (Some("Not yet."), 0));
    assert_eq!(run("exit 3"), (None, vec!["session_stop hook failed open".to_string()]));
    assert_eq!(run("true"), (None, Vec::new()));
    // More than 1 MB of stdout ends the command and fails open, even when it would have blocked.
    let (overflowed, said) = run("head -c 2000000 /dev/zero | tr '\\0' x; exit 2");
    assert_eq!((overflowed, said), (None, vec!["session_stop hook wrote more than 1 MB".to_string()]));
}
