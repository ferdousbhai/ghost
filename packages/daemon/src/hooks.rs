//! The owner's command hooks (docs/hooks.md): `session_stop`, awaited after a
//! pass and able to continue it, and `turn_end`, which only observes. This
//! module admits `hooks.json`, runs a handler, and reads its answer; every
//! failure of a handler fails open.
use crate::abort::Abort;
use crate::env::Env;
use crate::log::Logger;
use crate::process::{ProcessOptions, run_process};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DEFAULT_TIMEOUT_SECONDS: f64 = 30.0;
const MAX_HOOK_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookEventName {
    SessionStop,
    TurnEnd,
}

impl HookEventName {
    /// Every hook event, in the order hooks are loaded.
    const ALL: [Self; 2] = [Self::SessionStop, Self::TurnEnd];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionStop => "session_stop",
            Self::TurnEnd => "turn_end",
        }
    }
    /// A handler's default name and description.
    fn defaults(self) -> (&'static str, &'static str) {
        match self {
            Self::SessionStop => ("Session-stop command hook", "Runs after the assistant pass and may continue it."),
            Self::TurnEnd => ("Turn-end command hook", "Observes final turn success or failure without continuing it."),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommandHook {
    pub event: HookEventName,
    pub command: String,
    pub name: String,
    pub description: String,
    pub timeout_ms: u64,
    pub source: String,
}

/// One event handed to handlers: its JSON payload (docs/hooks.md), where they
/// run, and the turn's stop signal.
pub struct HookEvent {
    pub name: HookEventName,
    pub payload: Value,
    pub cwd: PathBuf,
    pub abort: Abort,
}

/// What a `session_stop` handler answered.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct StopResult {
    pub continue_turn: bool,
    pub additional_context: Option<String>,
    pub block: bool,
    pub reason: Option<String>,
}

/// The text the next pass is given, when the handler asked for one.
pub fn continuation(result: Option<&StopResult>) -> Option<String> {
    let result = result?;
    let additional = result.additional_context.clone().filter(|text| !text.is_empty());
    let reason = result.reason.clone().filter(|text| !text.is_empty());
    if result.continue_turn {
        return additional.or(reason);
    }
    if result.block {
        return reason.or(additional);
    }
    None
}

fn display_text(value: Option<&Value>, fallback: &str, label: &str, maximum: usize) -> Result<String, String> {
    let Some(value) = value else { return Ok(fallback.to_string()) };
    match value.as_str().map(str::trim) {
        Some(text) if !text.is_empty() && text.chars().count() <= maximum => Ok(text.to_string()),
        _ => Err(format!("{label} must be a non-empty string of at most {maximum} characters.")),
    }
}

fn quoted(text: &str) -> String {
    Value::String(text.to_string()).to_string()
}

/// Admit one `hooks.json` document. Every error names the offending field the
/// same way whether the document came from disk or from `PUT /api/hooks/config`.
pub fn parse_hooks_document(parsed: &Value, path: &str) -> Result<Vec<CommandHook>, String> {
    let document = parsed.as_object().ok_or_else(|| format!("{path} must contain a JSON object."))?;
    let stray: Vec<String> = document.keys().filter(|key| *key != "hooks").map(|key| quoted(key)).collect();
    // A document names only `hooks`, so a pasted `{ path, document }` reply is
    // refused instead of silently disabling every hook.
    if !stray.is_empty() {
        return Err(format!("{path} has no top-level {}; send the document itself.", stray.join(", ")));
    }
    let Some(hooks) = document.get("hooks") else { return Ok(Vec::new()) };
    let hooks = hooks.as_object().ok_or_else(|| format!("{path}: \"hooks\" must be an object."))?;
    if let Some(unknown) = hooks.keys().find(|key| !HookEventName::ALL.iter().any(|event| event.as_str() == key.as_str())) {
        return Err(format!("{path}: unsupported hook event {}.", quoted(unknown)));
    }
    let mut result = Vec::new();
    for event in HookEventName::ALL {
        let name = event.as_str();
        let Some(groups) = hooks.get(name) else { continue };
        let groups = groups.as_array().ok_or_else(|| format!("{path}: \"hooks.{name}\" must be an array."))?;
        for (group_index, group) in groups.iter().enumerate() {
            let handlers = group.get("hooks").and_then(Value::as_array).filter(|_| group.is_object());
            let handlers = handlers.ok_or_else(|| format!("{path}: hooks.{name}[{group_index}].hooks must be an array."))?;
            for (handler_index, raw) in handlers.iter().enumerate() {
                let label = format!("hooks.{name}[{group_index}].hooks[{handler_index}]");
                let command = raw.get("command").and_then(Value::as_str).filter(|command| !command.trim().is_empty() && !command.contains('\0'));
                let command = match command {
                    Some(command) if raw.is_object() && raw.get("type").and_then(Value::as_str) == Some("command") => command,
                    _ => return Err(format!("{path}: {label} must be a command hook with a non-empty NUL-free command.")),
                };
                let timeout = match raw.get("timeout") {
                    None => DEFAULT_TIMEOUT_SECONDS,
                    Some(value) => value
                        .as_f64()
                        .filter(|seconds| *seconds > 0.0 && *seconds <= 600.0)
                        .ok_or_else(|| format!("{path}: {label}.timeout must be a number in (0, 600]."))?,
                };
                let (default_name, default_description) = event.defaults();
                result.push(CommandHook {
                    event,
                    command: command.to_string(),
                    name: display_text(raw.get("name"), default_name, &format!("{path}: {label}.name"), 80)?,
                    description: display_text(raw.get("description"), default_description, &format!("{path}: {label}.description"), 240)?,
                    timeout_ms: (timeout * 1000.0).floor() as u64,
                    source: format!("{path}#{label}"),
                });
            }
        }
    }
    Ok(result)
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct HookCommandResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub aborted: bool,
    pub timed_out: bool,
    /// Stopped for writing more than 1 MB to stdout.
    pub overflowed: bool,
    pub execution_failed: bool,
}

/// Read a handler's outcome. Anything but a clean answer warns and fails open.
pub fn parse_command_result(hook: &CommandHook, result: &HookCommandResult, warn: &dyn Fn(&str, Value)) -> Option<StopResult> {
    let event = hook.event.as_str();
    if result.aborted {
        return None;
    }
    if result.execution_failed {
        warn(&format!("{event} hook failed open"), json!({ "source": hook.source, "error": "command execution failed" }));
        return None;
    }
    if result.timed_out {
        warn(&format!("{event} hook timed out"), json!({ "source": hook.source, "timeoutMs": hook.timeout_ms }));
        return None;
    }
    if result.overflowed {
        warn(&format!("{event} hook wrote more than 1 MB"), json!({ "source": hook.source }));
        return None;
    }
    if result.exit_code == Some(2) {
        if hook.event != HookEventName::SessionStop {
            warn(&format!("{event} hook attempted to block and was ignored"), json!({ "source": hook.source }));
            return None;
        }
        let reason = result.stderr.trim();
        return Some(StopResult {
            block: true,
            reason: Some(if reason.is_empty() { "A Ghost hook blocked the stop." } else { reason }.to_string()),
            ..Default::default()
        });
    }
    if result.exit_code != Some(0) {
        warn(&format!("{event} hook failed open"), json!({ "source": hook.source, "exitCode": result.exit_code }));
        return None;
    }
    if hook.event == HookEventName::TurnEnd {
        return None;
    }
    let output = result.stdout.trim();
    if output.is_empty() {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(output).ok().filter(Value::is_object);
    let decision = parsed.as_ref().and_then(|parsed| parsed.get("decision"));
    match parsed.as_ref() {
        Some(parsed) if decision.is_none_or(|decision| decision == "block") => Some(StopResult {
            continue_turn: parsed.get("continue") == Some(&Value::Bool(true)),
            additional_context: parsed.get("additionalContext").and_then(Value::as_str).map(str::to_string),
            block: decision.is_some(),
            reason: parsed.get("reason").and_then(Value::as_str).map(str::to_string),
        }),
        _ => {
            warn(&format!("{event} hook returned invalid JSON"), json!({ "source": hook.source, "error": "invalid hook output" }));
            None
        }
    }
}

/// One hook command in bash, as its own process group: the event as JSON on
/// stdin, ended on abort, timeout, or more than 1 MB of stdout.
fn run_command_hook(hook: &CommandHook, event: &HookEvent, env: &Env) -> HookCommandResult {
    let (own, _link) = event.abort.child();
    let timed_out = Arc::new(AtomicBool::new(false));
    let (timer, flag, timeout) = (own.clone(), timed_out.clone(), Duration::from_millis(hook.timeout_ms));
    std::thread::spawn(move || {
        if !timer.wait(timeout) {
            flag.store(true, Ordering::SeqCst);
            timer.abort();
        }
    });
    let mut stdout = String::new();
    let mut bytes = 0usize;
    let mut overflowed = false;
    let stdin = event.payload.to_string();
    let exit = run_process(
        ProcessOptions {
            argv: &["/bin/bash", "-c", &hook.command],
            cwd: &event.cwd,
            env,
            abort: &own,
            stdin: Some(&stdin),
            merge_stderr: false,
            tick: false,
        },
        |chunk| {
            bytes += chunk.len();
            if bytes > MAX_HOOK_OUTPUT_BYTES {
                overflowed = true;
                own.abort();
            } else {
                stdout.push_str(chunk);
            }
        },
    );
    let timed_out = timed_out.load(Ordering::SeqCst);
    // Wakes the timer thread, which then has nothing to do.
    own.abort();
    HookCommandResult {
        exit_code: exit.code,
        stdout,
        stderr: exit.stderr,
        aborted: event.abort.is_aborted(),
        timed_out,
        overflowed,
        execution_failed: exit.spawn_error.is_some(),
    }
}

/// Told a handler's display name and event when it starts (`true`) and when it returns.
pub type HookObserver<'a> = &'a (dyn Fn(&str, HookEventName, bool) + Sync);

type CommandRunner = Box<dyn Fn(&CommandHook, &HookEvent) -> Result<HookCommandResult, String> + Send + Sync>;

struct State {
    commands: Vec<CommandHook>,
    /// The admitted `hooks.json` and where it lives; None for a runner built without one.
    config: Option<(PathBuf, Value)>,
}

pub struct HookRunner {
    logger: Logger,
    state: Mutex<State>,
    runner: CommandRunner,
    /// Serializes replacements, so two writers cannot interleave the file and the live set.
    writes: Mutex<()>,
}

impl HookRunner {
    /// A runner with these handlers and no file; `env` is what handlers run with.
    pub fn new(commands: Vec<CommandHook>, logger: Logger, env: Env) -> Self {
        Self::with_runner(commands, logger, Box::new(move |hook, event| Ok(run_command_hook(hook, event, &env))))
    }

    /// Test seam: handlers "run" through `runner` instead of bash.
    pub fn with_runner(commands: Vec<CommandHook>, logger: Logger, runner: CommandRunner) -> Self {
        Self { logger, state: Mutex::new(State { commands, config: None }), runner, writes: Mutex::new(()) }
    }

    /// Load `hooks.json`; a missing file is an empty document, a malformed one an error.
    pub fn from_config(path: &Path, logger: Logger, env: Env) -> Result<Self, String> {
        let shown = path.display().to_string();
        let load = || -> Result<Value, String> {
            let text = crate::private_file::read_text(path)?.unwrap_or_else(|| "{}".to_string());
            serde_json::from_str(&text).map_err(|error| error.to_string())
        };
        let document = load().map_err(|error| format!("Cannot load Ghost hooks from {shown}: {error}"))?;
        let commands = parse_hooks_document(&document, &shown)?;
        let runner = Self::new(commands, logger, env);
        runner.state.lock().unwrap().config = Some((path.to_path_buf(), document));
        Ok(runner)
    }

    /// The admitted `hooks.json`: its path and document.
    pub fn config(&self) -> Option<(PathBuf, Value)> {
        self.state.lock().unwrap().config.clone()
    }

    /// Admit `document` as the new `hooks.json`, write it through a temporary
    /// file and one rename, then swap the live handlers; they apply at the
    /// next boundary.
    pub fn replace_config(&self, document: Value) -> Result<(PathBuf, Value), String> {
        let _writing = self.writes.lock().unwrap();
        let path = self.config().map(|(path, _)| path).ok_or("This hook runner has no configuration file.")?;
        let commands = parse_hooks_document(&document, &path.display().to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        crate::private_file::write_json_atomic(&path, &document).map_err(|error| error.to_string())?;
        let mut state = self.state.lock().unwrap();
        state.commands = commands;
        state.config = Some((path.clone(), document.clone()));
        Ok((path, document))
    }

    fn handlers(&self, event: HookEventName) -> Vec<CommandHook> {
        self.state.lock().unwrap().commands.iter().filter(|hook| hook.event == event).cloned().collect()
    }

    pub fn has_handlers(&self, event: HookEventName) -> bool {
        self.state.lock().unwrap().commands.iter().any(|hook| hook.event == event)
    }

    fn run_fail_open(&self, hook: &CommandHook, event: &HookEvent) -> Option<StopResult> {
        let logger = self.logger.child(json!({ "ghost": event.payload["ghost_name"], "conversation": event.payload["conversation_id"] }));
        match (self.runner)(hook, event) {
            Ok(result) => parse_command_result(hook, &result, &|message, details| logger.warn(message, details)),
            Err(_) => {
                logger.warn(
                    &format!("{} hook failed open", hook.event.as_str()),
                    json!({ "source": hook.source, "error": "command execution failed" }),
                );
                None
            }
        }
    }

    /// Run every `turn_end` handler in file order; none can change anything.
    pub fn emit_turn_end(&self, event: &HookEvent) {
        for hook in self.handlers(HookEventName::TurnEnd) {
            self.run_fail_open(&hook, event);
        }
    }

    /// Run `session_stop` handlers in file order until one asks for another pass.
    pub fn emit_session_stop(&self, event: &HookEvent, observer: Option<HookObserver<'_>>) -> Option<StopResult> {
        if event.abort.is_aborted() {
            return None;
        }
        for hook in self.handlers(HookEventName::SessionStop) {
            if let Some(observe) = observer {
                observe(&hook.name, event.name, true);
            }
            let result = self.run_fail_open(&hook, event);
            if let Some(observe) = observer {
                observe(&hook.name, event.name, false);
            }
            if continuation(result.as_ref()).is_some() {
                return result;
            }
        }
        None
    }
}
