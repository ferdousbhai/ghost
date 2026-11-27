//! `ghost say`: send a turn and print it as it streams, or queue a follow-up
//! into a running one.
use super::client::{EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_SUCCESS};
use super::common::{stdin_is_tty, stdin_text};
use super::output::{Rendered, dim, text_of};
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

/// A call as it is shown: a command whole, as a shell would echo it; anything else by name and arguments.
fn tool_description(event: &Value) -> String {
    // The question and its answers are the reply itself.
    if tool_name(event) == "ask" {
        return "⚙ ask".to_string();
    }
    let arguments = event.get("arguments").filter(|arguments| !arguments.is_null());
    match arguments.filter(|arguments| arguments.is_object()).and_then(|arguments| arguments.get("command")).and_then(Value::as_str) {
        Some(command) => format!("$ {}", command.trim()),
        None => format!("⚙ {}: {}", tool_name(event), arguments.map_or_else(|| "{}".to_string(), Value::to_string)),
    }
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
    /// Reasoning as it streams, printed whole when something else follows it.
    thinking: String,
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
        // Everything else the turn holds goes to stderr, dimmed and whole: the
        // model's reasoning, each command, and what the command printed.
        let secondary = !ctx.parsed.boolean("json") && !ctx.parsed.boolean("quiet");
        let tty = ctx.runtime.stdout_is_tty;
        if !secondary {
            return;
        }
        if kind == "thinking" {
            self.thinking.push_str(text("delta").unwrap_or(""));
            return;
        }
        let thought = std::mem::take(&mut self.thinking);
        if !thought.trim().is_empty() {
            ctx.err(&format!("{}\n", dim(thought.trim(), tty)));
        }
        if kind == "tool_execution_start" {
            ctx.err(&format!("{}\n", dim(&tool_description(event), tty)));
        } else if kind == "tool_execution_end" && !self.owner_command {
            if let Some(output) = text("output").map(str::trim_end).filter(|output| !output.is_empty()) {
                ctx.err(&format!("{}\n", dim(output, tty)));
            }
            if event.get("isError") == Some(&Value::Bool(true)) {
                ctx.err(&format!("{}\n", dim(&format!("✗ {}", tool_name(event)), tty)));
            }
        }
    }
}

pub fn say_command(ctx: &mut Context) -> Result<i32, CliError> {
    let follow_up = ctx.parsed.boolean("follow-up");
    let text = message_text(ctx)?;
    if text.trim().is_empty() {
        return Err(CliError::usage("Message text cannot be empty."));
    }
    // The stream borrows the runtime for printing, so the client is this command's own from here.
    let mut client = ctx.client()?.clone();

    if follow_up {
        match client.request("POST", "/api/conversation/queue", Some(&json!({ "text": text }))) {
            Ok(response) => {
                ctx.emit(&response, || Rendered::Secondary("Queued.\n".to_string()));
                return Ok(EXIT_SUCCESS);
            }
            // A follow-up with no turn running is the next turn: this is how a
            // background command wakes the ghost that started it.
            Err(error) if error.code.as_deref() == Some("conversation_not_streaming") => {}
            Err(error) => return Err(error),
        }
    }

    let mut stopper = client.clone();
    let watch = InterruptWatch::install(move || {
        let _ = stopper.request("POST", "/api/conversation/stop", Some(&json!({})));
    });
    let mut turn = Turn::default();
    client.stream("/api/messages", Some(&json!({ "prompt": text })), &mut |event| turn.on_event(ctx, event))?;
    while let Some((turn_id, from)) = turn.resume.take() {
        let path = format!("/api/conversation/stream?turn={}&from={from}", percent_encode(&turn_id));
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
