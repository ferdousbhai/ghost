//! `ghost say`: send a turn and print it as it streams, or queue a follow-up
//! into a running one.
use super::client::{DaemonClient, EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_SUCCESS};
use super::common::{
    conversation_id, id_of, latest_session, list_sessions, preferred_session_id, resolve_session, session_path, stdin_is_tty, stdin_text,
};
use super::output::{Rendered, dim, text_of, truncate};
use super::{CliError, Context};
use crate::abort::Abort;
use crate::http::percent_encode;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

// ── Ctrl-C ──────────────────────────────────────────────────────────────
//
// The turn outlives this process, so the first Ctrl-C asks ghostd to stop it
// and the command keeps reading: the stream then ends with the turn's own
// `aborted` error and the command exits 130. A second Ctrl-C ends the process.
//
// All of it is here. The signal handler does the one thing a handler safely
// can, setting a flag; `SA_RESETHAND` puts the default action back as the
// handler is entered, which is what makes the second Ctrl-C fatal. A watcher
// thread polls the flag and sends the stop request. Dropping the watch ends
// the watcher and restores the action that was in place before.

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_sigint(_signal: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}

struct InterruptWatch {
    previous: libc::sigaction,
    done: Abort,
    watcher: Option<JoinHandle<()>>,
}

impl InterruptWatch {
    /// Catch the next SIGINT and run `stop` once when it arrives.
    fn install(stop: impl FnOnce() + Send + 'static) -> Self {
        INTERRUPTED.store(false, Ordering::SeqCst);
        // SAFETY: both structs are plain data that zeroes initialise; the
        // handler only stores to an atomic, which is async-signal-safe.
        let previous = unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            let mut previous: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_sigint as extern "C" fn(libc::c_int) as libc::sighandler_t;
            action.sa_flags = libc::SA_RESETHAND | libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(libc::SIGINT, &action, &mut previous);
            previous
        };
        let done = Abort::new();
        let ended = done.clone();
        let watcher = std::thread::spawn(move || {
            while !INTERRUPTED.load(Ordering::SeqCst) {
                if ended.wait(Duration::from_millis(25)) {
                    return;
                }
            }
            stop();
        });
        Self { previous, done, watcher: Some(watcher) }
    }

    fn interrupted(&self) -> bool {
        INTERRUPTED.load(Ordering::SeqCst)
    }
}

impl Drop for InterruptWatch {
    fn drop(&mut self) {
        self.done.abort();
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        // SAFETY: `previous` is the action `sigaction` itself reported at install.
        unsafe {
            libc::sigaction(libc::SIGINT, &self.previous, std::ptr::null_mut());
        }
    }
}

// ── The turn ────────────────────────────────────────────────────────────

fn new_conversation_id() -> String {
    let stamp = u64::try_from(crate::clock::now_ms()).unwrap_or(0);
    format!("cli-{}-{}", crate::random::base36(stamp), crate::random::hex(&crate::random::bytes::<4>()))
}

/// The message: the words on the command line, or stdin when the only word
/// is `-` or there are none and stdin is not a terminal.
fn message_text(ctx: &mut Context) -> Result<String, CliError> {
    let words = &ctx.parsed.positionals;
    if words.len() == 1 && words[0] == "-" {
        return stdin_text(&mut ctx.runtime.stdin);
    }
    if !words.is_empty() {
        return Ok(words.join(" "));
    }
    if !stdin_is_tty(&ctx.runtime.stdin) {
        return stdin_text(&mut ctx.runtime.stdin);
    }
    Ok(String::new())
}

fn tool_name(event: &Value) -> &str {
    event.get("toolName").and_then(Value::as_str).unwrap_or("tool")
}

fn tool_description(event: &Value) -> String {
    let arguments = event.get("arguments").filter(|arguments| !arguments.is_null());
    let detail = match arguments.filter(|arguments| arguments.is_object()).and_then(|arguments| arguments.get("command")).and_then(Value::as_str) {
        Some(command) => command.split('\n').next().unwrap_or("").trim().to_string(),
        None => arguments.map_or_else(|| "{}".to_string(), Value::to_string),
    };
    format!("{}: {}", tool_name(event), truncate(&detail, 80))
}

/// Which conversation a fresh turn joins: `--new`, then `-s`/`$GHOST_SESSION`, then the latest.
fn turn_conversation_id(client: &mut DaemonClient, start_new: bool, requested: Option<&str>) -> Result<String, CliError> {
    if start_new {
        return Ok(new_conversation_id());
    }
    if let Some(requested) = requested {
        return conversation_id(client, requested);
    }
    Ok(latest_session(&list_sessions(client)?).map_or_else(new_conversation_id, |session| id_of(session).to_string()))
}

/// What one turn's events add up to, across the first stream and any resumed ones.
#[derive(Default)]
struct Turn {
    /// An owner `!command` streams as one bash card before any pass starts;
    /// its output is the card's summary (its tail), and it is this turn's
    /// whole answer. ghostd alone decides what a command is.
    pass_started: bool,
    owner_command: bool,
    final_text: String,
    /// The terminal event seen: true for `done`, false for `error`.
    done: Option<bool>,
    /// A long turn's response is cut, its last frame naming where the next resumes.
    resume: Option<(String, String)>,
}

impl Turn {
    fn on_event(&mut self, ctx: &mut Context, event: &Value) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let text = |key: &str| event.get(key).and_then(Value::as_str);
        if kind == "resume" {
            self.resume = Some((text_of(event.get("turn")), text_of(event.get("from"))));
            return;
        }
        if kind == "pass" {
            self.pass_started = true;
        } else if kind == "tool_execution_start" && !self.pass_started {
            self.owner_command = true;
        }
        if kind == "error" {
            self.done = Some(false);
            let why = match (text("errorMessage"), event.get("reason").filter(|reason| !reason.is_null())) {
                (Some(message), _) => message.to_string(),
                (None, Some(reason)) => text_of(Some(reason)),
                (None, None) => "turn failed".to_string(),
            };
            ctx.err(&format!("ghost: {why}\n"));
        } else if kind == "done" && self.done != Some(false) {
            self.done = Some(true);
        }
        ctx.emit(event, || {
            let (mut human, mut quiet) = (String::new(), String::new());
            match kind {
                // A new text block after a tool call or another block starts its own paragraph.
                "text_start" if !self.final_text.is_empty() => {
                    self.final_text.push_str("\n\n");
                    human = "\n\n".to_string();
                }
                "text_delta" => {
                    human = text("delta").unwrap_or("").to_string();
                    self.final_text.push_str(&human);
                }
                "owner_message" => human = text("text").map_or_else(String::new, |text| format!("{text}\n")),
                "session_stop_continued" => human = text("reason").map_or_else(String::new, |reason| format!("Stop hook · {reason}\n")),
                "tool_execution_end" if self.owner_command => {
                    human = text("summary").map_or_else(String::new, |summary| format!("{summary}\n"));
                    quiet = human.clone();
                }
                "done" => {
                    let newline = if self.final_text.ends_with('\n') { "" } else { "\n" };
                    if !self.final_text.is_empty() {
                        human = newline.to_string();
                        quiet = format!("{}{newline}", self.final_text);
                    }
                }
                _ => {}
            }
            Rendered::Both { human, quiet }
        });
        let secondary = !ctx.parsed.boolean("json") && !ctx.parsed.boolean("quiet");
        let tty = ctx.runtime.stdout_is_tty;
        if secondary && kind == "tool_execution_start" {
            ctx.err(&format!("{}\n", dim(&format!("⚙ {}", tool_description(event)), tty)));
        } else if secondary && kind == "tool_execution_end" && event.get("isError") == Some(&Value::Bool(true)) && !self.owner_command {
            let summary = text("summary").map_or_else(String::new, |summary| format!(": {}", truncate(summary, 80)));
            ctx.err(&format!("{}\n", dim(&format!("✗ {}{summary}", tool_name(event)), tty)));
        }
    }
}

pub fn say_command(ctx: &mut Context) -> Result<i32, CliError> {
    let follow_up = ctx.parsed.boolean("follow-up");
    let start_new = ctx.parsed.boolean("new");
    if follow_up && start_new {
        return Err(CliError::usage("--new and --follow-up are mutually exclusive"));
    }
    let text = message_text(ctx)?;
    if text.trim().is_empty() {
        return Err(CliError::usage("Message text cannot be empty."));
    }
    let requested = preferred_session_id(ctx);
    // The stream borrows the runtime for printing, so the client is this command's own from here.
    let mut client = ctx.client()?.clone();

    // The conversation an idle --follow-up turns into a fresh turn of.
    let mut idle_follow_up = None;
    if follow_up {
        let id = match &requested {
            Some(requested) => conversation_id(&mut client, requested)?,
            None => id_of(&resolve_session(&mut client, None)?).to_string(),
        };
        match client.request("POST", &session_path(&id, "/queue"), Some(&json!({ "text": text }))) {
            Ok(response) => {
                ctx.emit(&response, || Rendered::Secondary(format!("Queued for {id}.\n")));
                return Ok(EXIT_SUCCESS);
            }
            // A follow-up to an idle conversation is its next turn: this is how a
            // background command wakes the ghost that started it.
            Err(error) if error.code.as_deref() == Some("session_not_streaming") => idle_follow_up = Some(id),
            Err(error) => return Err(error),
        }
    }
    let session_id = match idle_follow_up {
        Some(id) => id,
        None => turn_conversation_id(&mut client, start_new, requested.as_deref())?,
    };

    let mut stopper = client.clone();
    let stop_path = session_path(&session_id, "/stop");
    let watch = InterruptWatch::install(move || {
        let _ = stopper.request("POST", &stop_path, Some(&json!({})));
    });
    let mut turn = Turn::default();
    client.stream("/api/messages", Some(&json!({ "prompt": text, "sessionId": session_id })), &mut |event| turn.on_event(ctx, event))?;
    while let Some((turn_id, from)) = turn.resume.take() {
        let path = session_path(&session_id, &format!("/stream?turn={}&from={from}", percent_encode(&turn_id)));
        client.stream(&path, None, &mut |event| turn.on_event(ctx, event))?;
    }
    let interrupted = watch.interrupted();
    drop(watch);
    if turn.done.is_none() {
        ctx.err("ghost: turn stream ended without a terminal event\n");
    }
    if interrupted {
        return Ok(EXIT_INTERRUPTED);
    }
    Ok(if turn.done == Some(true) { EXIT_SUCCESS } else { EXIT_FAILURE })
}
