//! `ghost say`: send a turn and print it as it streams, or queue a follow-up
//! into a running one.
use super::common::stdin_text;
use super::output::{Rendered, dim};
use super::{CliError, Context, EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_SUCCESS};
use crate::abort::Abort;
use crate::client::ClientError;
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
    let (words, stdin) = (&ctx.parsed.positionals, &mut ctx.runtime.stdin);
    match words.as_slice() {
        [] if stdin.is_tty => Ok(String::new()),
        [] => stdin_text(stdin, None).map_err(CliError::failure),
        [only] if only == "-" => stdin_text(stdin, None).map_err(CliError::failure),
        words => Ok(words.join(" ")),
    }
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

/// What one turn's events add up to.
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
    /// Reasoning as it streams, printed whole when something else follows it.
    thinking: String,
}

impl Turn {
    fn on_event(&mut self, ctx: &mut Context, event: &Value) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let text = |key: &str| event.get(key).and_then(Value::as_str);
        if kind == "pass" {
            self.pass_started = true;
        } else if kind == "tool_execution_start" && !self.pass_started {
            self.owner_command = true;
        }
        if kind == "error" {
            self.done = Some(false);
            let why = text("errorMessage").or(text("reason")).unwrap_or("turn failed");
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

/// How long a follow-up waits for a conversation that is busy with something it cannot join.
const FOLLOW_UP_PATIENCE: std::time::Duration = std::time::Duration::from_secs(600);
const FOLLOW_UP_RETRY: std::time::Duration = std::time::Duration::from_millis(if cfg!(test) { 10 } else { 1000 });

pub fn say_command(ctx: &mut Context) -> Result<i32, CliError> {
    let follow_up = ctx.parsed.boolean("follow-up");
    let text = message_text(ctx)?;
    if text.trim().is_empty() {
        return Err(CliError::usage("Message text cannot be empty."));
    }
    // The stream borrows the runtime for printing, so the client is this command's own from here.
    let (mut client, timeout) = (ctx.client()?.clone(), Some(ctx.timeout));

    let busy = |error: &ClientError| matches!(error, ClientError::Status { code: Some(code), .. } if code == "conversation_busy");
    // A follow-up is often a background command waking the ghost with nobody watching, so it is not lost to a
    // conversation that is between turns or running the owner's own command: it waits for it.
    let waited = std::time::Instant::now();
    let patient = |error: &ClientError| follow_up && busy(error) && waited.elapsed() < FOLLOW_UP_PATIENCE;

    let mut stopper = client.clone();
    let watch = InterruptWatch::install(move || {
        let _ = stopper.request("POST", "/api/conversation/stop", Some(&json!({})), timeout);
    });
    let mut turn = Turn::default();
    loop {
        if follow_up {
            match client.request("POST", "/api/conversation/queue", Some(&json!({ "text": text })), timeout) {
                Ok(response) => {
                    ctx.emit(&response, || Rendered::Secondary("Queued.\n".to_string()));
                    return Ok(EXIT_SUCCESS);
                }
                // A follow-up with no turn running is the next turn: this is how a
                // background command wakes the ghost that started it.
                Err(ClientError::Status { code: Some(code), .. }) if code == "conversation_not_streaming" => {}
                Err(error) if patient(&error) && !watch.interrupted() => {
                    std::thread::sleep(FOLLOW_UP_RETRY);
                    continue;
                }
                Err(error) => return Err(error.into()),
            }
        }
        match client.stream("/api/messages", Some(&json!({ "prompt": text })), None, &mut |event| turn.on_event(ctx, event)) {
            Err(error) if patient(&error) && !watch.interrupted() => std::thread::sleep(FOLLOW_UP_RETRY),
            sent => break sent?,
        }
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
