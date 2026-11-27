//! The owner's command hook (docs/hooks.md): `session_stop`, awaited after a
//! pass and able to continue it. This module admits `hooks.json`, runs a
//! handler, and reads its answer; every failure of a handler fails open.
use crate::abort::Abort;
use crate::env::Env;
use crate::log::Logger;
use crate::process::{ProcessOptions, run_process};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The one event: its key in `hooks.json` and its name on the wire.
pub const SESSION_STOP: &str = "session_stop";
const DEFAULT_NAME: &str = "Session-stop command hook";
const DEFAULT_DESCRIPTION: &str = "Runs after the assistant pass and may continue it.";
const DEFAULT_TIMEOUT_SECONDS: f64 = 30.0;
const MAX_HOOK_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct CommandHook {
    pub command: String,
    pub name: String,
    pub description: String,
    pub timeout_ms: u64,
    pub source: String,
}

/// What handlers are handed: the event's JSON payload (docs/hooks.md), where
/// they run, and the turn's stop signal.
pub struct HookEvent {
    pub payload: Value,
    pub cwd: PathBuf,
    pub abort: Abort,
}

fn display_text(value: Option<&Value>, fallback: &str, label: &str, maximum: usize) -> Result<String, String> {
    let Some(value) = value else { return Ok(fallback.to_string()) };
    match value.as_str().map(str::trim) {
        Some(text) if !text.is_empty() && crate::text::len(text) <= maximum => Ok(text.to_string()),
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
    if let Some(unknown) = hooks.keys().find(|key| *key != SESSION_STOP) {
        return Err(format!("{path}: unsupported hook event {}.", quoted(unknown)));
    }
    let Some(groups) = hooks.get(SESSION_STOP) else { return Ok(Vec::new()) };
    let groups = groups.as_array().ok_or_else(|| format!("{path}: \"hooks.{SESSION_STOP}\" must be an array."))?;
    let mut result = Vec::new();
    for (group_index, group) in groups.iter().enumerate() {
        let handlers = group.get("hooks").and_then(Value::as_array).filter(|_| group.is_object());
        let handlers = handlers.ok_or_else(|| format!("{path}: hooks.{SESSION_STOP}[{group_index}].hooks must be an array."))?;
        for (handler_index, raw) in handlers.iter().enumerate() {
            let label = format!("hooks.{SESSION_STOP}[{group_index}].hooks[{handler_index}]");
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
            result.push(CommandHook {
                command: command.to_string(),
                name: display_text(raw.get("name"), DEFAULT_NAME, &format!("{path}: {label}.name"), 80)?,
                description: display_text(raw.get("description"), DEFAULT_DESCRIPTION, &format!("{path}: {label}.description"), 240)?,
                timeout_ms: (timeout * 1000.0).floor() as u64,
                source: format!("{path}#{label}"),
            });
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

/// Read a handler's outcome: the text the next pass is given, when the handler
/// asked for one. Anything but a clean answer warns and fails open.
fn parse_command_result(hook: &CommandHook, result: &HookCommandResult, warn: &dyn Fn(&str, Value)) -> Option<String> {
    if result.aborted {
        return None;
    }
    if result.execution_failed {
        warn(&format!("{SESSION_STOP} hook failed open"), json!({ "source": hook.source, "error": "command execution failed" }));
        return None;
    }
    if result.timed_out {
        warn(&format!("{SESSION_STOP} hook timed out"), json!({ "source": hook.source, "timeoutMs": hook.timeout_ms }));
        return None;
    }
    if result.overflowed {
        warn(&format!("{SESSION_STOP} hook wrote more than 1 MB"), json!({ "source": hook.source }));
        return None;
    }
    if result.exit_code == Some(2) {
        let reason = result.stderr.trim();
        return Some(if reason.is_empty() { "A Ghost hook blocked the stop." } else { reason }.to_string());
    }
    if result.exit_code != Some(0) {
        warn(&format!("{SESSION_STOP} hook failed open"), json!({ "source": hook.source, "exitCode": result.exit_code }));
        return None;
    }
    let output = result.stdout.trim();
    if output.is_empty() {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(output).ok().filter(Value::is_object);
    let decision = parsed.as_ref().and_then(|parsed| parsed.get("decision"));
    let Some(parsed) = parsed.as_ref().filter(|_| decision.is_none_or(|decision| decision == "block")) else {
        warn(&format!("{SESSION_STOP} hook returned invalid JSON"), json!({ "source": hook.source, "error": "invalid hook output" }));
        return None;
    };
    let text = |key: &str| parsed.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string);
    // `continue` prefers the context, a block its reason; an empty one falls back to the other.
    if parsed.get("continue") == Some(&Value::Bool(true)) {
        text("additionalContext").or_else(|| text("reason"))
    } else if decision.is_some() {
        text("reason").or_else(|| text("additionalContext"))
    } else {
        None
    }
}

/// One hook command in bash, as its own process group: the event as JSON on
/// stdin, ended on abort, timeout, or more than 1 MB of stdout.
fn run_command_hook(hook: &CommandHook, event: &HookEvent, env: &Env) -> HookCommandResult {
    // Its own stop, so that too much output ends the command and not the turn.
    let (own, _link) = event.abort.child();
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
            timeout: Some(Duration::from_millis(hook.timeout_ms)),
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
    HookCommandResult {
        exit_code: exit.code,
        stdout,
        stderr: exit.stderr,
        aborted: event.abort.is_aborted(),
        timed_out: exit.timed_out,
        overflowed,
        execution_failed: exit.spawn_error.is_some(),
    }
}

/// Told a handler's display name when it starts (`true`) and when it returns.
pub type HookObserver<'a> = &'a (dyn Fn(&str, bool) + Sync);

type CommandRunner = Box<dyn Fn(&CommandHook, &HookEvent) -> HookCommandResult + Send + Sync>;

/// The admitted `hooks.json`: where it lives, the document, and its handlers.
struct State {
    path: PathBuf,
    document: Value,
    commands: Vec<CommandHook>,
}

pub struct HookRunner {
    logger: Logger,
    state: Mutex<State>,
    runner: CommandRunner,
    /// Serializes replacements, so two writers cannot interleave the file and the live set.
    writes: Mutex<()>,
}

impl HookRunner {
    /// Load `hooks.json`; a missing file is an empty document, a malformed one an error.
    /// `env` is what handlers run with.
    pub fn from_config(path: &Path, logger: Logger, env: Env) -> Result<Self, String> {
        let shown = path.display().to_string();
        let load = || -> Result<Value, String> {
            let text = crate::private_file::read_text(path)?.unwrap_or_else(|| "{}".to_string());
            serde_json::from_str(&text).map_err(|error| error.to_string())
        };
        let document = load().map_err(|error| format!("Cannot load Ghost hooks from {shown}: {error}"))?;
        Self::admit(path.to_path_buf(), document, logger, Box::new(move |hook, event| run_command_hook(hook, event, &env)))
    }

    /// Test seam: `document` as if it were the file at `test`, its handlers
    /// "run" through `runner` instead of bash.
    #[cfg(test)]
    pub(crate) fn with_runner(document: Value, logger: Logger, runner: CommandRunner) -> Self {
        Self::admit(PathBuf::from("test"), document, logger, runner).expect("an admissible document")
    }

    fn admit(path: PathBuf, document: Value, logger: Logger, runner: CommandRunner) -> Result<Self, String> {
        let commands = parse_hooks_document(&document, &path.display().to_string())?;
        Ok(Self { logger, state: Mutex::new(State { path, document, commands }), runner, writes: Mutex::new(()) })
    }

    /// The admitted `hooks.json`: its path and document.
    pub fn config(&self) -> (PathBuf, Value) {
        let state = self.state.lock().unwrap();
        (state.path.clone(), state.document.clone())
    }

    /// Admit `document` as the new `hooks.json`, write it through a temporary
    /// file and one rename, then swap the live handlers; they apply at the
    /// next boundary.
    pub fn replace_config(&self, document: Value) -> Result<(PathBuf, Value), String> {
        let _writing = self.writes.lock().unwrap();
        let path = self.state.lock().unwrap().path.clone();
        let commands = parse_hooks_document(&document, &path.display().to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        crate::private_file::write_json_atomic(&path, &document).map_err(|error| error.to_string())?;
        let mut state = self.state.lock().unwrap();
        state.commands = commands;
        state.document = document.clone();
        Ok((path, document))
    }

    pub fn has_handlers(&self) -> bool {
        !self.state.lock().unwrap().commands.is_empty()
    }

    /// Run the handlers in file order until one asks for another pass;
    /// returns the text that pass is given.
    pub fn emit_session_stop(&self, event: &HookEvent, observer: Option<HookObserver<'_>>) -> Option<String> {
        if event.abort.is_aborted() {
            return None;
        }
        let logger = self.logger.child(json!({ "ghost": event.payload["ghost_name"] }));
        let handlers = self.state.lock().unwrap().commands.clone();
        for hook in handlers {
            if let Some(observe) = observer {
                observe(&hook.name, true);
            }
            let result = (self.runner)(&hook, event);
            let continuation = parse_command_result(&hook, &result, &|message, details| logger.warn(message, details));
            if let Some(observe) = observer {
                observe(&hook.name, false);
            }
            if continuation.is_some() {
                return continuation;
            }
        }
        None
    }
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;
