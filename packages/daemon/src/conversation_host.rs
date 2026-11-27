//! The ghost's one conversation, as ghostd hosts it: each turn runs on the
//! local model (`local_turn.rs`) in the conversation directory with the ghost's
//! persona, its output streamed to the client and recorded in the conversation
//! log. ghostd owns the persona, the log, the owner's hooks, and the ghost's
//! lifecycle; nothing of a turn leaves the machine unless a command the model
//! runs sends it.
use crate::abort::Abort;
use crate::attachments::{Attachment, read_attachment, save_attachment};
use crate::clock;
use crate::coding_agent::{choose_coding_agent, coding_agent_command};
use crate::conversation_log::{AssistantPart, IndexedLog, LogEntry, Origin, append_log, log_path, new_conversation_entry, read_log};
use crate::env::Env;
use crate::error::{GhostError, Result};
use crate::ghosts::{Ghost, ghost_paths};
use crate::home::read_character;
use crate::hooks::{HookEvent, HookEventName, HookRunner, continuation};
use crate::local_model::LocalModel;
use crate::local_turn::{Answerer, LocalAnswerer, PassEvent, PassInput, conversation_messages};
use crate::log::Logger;
use crate::persona::{GhostSystemPromptInput, build_ghost_system_prompt, is_seeded_character};
use crate::process::{ProcessOptions, run_process, signal_name};
use crate::prompt_policy::stable_policy_sections;
use crate::sidecars::{OwnerQuestion, read_question, read_read_at, remove_question, write_question, write_read_at};
use crate::text;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Same prefix Claude Code and Codex put on Stop-hook continuation prompts.
const STOP_HOOK_FEEDBACK_PREFIX: &str = "Stop hook feedback:\n";
/// The live tail of a tool's output shown on its card.
const TOOL_SUMMARY_MAX: usize = 800;
const MAX_QUESTION_LENGTH: usize = 2_000;
const MAX_QUESTION_OPTIONS: usize = 6;
const MAX_QUESTION_OPTION_LENGTH: usize = 120;
const DEFAULT_TRANSCRIPT_LIMIT: usize = 1_000;
const MAX_TRANSCRIPT_LIMIT: usize = 2_000;
const NO_LOCAL_MODEL: &str = "No local model is configured: set `local.model` in ~/.config/ghost/config.json.";

/// Where a turn's events go (the turn wire, CONTRACTS.md).
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;
type AppUrl = Box<dyn Fn() -> Option<String> + Send + Sync>;
type CodingAgent = Box<dyn Fn() -> Option<String> + Send + Sync>;

pub struct ConversationHostOptions {
    /// The machine's one ghost.
    pub ghost: Ghost,
    pub owner_home: PathBuf,
    pub logger: Logger,
    pub hooks: Arc<HookRunner>,
    /// The app's link to this machine, for an alert's `url`.
    pub app_url: Option<AppUrl>,
    /// The model ghostd runs (CONTRACTS.md "Local model"); without one no turn can run.
    pub local_model: Option<LocalModel>,
    /// What answers in place of the local model; a test supplies a script.
    pub answerer: Option<Arc<dyn Answerer>>,
    /// The owner's coding agent, which a turn's prompt names; None asks Omarchy.
    pub coding_agent: Option<CodingAgent>,
    /// The environment commands run with.
    pub env: Env,
    /// The owner's devices that get an alert when a turn ends; None alerts none.
    pub push: Option<Arc<crate::push::Push>>,
}

struct LiveTurn {
    /// The owner's queued messages, in order, which a client shows.
    follow_ups: Vec<String>,
    /// The turn's own stream, which announces each change to `follow_ups`.
    emit: Emit,
}

struct Listener {
    id: u64,
    listen: Arc<dyn Fn(&Value) + Send + Sync>,
    close: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
struct State {
    /// The running turn, while it takes follow-ups; an owner `!command` has none.
    live: Option<LiveTurn>,
    /// The admitted turn's stop: the turn outlives its client, so only `stop_turn` or shutdown ends it early.
    admission: Option<Abort>,
    /// While it is being trashed the conversation admits no turn and no other mutation.
    reserved: bool,
    listeners: Vec<Listener>,
    next_listener: u64,
    shutting_down: bool,
    /// How much of the model's context the conversation filled at its last
    /// round, in tokens as the server counted them, and in characters.
    context: Option<(u64, usize)>,
    /// The last turn was sent only the conversation's newest part, for want of room: it is due a handoff note.
    outgrown: bool,
    /// The handoff note being written in the background, with its own stop.
    handoff: Option<(u64, Abort)>,
    next_handoff: u64,
}

struct Inner {
    ghost: Ghost,
    owner_home: PathBuf,
    logger: Logger,
    hooks: Arc<HookRunner>,
    app_url: Option<AppUrl>,
    answerer: Option<Arc<dyn Answerer>>,
    coding_agent: CodingAgent,
    local_model: Option<LocalModel>,
    env: Env,
    push: Option<Arc<crate::push::Push>>,
    /// The log as `GET /api/conversation` and the transcript read it.
    log: IndexedLog,
    state: Mutex<State>,
    /// Serializes read-marker rewrites, so two of them cannot interleave a read and a write.
    metadata: Mutex<()>,
    /// Signalled when a handoff note stops being written.
    handoff_done: std::sync::Condvar,
}

#[derive(Clone)]
pub struct ConversationHost {
    inner: Arc<Inner>,
}

/// An admitted turn: the conversation is held until `run` returns.
pub struct TurnAdmission {
    host: ConversationHost,
    prompt: String,
    command: Option<OwnerCommand>,
    abort: Abort,
}

#[derive(Clone)]
struct OwnerCommand {
    command: String,
    excluded: bool,
}

/// One pass: what it said and did, and how it ended.
struct PassResult {
    content: Vec<AssistantPart>,
    error: Option<String>,
    aborted: bool,
}

fn tail(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if text::len(trimmed) > TOOL_SUMMARY_MAX { format!("…{}", text::suffix(trimmed, TOOL_SUMMARY_MAX)) } else { trimmed.to_string() })
}

/// An owner `!command` (`!!` keeps it out of the ghost's context), or None for
/// a prompt. A message that opens with an attached photo, `![image](…)`, is a
/// prompt.
fn owner_command(prompt: &str) -> Option<OwnerCommand> {
    let trimmed = prompt.trim();
    if trimmed.starts_with("![") {
        return None;
    }
    let (rest, excluded) = match trimmed.strip_prefix("!!") {
        Some(rest) => (rest, true),
        None => (trimmed.strip_prefix('!')?, false),
    };
    Some(OwnerCommand { command: rest.trim_start().to_string(), excluded })
}

fn error_event(reason: &str, message: &str) -> Value {
    json!({ "type": "error", "reason": reason, "errorMessage": message })
}

fn internal(error: impl std::fmt::Display) -> GhostError {
    GhostError::internal(error.to_string())
}

/// A question as asked: trimmed, bounded, options deduplicated in order.
fn valid_question(text: &str, options: &[String]) -> Result<OwnerQuestion> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(GhostError::invalid("A question needs text."));
    }
    if text::len(trimmed) > MAX_QUESTION_LENGTH {
        return Err(GhostError::invalid(format!("A question must be at most {MAX_QUESTION_LENGTH} characters.")));
    }
    let mut kept: Vec<String> = Vec::new();
    for option in options.iter().map(|option| option.trim()).filter(|option| !option.is_empty()) {
        if !kept.iter().any(|seen| seen == option) {
            kept.push(option.to_string());
        }
    }
    if kept.len() > MAX_QUESTION_OPTIONS {
        return Err(GhostError::invalid(format!("A question takes at most {MAX_QUESTION_OPTIONS} options.")));
    }
    if kept.iter().any(|option| text::len(option) > MAX_QUESTION_OPTION_LENGTH) {
        return Err(GhostError::invalid(format!("Each option must be at most {MAX_QUESTION_OPTION_LENGTH} characters.")));
    }
    Ok(OwnerQuestion { text: trimmed.to_string(), options: kept, asked_at: clock::now_iso() })
}

fn clamp(value: Option<f64>, fallback: usize, max: usize) -> usize {
    match value {
        Some(value) if value.is_finite() => value.floor().clamp(0.0, max as f64) as usize,
        _ => fallback,
    }
}

impl ConversationHost {
    pub fn new(options: ConversationHostOptions) -> Self {
        let answerer = options.answerer.or_else(|| options.local_model.clone().map(|model| Arc::new(LocalAnswerer { model }) as Arc<dyn Answerer>));
        let env = options.env;
        let agent_env = env.clone();
        let coding_agent = options.coding_agent.unwrap_or_else(|| Box::new(move || choose_coding_agent(&agent_env)));
        let log = IndexedLog::new(&ghost_paths(&options.ghost.dir).conversation_dir);
        Self {
            inner: Arc::new(Inner {
                ghost: options.ghost,
                owner_home: options.owner_home,
                logger: options.logger,
                hooks: options.hooks,
                app_url: options.app_url,
                answerer,
                coding_agent,
                local_model: options.local_model,
                env,
                push: options.push,
                log,
                state: Mutex::new(State::default()),
                metadata: Mutex::new(()),
                handoff_done: std::sync::Condvar::new(),
            }),
        }
    }

    /// The conversation directory: where the model's commands run, holding the log and the sidecars.
    fn dir(&self) -> PathBuf {
        ghost_paths(&self.inner.ghost.dir).conversation_dir
    }

    // ── Conversation events ────────────────────────────────────────────

    /// Hear every change to the conversation until `unsubscribe`; `close` is called at shutdown.
    pub fn subscribe(&self, listen: impl Fn(&Value) + Send + Sync + 'static, close: impl Fn() + Send + Sync + 'static) -> u64 {
        let mut state = self.inner.state.lock().unwrap();
        state.next_listener += 1;
        let id = state.next_listener;
        state.listeners.push(Listener { id, listen: Arc::new(listen), close: Arc::new(close) });
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.inner.state.lock().unwrap().listeners.retain(|listener| listener.id != id);
    }

    fn announce(&self) {
        let event = json!({ "type": "conversation-updated", "updatedAt": clock::now_iso() });
        let listeners: Vec<_> = self.inner.state.lock().unwrap().listeners.iter().map(|listener| listener.listen.clone()).collect();
        for listen in listeners {
            listen(&event);
        }
    }

    // ── Persona ───────────────────────────────────────────────────────

    /// The ghost's whole system prompt: its character and the stable policy sections.
    /// Rendered before every turn, so a character the ghost (or the owner)
    /// rewrote is who it is on the next one.
    pub fn render_persona(&self) -> Result<String> {
        let ghost = &self.inner.ghost;
        let character = read_character(&ghost.dir, true)?;
        let documents = crate::xdg::documents_dir(&self.inner.env, &self.inner.owner_home);
        let first_meeting = is_seeded_character(&ghost.name(), character.as_ref().map(|character| character.body.as_str()));
        let sections = stable_policy_sections(&documents, first_meeting);
        Ok(build_ghost_system_prompt(&GhostSystemPromptInput {
            ghost_name: &ghost.name(),
            character: character.as_ref(),
            home_dir: &ghost.dir,
            extra_sections: &sections,
        }))
    }

    // ── Turns ─────────────────────────────────────────────────────────

    /// Take the conversation for one turn, or refuse: it is busy, being deleted, or the daemon is stopping.
    pub fn admit_turn(&self, prompt: &str) -> Result<TurnAdmission> {
        let command = owner_command(prompt);
        let abort = Abort::new();
        let mut state = self.inner.state.lock().unwrap();
        if state.shutting_down {
            return Err(GhostError::new("shutting_down", "ghostd is shutting down.", 503));
        }
        if state.admission.is_some() || state.reserved {
            return Err(GhostError::new("conversation_busy", "The ghost is already answering.", 409));
        }
        if command.as_ref().is_some_and(|command| command.command.is_empty()) {
            return Err(GhostError::invalid("Write a command after ! or !!."));
        }
        state.admission = Some(abort.clone());
        Ok(TurnAdmission { host: self.clone(), prompt: prompt.to_string(), command, abort })
    }

    /// admit_turn then run, in one call, for tests.
    pub fn run_turn(&self, prompt: &str, emit: Emit) -> Result<()> {
        self.admit_turn(prompt)?.run(emit);
        Ok(())
    }

    fn run_admitted(&self, prompt: &str, command: Option<&OwnerCommand>, emit: &Emit, abort: &Abort) -> Result<Value> {
        let dir = self.dir();
        if !log_path(&dir).exists() {
            append_log(&dir, &[new_conversation_entry(clock::now_ms())])?;
        }
        emit(json!({ "type": "start" }));
        if let Some(command) = command {
            self.announce();
            return self.run_owner_command(command, emit, abort);
        }
        self.inner.state.lock().unwrap().live = Some(LiveTurn { follow_ups: Vec::new(), emit: emit.clone() });
        // The id of the owner request a pass answers, which `session_stop` reports.
        let mut turn_id = crate::random::uuid();
        let outcome = self.run_passes(prompt, emit, abort, &mut turn_id);
        self.inner.state.lock().unwrap().live = None;
        let terminal = outcome.unwrap_or_else(|error| {
            self.inner.logger.error("turn failed", json!({ "ghost": self.inner.ghost.name(), "error": error.message }));
            error_event(if abort.is_aborted() { "aborted" } else { "error" }, &error.message)
        });
        Ok(terminal)
    }

    fn queued(&self) -> usize {
        self.inner.state.lock().unwrap().live.as_ref().map_or(0, |turn| turn.follow_ups.len())
    }

    /// The passes of one turn: the prompt, then each stop-hook continuation and queued follow-up.
    fn run_passes(&self, prompt: &str, emit: &Emit, abort: &Abort, turn_id: &mut String) -> Result<Value> {
        let dir = self.dir();
        let mut blocks = 0usize;
        let mut terminal = json!({ "type": "done" });
        let mut next: Option<(String, Option<Origin>)> = Some((prompt.to_string(), None));
        let mut owner_prompt = prompt.to_string();
        while let Some((text, origin)) = next.take() {
            if abort.is_aborted() {
                break;
            }
            let from_hook = matches!(origin, Some(Origin::Hook));
            if matches!(origin, Some(Origin::FollowUp)) {
                *turn_id = crate::random::uuid();
                owner_prompt = text.clone();
            }
            append_log(&dir, &[LogEntry::user(text.clone(), origin)])?;
            // The owner's message answers what the ghost was waiting on.
            if !from_hook {
                remove_question(&dir)?;
            }
            // Other clients learn the turn is running with its prompt already readable.
            self.announce();
            let failure = self.run_turn_on_model(&text, emit, &mut blocks, abort)?;
            // A failed pass ends the turn only when nothing is queued behind it:
            // the owner's follow-ups were accepted and still run.
            let failed = failure.is_some();
            terminal = failure.unwrap_or_else(|| json!({ "type": "done" }));
            if failed && (abort.is_aborted() || self.queued() == 0) {
                break;
            }
            // The owner's own queued message is the next instruction: a stop hook
            // is not asked while one waits, and loses to one sent while it ran.
            // Nor while the ghost's own question waits (its `ask` tool): the turn is
            // waiting on the owner, and a hook's "keep going" is not their answer.
            let continued = if failed || self.queued() > 0 || read_question(&dir).is_some() {
                None
            } else {
                self.session_stop(&owner_prompt, turn_id, from_hook, abort, emit)?
            };
            if let Some(reason) = continued
                && self.queued() == 0
            {
                emit(json!({ "type": "session_stop_continued", "reason": reason }));
                next = Some((reason, Some(Origin::Hook)));
                continue;
            }
            let follow_up = {
                let mut state = self.inner.state.lock().unwrap();
                state.live.as_mut().filter(|turn| !turn.follow_ups.is_empty()).map(|turn| (turn.follow_ups.remove(0), turn.follow_ups.clone()))
            };
            if let Some((text, waiting)) = follow_up {
                emit(json!({ "type": "queue", "followUp": waiting }));
                emit(json!({ "type": "owner_message", "text": text }));
                next = Some((text, Some(Origin::FollowUp)));
            }
        }
        if abort.is_aborted() && terminal["type"] == "done" {
            terminal = error_event("aborted", "Turn aborted.");
        }
        Ok(terminal)
    }

    /// The model's context, in tokens.
    fn context_size(&self) -> u64 {
        self.inner.local_model.as_ref().map_or(crate::config::DEFAULT_LOCAL_CONTEXT, LocalModel::context_size)
    }

    /// How much of the context the conversation fills: what the server
    /// counted at its last round, else a third of its characters, a guess
    /// that the first count replaces.
    fn context_used(&self, messages: &[Value]) -> u64 {
        let counted = self.inner.state.lock().unwrap().context.map(|(tokens, _)| tokens);
        counted.unwrap_or((crate::local_turn::characters(messages) / 3) as u64)
    }

    /// The newest of `messages` that fit in half the context, by how many
    /// characters a token has been in this conversation.
    fn fitting(&self, messages: Vec<Value>) -> Vec<Value> {
        let per_token = match self.inner.state.lock().unwrap().context {
            Some((tokens, characters)) if tokens > 0 => (characters as f64 / tokens as f64).max(1.0),
            _ => 2.0,
        };
        crate::local_turn::newest(messages, (self.context_size() as f64 / 2.0 * per_token) as usize)
    }

    /// The conversation grows as long as the model's context permits. Once a
    /// turn ends past three quarters of it, the ghost writes a handoff note in
    /// the background, asked as the conversation's own next message. The
    /// model answers one request at a time, so a turn that arrives while the
    /// note is being written waits for it (`wait_for_handoff`) and then runs
    /// from the note. A note replaces, for later turns, the entries it was
    /// written from. The log keeps all of it.
    fn start_handoff_if_due(&self) {
        let Some(answerer) = self.inner.answerer.clone() else { return };
        let Ok(Some(entries)) = read_log(&self.dir()) else { return };
        let mut history = conversation_messages(&entries, STOP_HOOK_FEEDBACK_PREFIX);
        let used = self.context_used(&history);
        let (abort, generation, outgrown) = {
            let mut state = self.inner.state.lock().unwrap();
            let outgrown = state.outgrown;
            let due = !history.is_empty() && (outgrown || used >= self.context_size() * 3 / 4);
            if !due || state.shutting_down || state.reserved || state.handoff.is_some() {
                return;
            }
            state.next_handoff += 1;
            let (generation, abort) = (state.next_handoff, Abort::new());
            state.handoff = Some((generation, abort.clone()));
            (abort, generation, outgrown)
        };
        // Already too long for the note's own request to fit: the note is written from the newest of it that does.
        if outgrown || used >= self.context_size() * 9 / 10 {
            history = self.fitting(history);
        }
        let (host, covers) = (self.clone(), entries.len());
        std::thread::spawn(move || {
            host.write_handoff(answerer.as_ref(), history, covers, &abort);
            let mut state = host.inner.state.lock().unwrap();
            if state.handoff.as_ref().is_some_and(|(running, _)| *running == generation) {
                state.handoff = None;
            }
            host.inner.handoff_done.notify_all();
        });
    }

    fn write_handoff(&self, answerer: &dyn Answerer, history: Vec<Value>, covers: usize, abort: &Abort) {
        let counted = self.inner.state.lock().unwrap().context;
        let quiet: Emit = Arc::new(|_| {});
        let written = self.run_pass(answerer, crate::local_turn::HANDOFF_PROMPT.to_string(), history, &quiet, &mut 0, abort);
        // The note's own request is not the conversation: what the last turn counted still stands.
        self.inner.state.lock().unwrap().context = counted;
        let Ok(written) = written else { return };
        let note: Vec<&str> =
            written.content.iter().filter_map(|part| if let AssistantPart::Text { text } = part { Some(text.as_str()) } else { None }).collect();
        let note = note.join("\n\n");
        if abort.is_aborted() {
            return;
        }
        if written.error.is_some() || note.trim().is_empty() {
            self.inner.logger.warn("no handoff note was written", json!({ "reason": written.error }));
            return;
        }
        let logged = LogEntry::Assistant { at: clock::now_iso(), content: vec![AssistantPart::Handoff { text: note, covers }], error: None };
        if self.require_conversation().is_err() || append_log(&self.dir(), &[logged]).is_err() {
            return;
        }
        {
            let mut state = self.inner.state.lock().unwrap();
            state.context = None;
            state.outgrown = false;
        }
        self.announce();
    }

    /// Stop a handoff note still being written for a conversation that is going away.
    fn cancel_handoff(&self) {
        if let Some((_, abort)) = self.inner.state.lock().unwrap().handoff.take() {
            abort.abort();
        }
        self.inner.handoff_done.notify_all();
    }

    /// A turn that arrives while the conversation's handoff note is being
    /// written waits for it, saying why, and then runs from the note. A turn
    /// that is stopped stops waiting.
    fn wait_for_handoff(&self, emit: &Emit, abort: &Abort) {
        let mut state = self.inner.state.lock().unwrap();
        if state.handoff.is_none() {
            return;
        }
        emit(json!({ "type": "thinking", "delta": "Handing off: writing a note of the conversation so far…\n" }));
        while state.handoff.is_some() && !abort.is_aborted() && !state.shutting_down {
            state = self.inner.handoff_done.wait_timeout(state, std::time::Duration::from_millis(100)).unwrap().0;
        }
    }

    /// Run one prompt on the local model, handed the conversation so far as
    /// the messages it was: the model keeps no session of its own. Returns the terminal error, or None on success.
    fn run_turn_on_model(&self, prompt: &str, emit: &Emit, blocks: &mut usize, abort: &Abort) -> Result<Option<Value>> {
        let Some(answerer) = self.inner.answerer.clone() else { return Ok(Some(error_event("error", NO_LOCAL_MODEL))) };
        let dir = self.dir();
        // Every pass's prompt is already the log's last entry: the owner's message, a follow-up, or a hook's feedback.
        let entries = read_log(&dir)?.unwrap_or_default();
        let whole = conversation_messages(&entries, STOP_HOOK_FEEDBACK_PREFIX);
        emit(json!({ "type": "pass" }));
        let mut attempt = 0;
        let result = loop {
            // No note could be written and the context is full, or the server has just
            // said so: the newest of it that fits is sent, rather than the turn failing.
            let trimmed = attempt > 0 || self.context_used(&whole) >= self.context_size();
            if trimmed {
                self.inner.state.lock().unwrap().outgrown = true;
            }
            let mut history = if trimmed { self.fitting(whole.clone()) } else { whole.clone() };
            let pass_prompt = match history.pop() {
                Some(last) if last["role"] == "user" => last["content"].as_str().unwrap_or(prompt).to_string(),
                other => {
                    history.extend(other);
                    prompt.to_string()
                }
            };
            let result = self.run_pass(answerer.as_ref(), pass_prompt, history, emit, blocks, abort)?;
            // Refused for length before anything was said or done: once more, with what fits.
            let refused = result.content.is_empty() && result.error.as_deref().is_some_and(|error| error.starts_with(crate::local_turn::NO_FIT));
            if !refused || attempt > 0 {
                break result;
            }
            attempt += 1;
        };
        append_log(&dir, &[LogEntry::Assistant { at: clock::now_iso(), content: result.content, error: result.error.clone() }])?;
        Ok(result.error.map(|message| error_event(if result.aborted { "aborted" } else { "error" }, &message)))
    }

    /// One completion for a trusted command hook (`ghostd hook-complete`), on the
    /// local model with no persona, conversation, or tools. It takes no
    /// admission or conversation lock: the turn awaiting the `session_stop` hook
    /// that asks holds its own, and waiting for it would deadlock.
    pub fn complete(&self, prompt: &str, abort: &Abort) -> Result<String> {
        if prompt.trim().is_empty() {
            return Err(GhostError::invalid("prompt must be a non-empty string."));
        }
        let Some(answerer) = &self.inner.answerer else { return Err(GhostError::new("no_local_model", NO_LOCAL_MODEL, 409)) };
        let text = answerer.complete(prompt, abort).map_err(internal)?;
        let text = text.trim();
        if text.is_empty() {
            return Err(GhostError::new("completion_failed", "The local model returned no text for the prompt.", 502));
        }
        Ok(text.to_string())
    }

    fn run_pass(
        &self,
        answerer: &dyn Answerer,
        prompt: String,
        history: Vec<Value>,
        emit: &Emit,
        blocks: &mut usize,
        abort: &Abort,
    ) -> Result<PassResult> {
        let dir = self.dir();
        let persona = self.render_persona()?;
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
        }
        let cwd = dir.to_string_lossy().into_owned();

        let mut content: Vec<AssistantPart> = Vec::new();
        let mut tools: HashMap<String, (String, usize)> = HashMap::new();
        // The text block streaming now and its logged part, the last one while it is open,
        // so a block key reused after a tool call logs a new part, as the stream shows.
        struct Open {
            key: String,
            index: usize,
            part: usize,
            text: String,
        }
        let mut open: Option<Open> = None;
        let mut error: Option<String> = None;
        let mut thought_block: Option<String> = None;
        // The reasoning part being written, while nothing has followed it.
        let mut thinking: Option<usize> = None;
        fn close_block(open: &mut Option<Open>, content: &mut [AssistantPart], emit: &Emit) {
            if let Some(block) = open.take() {
                emit(json!({ "type": "text_end", "contentIndex": block.index, "content": block.text }));
                content[block.part] = AssistantPart::text(block.text);
            }
        }
        let mut on_event = |event: PassEvent| match event {
            // Reasoning streams and is logged where it happened: before the text or the call it led to.
            PassEvent::Thinking { block, delta } => {
                if delta.is_empty() {
                    return;
                }
                let new_block = thought_block.as_ref().is_some_and(|previous| *previous != block);
                let delta = if new_block { format!("\n{delta}") } else { delta };
                // "Loading the local model…" is a notice, not reasoning.
                if block != "load" {
                    close_block(&mut open, &mut content, emit);
                    match thinking.and_then(|part| content.get_mut(part)) {
                        Some(AssistantPart::Thinking { text }) => text.push_str(&delta),
                        _ => {
                            thinking = Some(content.len());
                            content.push(AssistantPart::Thinking { text: delta.trim_start_matches('\n').to_string() });
                        }
                    }
                }
                emit(json!({ "type": "thinking", "delta": delta }));
                thought_block = Some(block);
            }
            PassEvent::Text { block, delta } => {
                if delta.is_empty() {
                    return;
                }
                if open.as_ref().is_none_or(|current| current.key != block) {
                    close_block(&mut open, &mut content, emit);
                    thinking = None;
                    let index = *blocks;
                    *blocks += 1;
                    open = Some(Open { key: block, index, part: content.len(), text: String::new() });
                    content.push(AssistantPart::text(""));
                    emit(json!({ "type": "text_start", "contentIndex": index }));
                }
                let current = open.as_mut().expect("just opened");
                current.text.push_str(&delta);
                emit(json!({ "type": "text_delta", "contentIndex": current.index, "delta": delta }));
            }
            PassEvent::ToolStart { id: tool, name, args } => {
                if tools.contains_key(&tool) {
                    return;
                }
                close_block(&mut open, &mut content, emit);
                thinking = None;
                tools.insert(tool.clone(), (name.clone(), content.len()));
                content.push(AssistantPart::ToolCall { id: tool.clone(), name: name.clone(), arguments: args.clone(), failed: false, output: None });
                emit(json!({ "type": "tool_execution_start", "id": tool, "toolName": name, "arguments": args, "cwd": cwd }));
            }
            PassEvent::ToolUpdate { id: tool, output } => {
                if let Some(summary) = tail(&output).filter(|_| tools.contains_key(&tool)) {
                    emit(json!({ "type": "tool_execution_update", "id": tool, "summary": summary }));
                }
            }
            PassEvent::ToolEnd { id: tool, is_error, output } => {
                let Some((name, part)) = tools.get(&tool).cloned() else { return };
                if let AssistantPart::ToolCall { failed, output: logged, .. } = &mut content[part] {
                    *failed = is_error;
                    *logged = output.clone();
                }
                let mut event = json!({ "type": "tool_execution_end", "id": tool, "toolName": name, "isError": is_error });
                if let Some(summary) = output.as_deref().and_then(tail) {
                    event["summary"] = json!(summary);
                }
                // The whole of what the call returned, as the model is given it.
                if let Some(output) = &output {
                    event["output"] = json!(output);
                }
                emit(event);
            }
            PassEvent::Error { message } => error = Some(message),
            PassEvent::Context { tokens, characters } => {
                self.inner.state.lock().unwrap().context = Some((tokens, characters));
            }
        };

        let coding_agent_command = (self.inner.coding_agent)().and_then(|agent| coding_agent_command(&agent)).map(str::to_string);
        let host = self.clone();
        let ask: crate::local_turn::Ask =
            Arc::new(move |question, options| host.set_question(question, options).map(|_| ()).map_err(|error| error.to_string()));
        let env = self.inner.env.clone();
        let input = PassInput { prompt, history, persona, coding_agent_command, cwd: dir.clone(), env, abort: abort.clone(), ask };
        let outcome = answerer.turn(&input, &mut on_event);
        if let Err(failure) = outcome
            && !abort.is_aborted()
        {
            error = Some(failure);
        }
        close_block(&mut open, &mut content, emit);
        if abort.is_aborted() {
            return Ok(PassResult { content, error: Some("Turn aborted.".to_string()), aborted: true });
        }
        Ok(PassResult { content, error, aborted: false })
    }

    /// The fields every hook event carries (docs/hooks.md), after the event's own.
    fn hook_event(&self, name: HookEventName, mut payload: Value, abort: &Abort, last: &[(&str, Value)]) -> HookEvent {
        let ghost = &self.inner.ghost;
        let cwd = self.dir();
        let base = json!({
            "transcript_path": log_path(&cwd).to_string_lossy(),
            "ghost_name": ghost.name(),
            "ghost_home": ghost.dir.to_string_lossy(),
            "cwd": cwd.to_string_lossy(),
        });
        let fields = payload.as_object_mut().expect("an object payload");
        fields.extend(base.as_object().expect("an object").clone());
        for (key, value) in last {
            fields.insert((*key).to_string(), value.clone());
        }
        HookEvent { name, payload, cwd, abort: abort.clone() }
    }

    /// The owner's devices that get an alert when a turn ends (CONTRACTS.md "Push alerts").
    pub fn push(&self) -> Option<&Arc<crate::push::Push>> {
        self.inner.push.as_ref()
    }

    /// Alert the owner's devices that a turn ended (CONTRACTS.md "Push alerts"). A cancelled turn alerts no one.
    fn alert(&self, terminal: &Value, abort: &Abort) {
        let failed = terminal["type"] == "error";
        let Some(push) = self.inner.push.as_ref().filter(|push| push.count() > 0) else { return };
        if abort.is_aborted() || (failed && terminal["reason"] == "aborted") {
            return;
        }
        let Ok(entries) = read_log(&self.dir()).map(Option::unwrap_or_default) else { return };
        let text = if failed {
            terminal["errorMessage"].as_str().unwrap_or("").to_string()
        } else {
            match entries.iter().rev().find(|entry| matches!(entry, LogEntry::Assistant { .. } | LogEntry::Command { .. })) {
                Some(LogEntry::Assistant { content, .. }) => {
                    let texts: Vec<&str> =
                        content.iter().filter_map(|part| if let AssistantPart::Text { text } = part { Some(text.as_str()) } else { None }).collect();
                    texts.join("\n")
                }
                Some(LogEntry::Command { output, .. }) => output.clone(),
                _ => String::new(),
            }
        };
        let url = self.inner.app_url.as_ref().and_then(|link| link());
        let excerpt = text.split_whitespace().collect::<Vec<_>>().join(" ");
        // What the app's service worker shows.
        let body = if failed { format!("Failed: {}", text::prefix(&excerpt, 280)) } else { text::prefix(&excerpt, 280).to_string() };
        push.notify(json!({ "title": self.inner.ghost.name(), "body": body, "url": url }));
    }

    fn session_stop(&self, owner_prompt: &str, turn_id: &str, active: bool, abort: &Abort, emit: &Emit) -> Result<Option<String>> {
        let hooks = &self.inner.hooks;
        if !hooks.has_handlers(HookEventName::SessionStop) || abort.is_aborted() {
            return Ok(None);
        }
        let entries = read_log(&self.dir())?.unwrap_or_default();
        let Some(LogEntry::Assistant { content, .. }) = entries.iter().rev().find(|entry| matches!(entry, LogEntry::Assistant { .. })) else {
            return Ok(None);
        };
        let message = json!({ "role": "assistant", "content": content.iter().map(AssistantPart::to_json).collect::<Vec<_>>() });
        let payload = json!({ "type": "session_stop", "messages": [message], "turn_id": turn_id, "last_assistant_message": message });
        let event = self.hook_event(
            HookEventName::SessionStop,
            payload,
            abort,
            &[("stop_hook_active", json!(active)), ("owner_prompt", json!(owner_prompt))],
        );
        let observe = |name: &str, event: HookEventName, running: bool| {
            emit(json!({ "type": if running { "hook_start" } else { "hook_end" }, "name": name, "event": event.as_str() }));
        };
        Ok(continuation(hooks.emit_session_stop(&event, Some(&observe)).as_ref()))
    }

    /// The owner's `!command` (or `!!command`, kept from the ghost), run in the
    /// owner home and recorded in the log; its output reaches the ghost with
    /// its next prompt.
    fn run_owner_command(&self, command: &OwnerCommand, emit: &Emit, abort: &Abort) -> Result<Value> {
        let tool_id = format!("bash-{}", crate::random::base36(clock::now_ms() as u64));
        let home = &self.inner.owner_home;
        emit(
            json!({ "type": "tool_execution_start", "id": tool_id, "toolName": "bash", "arguments": { "command": command.command }, "cwd": home.to_string_lossy() }),
        );
        // The log keeps the last 100 KB; a chatty command is trimmed in batches,
        // and the card's summary is sent at most every 100 ms, not per line.
        let mut output = String::new();
        let mut due: Option<Instant> = None;
        let exit = run_process(
            ProcessOptions {
                argv: &["bash", "-c", &command.command],
                cwd: home,
                env: &self.inner.env,
                abort,
                stdin: None,
                merge_stderr: false,
                tick: true,
            },
            |chunk| {
                if !chunk.is_empty() {
                    output.push_str(chunk);
                    if output.len() > 200_000 {
                        output = text::suffix(&output, 100_000).to_string();
                    }
                    due.get_or_insert_with(|| Instant::now() + Duration::from_millis(100));
                }
                if due.is_some_and(|at| Instant::now() >= at) {
                    due = None;
                    let mut update = json!({ "type": "tool_execution_update", "id": tool_id });
                    if let Some(summary) = tail(text::suffix(&output, 4 * TOOL_SUMMARY_MAX)) {
                        update["summary"] = json!(summary);
                    }
                    emit(update);
                }
            },
        );
        output = text::suffix(&output, 100_000).to_string();
        output.push_str(&exit.stderr);
        if let Some(error) = &exit.spawn_error {
            output.push_str(error);
        }
        let ended = match (exit.code, exit.signal) {
            (Some(code), _) => code.to_string(),
            (None, Some(signal)) => signal_name(signal),
            (None, None) => "null".to_string(),
        };
        emit(
            json!({ "type": "tool_execution_end", "id": tool_id, "toolName": "bash", "isError": exit.code != Some(0), "summary": tail(&output).unwrap_or_else(|| format!("Exit {ended}")) }),
        );
        append_log(
            &self.dir(),
            &[LogEntry::Command { at: clock::now_iso(), command: command.command.clone(), output, exit_code: exit.code, excluded: command.excluded }],
        )?;
        Ok(if abort.is_aborted() { error_event("aborted", "Command aborted.") } else { json!({ "type": "done" }) })
    }

    /// `{ streaming, followUp }`: whether a turn is running, and what waits behind it.
    pub fn queued_messages(&self) -> Value {
        let state = self.inner.state.lock().unwrap();
        let turn = state.live.as_ref();
        json!({ "streaming": turn.is_some(), "followUp": turn.map(|turn| turn.follow_ups.clone()).unwrap_or_default() })
    }

    /// Abort the running turn or owner command; its stream ends `aborted`.
    pub fn stop_turn(&self) -> Result<()> {
        let abort = self.inner.state.lock().unwrap().admission.clone();
        match abort {
            Some(abort) => {
                abort.abort();
                Ok(())
            }
            None => Err(GhostError::new("conversation_not_streaming", "No turn is running.", 409)),
        }
    }

    /// Queue text for after the current pass, which takes no input mid-run.
    pub fn queue_message(&self, text: &str) -> Result<Value> {
        let (emit, waiting) = {
            let mut state = self.inner.state.lock().unwrap();
            // A running `!command` has no passes to queue after.
            let busy = state.admission.is_some();
            let Some(turn) = state.live.as_mut() else {
                return Err(if busy {
                    GhostError::new("conversation_busy", "An owner command is running; send this when it ends.", 409)
                } else {
                    GhostError::new("conversation_not_streaming", "No turn is running; send a normal message instead.", 409)
                });
            };
            turn.follow_ups.push(text.to_string());
            (turn.emit.clone(), turn.follow_ups.clone())
        };
        emit(json!({ "type": "queue", "followUp": waiting }));
        Ok(self.queued_messages())
    }

    // ── The conversation's state ──────────────────────────────────────

    /// The conversation as a client lists it: `{ preview, updatedAt,
    /// messageCount, unread, running, question }`. Before anything is said it
    /// has no preview and no time.
    pub fn conversation(&self) -> Result<Value> {
        let dir = self.dir();
        // An owner command logs when it ends, so a running one shows before anything is logged.
        let running = self.inner.state.lock().unwrap().admission.is_some();
        let log = self.inner.log.listed()?;
        let updated_at = log.as_ref().filter(|log| log.state.message_count > 0).map(|log| log.updated_at.clone());
        let unread = updated_at.as_ref().is_some_and(|updated_at| read_read_at(&dir).is_none_or(|read_at| *updated_at > read_at));
        Ok(json!({
            "preview": log.as_ref().and_then(|log| log.state.preview.clone()),
            "updatedAt": updated_at,
            "messageCount": log.as_ref().map_or(0, |log| log.state.message_count),
            "unread": unread,
            "running": running,
            "question": read_question(&dir).map(|question| question.to_json()),
        }))
    }

    /// The sidecars and the handoff note are written beside a log, never into a directory that has none.
    fn require_conversation(&self) -> Result<()> {
        if !log_path(&self.dir()).exists() {
            return Err(GhostError::not_found("There is no conversation yet."));
        }
        Ok(())
    }

    /// Record what the ghost asks the owner, replacing an earlier open
    /// question. It stays until the owner's next message.
    pub fn set_question(&self, text: &str, options: &[String]) -> Result<Value> {
        let question = valid_question(text, options)?;
        self.require_conversation()?;
        write_question(&self.dir(), &question)?;
        self.announce();
        Ok(question.to_json())
    }

    /// Mark the conversation read up to `opened_at`; a read time never moves back.
    pub fn mark_read(&self, opened_at_ms: i64) -> Result<String> {
        self.require_conversation()?;
        let dir = self.dir();
        let mut read_at = clock::iso(opened_at_ms);
        {
            let _writing = self.inner.metadata.lock().unwrap();
            if let Some(earlier) = read_read_at(&dir).filter(|earlier| *earlier > read_at) {
                read_at = earlier;
            }
            write_read_at(&dir, &read_at)?;
        }
        self.announce();
        Ok(read_at)
    }

    /// Store an image in the conversation directory, which need not hold a turn yet.
    pub fn save_attachment(&self, bytes: &[u8]) -> Result<String> {
        save_attachment(&self.dir(), bytes)
    }

    pub fn read_attachment(&self, name: &str) -> Result<Attachment> {
        read_attachment(&self.dir(), name)
    }

    /// `{ messages, total, truncated }`: one page of the renderable history.
    pub fn read_transcript(&self, limit: Option<f64>, offset: Option<f64>) -> Result<Value> {
        let limit = clamp(limit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT).max(1);
        let requested = clamp(offset, 0, usize::MAX / 2);
        let page = self.inner.log.page(requested, limit)?;
        let offset = requested.min(page.total);
        Ok(json!({
            "messages": page.messages.iter().map(|message| message.to_json()).collect::<Vec<_>>(),
            "total": page.total,
            "truncated": offset > 0 || offset + page.messages.len() < page.total,
        }))
    }

    /// Start over: move the conversation directory, log, attachments, sidecars
    /// and all, to recoverable Trash. The next message makes a new one.
    pub fn delete_conversation(&self) -> Result<()> {
        self.require_conversation()?;
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.admission.is_some() || state.reserved {
                return Err(GhostError::new("conversation_busy", "Wait for the running turn to finish before starting over.", 409));
            }
            state.reserved = true;
        }
        self.cancel_handoff();
        let trashed = (|| -> Result<()> {
            // The environment `gio trash` resolves the owner's Trash from.
            let mut env = self.inner.env.clone();
            env.insert("HOME".to_string(), self.inner.owner_home.to_string_lossy().into_owned());
            crate::trash::trash_path(&self.dir(), &env)?;
            {
                let mut state = self.inner.state.lock().unwrap();
                state.context = None;
                state.outgrown = false;
            }
            self.inner.logger.info("trashed the conversation", json!({ "ghost": self.inner.ghost.name() }));
            self.announce();
            Ok(())
        })();
        self.inner.state.lock().unwrap().reserved = false;
        trashed
    }

    // ── Shutdown ──────────────────────────────────────────────────────

    /// Refuse new turns, abort the running one, end the event streams, stop the model.
    pub fn dispose_all(&self) {
        let (aborts, closers) = {
            let mut state = self.inner.state.lock().unwrap();
            state.shutting_down = true;
            let closers: Vec<_> = state.listeners.drain(..).map(|listener| listener.close).collect();
            let writing = state.handoff.take().map(|(_, abort)| abort);
            (state.admission.iter().cloned().chain(writing).collect::<Vec<_>>(), closers)
        };
        for abort in aborts {
            abort.abort();
        }
        for close in closers {
            close();
        }
        if let Some(model) = &self.inner.local_model {
            model.stop("daemon stopping");
        }
    }
}

impl TurnAdmission {
    /// Run the turn on this thread: every event but the last through `emit`,
    /// then exactly one terminal `done` or `error`.
    pub fn run(self, emit: Emit) {
        let TurnAdmission { host, prompt, command, abort } = self;
        host.wait_for_handoff(&emit, &abort);
        let outcome = host.run_admitted(&prompt, command.as_ref(), &emit, &abort);
        // A turn that failed outside its passes (its log could not be written) is still a turn that ended.
        let terminal = outcome.unwrap_or_else(|error| error_event(if abort.is_aborted() { "aborted" } else { "error" }, &error.message));
        emit(terminal.clone());
        host.inner.state.lock().unwrap().admission = None;
        host.announce();
        host.start_handoff_if_due();
        // An alert observes a settled turn; a slow push service never holds the conversation busy.
        std::thread::spawn(move || host.alert(&terminal, &abort));
    }
}

#[cfg(test)]
#[path = "conversation_host_tests.rs"]
mod tests;
