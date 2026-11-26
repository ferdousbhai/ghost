//! Conversations, as ghostd hosts them: each turn runs on the local model
//! (`local_turn.rs`) in the conversation's own directory with the ghost's
//! persona, its output streamed to the client and recorded in the conversation
//! log. ghostd owns the persona, the log, the owner's hooks, and the ghost's
//! lifecycle; nothing of a turn leaves the machine unless a command the model
//! runs sends it.
use crate::abort::Abort;
use crate::attachments::{Attachment, read_attachment, save_attachment};
use crate::clock;
use crate::coding_agent::{choose_coding_agent, coding_agent_command};
use crate::conversation_log::{
    AssistantPart, LogEntry, Origin, append_log, conversation_dir, conversation_environment, is_valid_conversation_id, listed_log, log_path,
    log_state, new_conversation_entry, read_log, read_transcript_page, require_conversation_id,
};
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
use crate::sidecars::{OwnerQuestion, read_pins, read_questions, read_reads, write_pins, write_questions, write_reads};
use crate::text;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Same prefix Claude Code and Codex put on Stop-hook continuation prompts.
const STOP_HOOK_FEEDBACK_PREFIX: &str = "Stop hook feedback:\n";
/// The live tail of a tool's output shown on its card.
const TOOL_SUMMARY_MAX: usize = 800;
/// A conversation name is a label in a sidebar, not a description. The cap is
/// generous for a sentence and short enough to stay a label.
const MAX_CONVERSATION_TITLE_LENGTH: usize = 120;
const MAX_QUESTION_LENGTH: usize = 2_000;
const MAX_QUESTION_OPTIONS: usize = 6;
const MAX_QUESTION_OPTION_LENGTH: usize = 120;
const DEFAULT_TRANSCRIPT_LIMIT: usize = 1_000;
const MAX_TRANSCRIPT_LIMIT: usize = 2_000;
const NO_LOCAL_MODEL: &str = "No local model is configured: set `local.model` in ~/.config/ghost/config.json.";

/// Where a turn's events go (the turn wire, CONTRACTS.md).
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;
type ConversationUrl = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;
type CodingAgent = Box<dyn Fn() -> Option<String> + Send + Sync>;

pub struct SessionHostOptions {
    /// The machine's one ghost.
    pub ghost: Ghost,
    pub owner_home: PathBuf,
    pub logger: Logger,
    pub hooks: Arc<HookRunner>,
    /// The app's link to a conversation, for an alert's `url`.
    pub conversation_url: Option<ConversationUrl>,
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
    live: HashMap<String, LiveTurn>,
    /// Each admitted turn's stop: the turn outlives its client, so only `stop_turn` or shutdown ends it early.
    admissions: HashMap<String, Abort>,
    /// A session being trashed cannot admit a turn or another mutation.
    reserved: HashSet<String>,
    listeners: Vec<Listener>,
    next_listener: u64,
    shutting_down: bool,
    /// How much of the model's context each conversation filled at its last
    /// round, in tokens as the server counted them, and in characters.
    context: HashMap<String, (u64, usize)>,
    /// Conversations whose last turn was sent only its newest part, for want of room: they are due a handoff note.
    outgrown: HashSet<String>,
    /// The handoff notes being written in the background, each with its own stop.
    handoffs: HashMap<String, (u64, Abort)>,
    next_handoff: u64,
}

struct Inner {
    ghost: Ghost,
    owner_home: PathBuf,
    logger: Logger,
    hooks: Arc<HookRunner>,
    conversation_url: Option<ConversationUrl>,
    answerer: Option<Arc<dyn Answerer>>,
    coding_agent: CodingAgent,
    local_model: Option<LocalModel>,
    env: Env,
    push: Option<Arc<crate::push::Push>>,
    state: Mutex<State>,
    /// Serializes sidecar rewrites, so two of them cannot interleave a read and a write.
    metadata: Mutex<()>,
    /// Signalled when a handoff note stops being written.
    handoff_done: std::sync::Condvar,
}

#[derive(Clone)]
pub struct SessionHost {
    inner: Arc<Inner>,
}

/// An admitted turn: the conversation is held until `run` returns.
pub struct TurnAdmission {
    host: SessionHost,
    /// The conversation the turn runs in, "default" when the request named none.
    pub session_id: String,
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

impl SessionHost {
    pub fn new(options: SessionHostOptions) -> Self {
        let answerer = options.answerer.or_else(|| options.local_model.clone().map(|model| Arc::new(LocalAnswerer { model }) as Arc<dyn Answerer>));
        let env = options.env;
        let agent_env = env.clone();
        let coding_agent = options.coding_agent.unwrap_or_else(|| Box::new(move || choose_coding_agent(&agent_env)));
        Self {
            inner: Arc::new(Inner {
                ghost: options.ghost,
                owner_home: options.owner_home,
                logger: options.logger,
                hooks: options.hooks,
                conversation_url: options.conversation_url,
                answerer,
                coding_agent,
                local_model: options.local_model,
                env,
                push: options.push,
                state: Mutex::new(State::default()),
                metadata: Mutex::new(()),
                handoff_done: std::sync::Condvar::new(),
            }),
        }
    }

    fn session_dir(&self) -> PathBuf {
        ghost_paths(&self.inner.ghost.dir).session_dir
    }

    // ── Conversation events ────────────────────────────────────────────

    /// Hear every conversation change until `unsubscribe`; `close` is called at shutdown.
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

    fn announce(&self, id: &str) {
        let event = json!({ "type": "conversation-updated", "id": id, "updatedAt": clock::now_iso() });
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
    pub fn admit_turn(&self, session_id: Option<&str>, prompt: &str) -> Result<TurnAdmission> {
        let id = require_conversation_id(session_id.unwrap_or("default"))?.to_string();
        let command = owner_command(prompt);
        let abort = Abort::new();
        let mut state = self.inner.state.lock().unwrap();
        if state.shutting_down {
            return Err(GhostError::new("shutting_down", "ghostd is shutting down.", 503));
        }
        if state.admissions.contains_key(&id) || state.reserved.contains(&id) {
            return Err(GhostError::new("session_busy", "This ghost is already answering in this conversation.", 409));
        }
        if command.as_ref().is_some_and(|command| command.command.is_empty()) {
            return Err(GhostError::invalid("Write a command after ! or !!."));
        }
        state.admissions.insert(id.clone(), abort.clone());
        Ok(TurnAdmission { host: self.clone(), session_id: id, prompt: prompt.to_string(), command, abort })
    }

    /// admit_turn then run, in one call, for tests.
    pub fn run_turn(&self, session_id: Option<&str>, prompt: &str, emit: Emit) -> Result<()> {
        self.admit_turn(session_id, prompt)?.run(emit);
        Ok(())
    }

    fn run_admitted(&self, id: &str, prompt: &str, command: Option<&OwnerCommand>, emit: &Emit, abort: &Abort) -> Result<Value> {
        let session_dir = self.session_dir();
        if !log_path(&session_dir, id).exists() {
            append_log(&session_dir, id, &[new_conversation_entry(id, clock::now_ms())])?;
        }
        emit(json!({ "type": "start" }));
        if let Some(command) = command {
            self.announce(id);
            return self.run_owner_command(id, command, emit, abort);
        }
        self.inner.state.lock().unwrap().live.insert(id.to_string(), LiveTurn { follow_ups: Vec::new(), emit: emit.clone() });
        // The id of the owner request a pass answers, which `session_stop` reports.
        let mut turn_id = crate::random::uuid();
        let outcome = self.run_passes(id, prompt, emit, abort, &mut turn_id);
        self.inner.state.lock().unwrap().live.remove(id);
        let terminal = outcome.unwrap_or_else(|error| {
            self.inner.logger.error("turn failed", json!({ "ghost": self.inner.ghost.name(), "conversation": id, "error": error.message }));
            error_event(if abort.is_aborted() { "aborted" } else { "error" }, &error.message)
        });
        Ok(terminal)
    }

    fn queued(&self, id: &str) -> usize {
        self.inner.state.lock().unwrap().live.get(id).map_or(0, |turn| turn.follow_ups.len())
    }

    /// The passes of one turn: the prompt, then each stop-hook continuation and queued follow-up.
    fn run_passes(&self, id: &str, prompt: &str, emit: &Emit, abort: &Abort, turn_id: &mut String) -> Result<Value> {
        let session_dir = self.session_dir();
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
            append_log(&session_dir, id, &[LogEntry::user(text.clone(), origin)])?;
            // The owner's message answers what the ghost was waiting on.
            if !from_hook {
                self.drop_question(id)?;
            }
            // Other clients learn the turn is running with its prompt already readable.
            self.announce(id);
            let failure = self.run_turn_on_model(id, &text, emit, &mut blocks, abort)?;
            // A failed pass ends the turn only when nothing is queued behind it:
            // the owner's follow-ups were accepted and still run.
            let failed = failure.is_some();
            terminal = failure.unwrap_or_else(|| json!({ "type": "done" }));
            if failed && (abort.is_aborted() || self.queued(id) == 0) {
                break;
            }
            // The owner's own queued message is the next instruction: a stop hook
            // is not asked while one waits, and loses to one sent while it ran.
            // Nor while the ghost's own question waits (its `ask` tool): the turn is
            // waiting on the owner, and a hook's "keep going" is not their answer.
            let continued = if failed || self.queued(id) > 0 || self.has_question(id) {
                None
            } else {
                self.session_stop(id, &owner_prompt, turn_id, from_hook, abort, emit)?
            };
            if let Some(reason) = continued
                && self.queued(id) == 0
            {
                emit(json!({ "type": "session_stop_continued", "reason": reason }));
                next = Some((reason, Some(Origin::Hook)));
                continue;
            }
            let follow_up = {
                let mut state = self.inner.state.lock().unwrap();
                state.live.get_mut(id).filter(|turn| !turn.follow_ups.is_empty()).map(|turn| (turn.follow_ups.remove(0), turn.follow_ups.clone()))
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
    fn context_used(&self, id: &str, messages: &[Value]) -> u64 {
        let counted = self.inner.state.lock().unwrap().context.get(id).map(|(tokens, _)| *tokens);
        counted.unwrap_or((crate::local_turn::characters(messages) / 3) as u64)
    }

    /// The newest of `messages` that fit in half the context, by how many
    /// characters a token has been in this conversation.
    fn fitting(&self, id: &str, messages: Vec<Value>) -> Vec<Value> {
        let per_token = match self.inner.state.lock().unwrap().context.get(id) {
            Some((tokens, characters)) if *tokens > 0 => (*characters as f64 / *tokens as f64).max(1.0),
            _ => 2.0,
        };
        crate::local_turn::newest(messages, (self.context_size() as f64 / 2.0 * per_token) as usize)
    }

    /// A conversation grows as long as the model's context permits. Once a
    /// turn ends past three quarters of it, the ghost writes a handoff note in
    /// the background, asked as the conversation's own next message. The
    /// model answers one request at a time, so a turn that arrives while the
    /// note is being written waits for it (`wait_for_handoff`) and then runs
    /// from the note. A note replaces, for later turns, the entries it was
    /// written from. The log keeps all of it.
    fn start_handoff_if_due(&self, id: &str) {
        let Some(answerer) = self.inner.answerer.clone() else { return };
        let Ok(Some(entries)) = read_log(&self.session_dir(), id) else { return };
        let mut history = conversation_messages(&entries, STOP_HOOK_FEEDBACK_PREFIX);
        let used = self.context_used(id, &history);
        let (abort, generation, outgrown) = {
            let mut state = self.inner.state.lock().unwrap();
            let outgrown = state.outgrown.contains(id);
            let due = !history.is_empty() && (outgrown || used >= self.context_size() * 3 / 4);
            if !due || state.shutting_down || state.reserved.contains(id) || state.handoffs.contains_key(id) {
                return;
            }
            state.next_handoff += 1;
            let (generation, abort) = (state.next_handoff, Abort::new());
            state.handoffs.insert(id.to_string(), (generation, abort.clone()));
            (abort, generation, outgrown)
        };
        // Already too long for the note's own request to fit: the note is written from the newest of it that does.
        if outgrown || used >= self.context_size() * 9 / 10 {
            history = self.fitting(id, history);
        }
        let (host, id, covers) = (self.clone(), id.to_string(), entries.len());
        std::thread::spawn(move || {
            host.write_handoff(&id, answerer.as_ref(), history, covers, &abort);
            let mut state = host.inner.state.lock().unwrap();
            if state.handoffs.get(&id).is_some_and(|(running, _)| *running == generation) {
                state.handoffs.remove(&id);
            }
            host.inner.handoff_done.notify_all();
        });
    }

    fn write_handoff(&self, id: &str, answerer: &dyn Answerer, history: Vec<Value>, covers: usize, abort: &Abort) {
        let counted = self.inner.state.lock().unwrap().context.get(id).copied();
        let quiet: Emit = Arc::new(|_| {});
        let written = self.run_pass(id, answerer, crate::local_turn::HANDOFF_PROMPT.to_string(), history, &quiet, &mut 0, abort);
        // The note's own request is not the conversation: what the last turn counted still stands.
        {
            let mut state = self.inner.state.lock().unwrap();
            match counted {
                Some(counted) => state.context.insert(id.to_string(), counted),
                None => state.context.remove(id),
            };
        }
        let Ok(written) = written else { return };
        let note: Vec<&str> =
            written.content.iter().filter_map(|part| if let AssistantPart::Text { text } = part { Some(text.as_str()) } else { None }).collect();
        let note = note.join("\n\n");
        if abort.is_aborted() {
            return;
        }
        if written.error.is_some() || note.trim().is_empty() {
            self.inner.logger.warn("no handoff note was written", json!({ "conversation": id, "reason": written.error }));
            return;
        }
        let logged = LogEntry::Assistant { at: clock::now_iso(), content: vec![AssistantPart::Handoff { text: note, covers }], error: None };
        if self.require_conversation(id).is_err() || append_log(&self.session_dir(), id, &[logged]).is_err() {
            return;
        }
        {
            let mut state = self.inner.state.lock().unwrap();
            state.context.remove(id);
            state.outgrown.remove(id);
        }
        self.announce(id);
    }

    /// Stop a handoff note still being written for a conversation that is going away.
    fn cancel_handoff(&self, id: &str) {
        if let Some((_, abort)) = self.inner.state.lock().unwrap().handoffs.remove(id) {
            abort.abort();
        }
        self.inner.handoff_done.notify_all();
    }

    /// A turn that arrives while the conversation's handoff note is being
    /// written waits for it, saying why, and then runs from the note. A turn
    /// that is stopped stops waiting.
    fn wait_for_handoff(&self, id: &str, emit: &Emit, abort: &Abort) {
        let mut state = self.inner.state.lock().unwrap();
        if !state.handoffs.contains_key(id) {
            return;
        }
        emit(json!({ "type": "thinking", "delta": "Handing off: writing a note of the conversation so far…\n" }));
        while state.handoffs.contains_key(id) && !abort.is_aborted() && !state.shutting_down {
            state = self.inner.handoff_done.wait_timeout(state, std::time::Duration::from_millis(100)).unwrap().0;
        }
    }

    /// Run one prompt on the local model, handed the conversation so far as
    /// the messages it was: the model keeps no session of its own. Returns the terminal error, or None on success.
    fn run_turn_on_model(&self, id: &str, prompt: &str, emit: &Emit, blocks: &mut usize, abort: &Abort) -> Result<Option<Value>> {
        let Some(answerer) = self.inner.answerer.clone() else { return Ok(Some(error_event("error", NO_LOCAL_MODEL))) };
        let session_dir = self.session_dir();
        // Every pass's prompt is already the log's last entry: the owner's message, a follow-up, or a hook's feedback.
        let entries = read_log(&session_dir, id)?.unwrap_or_default();
        let whole = conversation_messages(&entries, STOP_HOOK_FEEDBACK_PREFIX);
        emit(json!({ "type": "pass" }));
        let mut attempt = 0;
        let result = loop {
            // No note could be written and the context is full, or the server has just
            // said so: the newest of it that fits is sent, rather than the turn failing.
            let trimmed = attempt > 0 || self.context_used(id, &whole) >= self.context_size();
            if trimmed {
                self.inner.state.lock().unwrap().outgrown.insert(id.to_string());
            }
            let mut history = if trimmed { self.fitting(id, whole.clone()) } else { whole.clone() };
            let pass_prompt = match history.pop() {
                Some(last) if last["role"] == "user" => last["content"].as_str().unwrap_or(prompt).to_string(),
                other => {
                    history.extend(other);
                    prompt.to_string()
                }
            };
            let result = self.run_pass(id, answerer.as_ref(), pass_prompt, history, emit, blocks, abort)?;
            // Refused for length before anything was said or done: once more, with what fits.
            let refused = result.content.is_empty() && result.error.as_deref().is_some_and(|error| error.starts_with(crate::local_turn::NO_FIT));
            if !refused || attempt > 0 {
                break result;
            }
            attempt += 1;
        };
        append_log(&session_dir, id, &[LogEntry::Assistant { at: clock::now_iso(), content: result.content, error: result.error.clone() }])?;
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

    #[allow(clippy::too_many_arguments)]
    fn run_pass(
        &self,
        id: &str,
        answerer: &dyn Answerer,
        prompt: String,
        history: Vec<Value>,
        emit: &Emit,
        blocks: &mut usize,
        abort: &Abort,
    ) -> Result<PassResult> {
        let dir = conversation_dir(&self.session_dir(), id);
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
                self.inner.state.lock().unwrap().context.insert(id.to_string(), (tokens, characters));
            }
        };

        let mut env = self.inner.env.clone();
        env.extend(conversation_environment(id));
        let coding_agent_command = (self.inner.coding_agent)().and_then(|agent| coding_agent_command(&agent)).map(str::to_string);
        let (host, conversation) = (self.clone(), id.to_string());
        let ask: crate::local_turn::Ask =
            Arc::new(move |question, options| host.set_question(&conversation, question, options).map(|_| ()).map_err(|error| error.to_string()));
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
    fn hook_event(&self, name: HookEventName, mut payload: Value, id: &str, abort: &Abort, last: &[(&str, Value)]) -> HookEvent {
        let session_dir = self.session_dir();
        let ghost = &self.inner.ghost;
        let cwd = conversation_dir(&session_dir, id);
        let base = json!({
            "session_id": id,
            "transcript_path": log_path(&session_dir, id).to_string_lossy(),
            "ghost_name": ghost.name(),
            "ghost_home": ghost.dir.to_string_lossy(),
            "cwd": cwd.to_string_lossy(),
            "conversation_id": id,
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
    fn alert(&self, id: &str, terminal: &Value, abort: &Abort) {
        let failed = terminal["type"] == "error";
        let Some(push) = self.inner.push.as_ref().filter(|push| push.count() > 0) else { return };
        if abort.is_aborted() || (failed && terminal["reason"] == "aborted") {
            return;
        }
        let Ok(entries) = read_log(&self.session_dir(), id).map(Option::unwrap_or_default) else { return };
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
        let url = self.inner.conversation_url.as_ref().and_then(|link| link(id));
        let title = log_state(&entries).title.unwrap_or_else(|| self.inner.ghost.name());
        let excerpt = text.split_whitespace().collect::<Vec<_>>().join(" ");
        // What the app's service worker shows; `tag` lets a later alert for the conversation replace an earlier one.
        let body = if failed { format!("Failed: {}", text::prefix(&excerpt, 280)) } else { text::prefix(&excerpt, 280).to_string() };
        push.notify(json!({ "title": text::prefix(&title, 160), "body": body, "url": url, "tag": id, "ghost": self.inner.ghost.name() }));
    }

    fn session_stop(&self, id: &str, owner_prompt: &str, turn_id: &str, active: bool, abort: &Abort, emit: &Emit) -> Result<Option<String>> {
        let hooks = &self.inner.hooks;
        if !hooks.has_handlers(HookEventName::SessionStop) || abort.is_aborted() {
            return Ok(None);
        }
        let entries = read_log(&self.session_dir(), id)?.unwrap_or_default();
        let Some(LogEntry::Assistant { content, .. }) = entries.iter().rev().find(|entry| matches!(entry, LogEntry::Assistant { .. })) else {
            return Ok(None);
        };
        let message = json!({ "role": "assistant", "content": content.iter().map(AssistantPart::to_json).collect::<Vec<_>>() });
        let payload = json!({ "type": "session_stop", "messages": [message], "turn_id": turn_id, "last_assistant_message": message });
        let event = self.hook_event(
            HookEventName::SessionStop,
            payload,
            id,
            abort,
            &[("stop_hook_active", json!(active)), ("owner_prompt", json!(owner_prompt))],
        );
        let observe = |name: &str, event: HookEventName, running: bool| {
            emit(json!({ "type": if running { "hook_start" } else { "hook_end" }, "name": name, "event": event.as_str() }));
        };
        Ok(continuation(hooks.emit_session_stop(&event, Some(&observe)).as_ref()))
    }

    /// The owner's `!command` (or `!!command`, kept from the ghost), run in the
    /// owner home with the conversation's identity and recorded in the log; its
    /// output reaches the ghost with its next prompt.
    fn run_owner_command(&self, id: &str, command: &OwnerCommand, emit: &Emit, abort: &Abort) -> Result<Value> {
        let tool_id = format!("bash-{}", crate::random::base36(clock::now_ms() as u64));
        let home = &self.inner.owner_home;
        emit(
            json!({ "type": "tool_execution_start", "id": tool_id, "toolName": "bash", "arguments": { "command": command.command }, "cwd": home.to_string_lossy() }),
        );
        // The log keeps the last 100 KB; a chatty command is trimmed in batches,
        // and the card's summary is sent at most every 100 ms, not per line.
        let mut output = String::new();
        let mut due: Option<Instant> = None;
        let mut env = self.inner.env.clone();
        env.extend(conversation_environment(id));
        let exit = run_process(
            ProcessOptions { argv: &["bash", "-c", &command.command], cwd: home, env: &env, abort, stdin: None, merge_stderr: false, tick: true },
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
            &self.session_dir(),
            id,
            &[LogEntry::Command { at: clock::now_iso(), command: command.command.clone(), output, exit_code: exit.code, excluded: command.excluded }],
        )?;
        Ok(if abort.is_aborted() { error_event("aborted", "Command aborted.") } else { json!({ "type": "done" }) })
    }

    /// `{ streaming, followUp }` for a conversation.
    pub fn queued_messages(&self, session_id: &str) -> Result<Value> {
        let id = require_conversation_id(session_id)?;
        let state = self.inner.state.lock().unwrap();
        let turn = state.live.get(id);
        Ok(json!({ "streaming": turn.is_some(), "followUp": turn.map(|turn| turn.follow_ups.clone()).unwrap_or_default() }))
    }

    /// Abort the conversation's running turn or owner command; its stream ends `aborted`.
    pub fn stop_turn(&self, session_id: &str) -> Result<()> {
        let id = require_conversation_id(session_id)?;
        let abort = self.inner.state.lock().unwrap().admissions.get(id).cloned();
        match abort {
            Some(abort) => {
                abort.abort();
                Ok(())
            }
            None => Err(GhostError::new("session_not_streaming", "This conversation is not currently streaming.", 409)),
        }
    }

    /// Queue text for after the current pass, which takes no input mid-run.
    pub fn queue_message(&self, session_id: &str, text: &str) -> Result<Value> {
        let id = require_conversation_id(session_id)?;
        let (emit, waiting) = {
            let mut state = self.inner.state.lock().unwrap();
            // A running `!command` has no passes to queue after.
            let busy = state.admissions.contains_key(id);
            let Some(turn) = state.live.get_mut(id) else {
                return Err(if busy {
                    GhostError::new("session_busy", "An owner command is running in this conversation; send this when it ends.", 409)
                } else {
                    GhostError::new("session_not_streaming", "This conversation is not currently streaming; send a normal message instead.", 409)
                });
            };
            turn.follow_ups.push(text.to_string());
            (turn.emit.clone(), turn.follow_ups.clone())
        };
        emit(json!({ "type": "queue", "followUp": waiting }));
        self.queued_messages(session_id)
    }

    // ── Listing and metadata ──────────────────────────────────────────

    fn conversation_ids(&self, session_dir: &Path) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(session_dir) else { return Vec::new() };
        entries
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| is_valid_conversation_id(name) && log_path(session_dir, name).exists())
            .collect()
    }

    /// Conversation rows, pinned first, then newest.
    pub fn list_sessions(&self) -> Result<Value> {
        let session_dir = self.session_dir();
        let (pins, reads, questions) = (read_pins(&session_dir), read_reads(&session_dir), read_questions(&session_dir));
        let mut rows: Vec<(bool, String, Value)> = Vec::new();
        for id in self.conversation_ids(&session_dir) {
            let Some(log) = listed_log(&session_dir, &id)? else { continue };
            // An owner command logs when it ends, so a running one is listed before anything is.
            let running = self.inner.state.lock().unwrap().admissions.contains_key(&id);
            if log.state.message_count == 0 && log.state.title.is_none() && !running {
                continue;
            }
            let pinned = pins.contains(&id);
            let unread = reads.get(&id).is_none_or(|read_at| log.updated_at > *read_at);
            let row = json!({
                "id": id,
                "title": log.state.title,
                "preview": log.state.preview,
                "updatedAt": log.updated_at,
                "messageCount": log.state.message_count,
                "pinned": pinned,
                "unread": unread,
                "running": running,
                "question": questions.get(&id).map(OwnerQuestion::to_json),
            });
            rows.push((pinned, log.updated_at, row));
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        Ok(Value::Array(rows.into_iter().map(|(_, _, row)| row).collect()))
    }

    fn require_conversation(&self, session_id: &str) -> Result<String> {
        let id = require_conversation_id(session_id)?;
        if !log_path(&self.session_dir(), id).exists() {
            return Err(GhostError::not_found(format!("This ghost has no conversation {}.", Value::String(id.to_string()))));
        }
        Ok(id.to_string())
    }

    pub fn set_pinned(&self, session_id: &str, pinned: bool) -> Result<()> {
        let id = self.require_conversation(session_id)?;
        let session_dir = self.session_dir();
        {
            let _writing = self.inner.metadata.lock().unwrap();
            let existing: HashSet<String> = self.conversation_ids(&session_dir).into_iter().collect();
            let mut kept: Vec<String> = read_pins(&session_dir).into_iter().filter(|pin| *pin != id && existing.contains(pin)).collect();
            if pinned {
                kept.push(id.clone());
            }
            write_pins(&session_dir, &kept)?;
        }
        self.announce(&id);
        Ok(())
    }

    /// Record what the ghost asks the owner in a conversation, replacing an
    /// earlier open question there. It stays until the owner's next message to
    /// that conversation or until dismissed.
    pub fn set_question(&self, session_id: &str, text: &str, options: &[String]) -> Result<Value> {
        let question = valid_question(text, options)?;
        let id = self.require_conversation(session_id)?;
        self.update_questions(|questions| {
            questions.insert(id.clone(), question.clone());
            true
        })?;
        self.announce(&id);
        Ok(question.to_json())
    }

    /// The ghost has asked the owner something in this conversation that is still open.
    fn has_question(&self, id: &str) -> bool {
        read_questions(&self.session_dir()).contains_key(id)
    }

    /// Owner text reached the conversation: whatever was asked there is answered.
    fn drop_question(&self, id: &str) -> Result<bool> {
        let mut dropped = false;
        self.update_questions(|questions| {
            dropped = questions.remove(id).is_some();
            dropped
        })?;
        Ok(dropped)
    }

    /// Apply `change` to the open questions of conversations that still exist.
    /// The file is rewritten only when that changes something (`change`
    /// returns true, or there was something stale to prune), so most turns
    /// touch no file.
    fn update_questions(&self, change: impl FnOnce(&mut BTreeMap<String, OwnerQuestion>) -> bool) -> Result<()> {
        let session_dir = self.session_dir();
        let _writing = self.inner.metadata.lock().unwrap();
        let existing: HashSet<String> = self.conversation_ids(&session_dir).into_iter().collect();
        let stored = read_questions(&session_dir);
        let count = stored.len();
        let mut kept: BTreeMap<String, OwnerQuestion> = stored.into_iter().filter(|(id, _)| existing.contains(id)).collect();
        let pruned = kept.len() < count;
        if change(&mut kept) || pruned {
            write_questions(&session_dir, &kept)?;
        }
        Ok(())
    }

    /// Mark a conversation read up to `opened_at`; a read time never moves back.
    pub fn mark_read(&self, session_id: &str, opened_at_ms: i64) -> Result<String> {
        let id = self.require_conversation(session_id)?;
        let session_dir = self.session_dir();
        let mut read_at = clock::iso(opened_at_ms);
        {
            let _writing = self.inner.metadata.lock().unwrap();
            let existing: HashSet<String> = self.conversation_ids(&session_dir).into_iter().collect();
            let mut kept: BTreeMap<String, String> = read_reads(&session_dir).into_iter().filter(|(read, _)| existing.contains(read)).collect();
            if let Some(earlier) = kept.get(&id).filter(|earlier| **earlier > read_at) {
                read_at = earlier.clone();
            }
            kept.insert(id.clone(), read_at.clone());
            write_reads(&session_dir, &kept)?;
        }
        self.announce(&id);
        Ok(read_at)
    }

    pub fn rename_conversation(&self, session_id: &str, title: &str) -> Result<String> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(GhostError::invalid("\"title\" must not be empty."));
        }
        if text::len(trimmed) > MAX_CONVERSATION_TITLE_LENGTH {
            return Err(GhostError::invalid(format!("\"title\" must be at most {MAX_CONVERSATION_TITLE_LENGTH} characters.")));
        }
        if !regex::Regex::new(r"\P{C}").expect("a literal pattern").is_match(trimmed) {
            return Err(GhostError::invalid("A conversation title needs at least one printable character."));
        }
        let id = self.require_conversation(session_id)?;
        append_log(&self.session_dir(), &id, &[LogEntry::Title { at: clock::now_iso(), title: Some(trimmed.to_string()) }])?;
        self.announce(&id);
        Ok(trimmed.to_string())
    }

    /// Store an image in the conversation directory, which need not hold a turn yet.
    pub fn save_attachment(&self, session_id: &str, bytes: &[u8]) -> Result<String> {
        save_attachment(&conversation_dir(&self.session_dir(), require_conversation_id(session_id)?), bytes)
    }

    pub fn read_attachment(&self, session_id: &str, name: &str) -> Result<Attachment> {
        read_attachment(&conversation_dir(&self.session_dir(), require_conversation_id(session_id)?), name)
    }

    /// `{ id, messages, total, truncated }`: one page of the renderable history.
    pub fn read_transcript(&self, session_id: &str, limit: Option<f64>, offset: Option<f64>) -> Result<Value> {
        let id = require_conversation_id(session_id)?;
        let limit = clamp(limit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT).max(1);
        let requested = clamp(offset, 0, usize::MAX / 2);
        let page = read_transcript_page(&self.session_dir(), id, requested, limit)?;
        let offset = requested.min(page.total);
        Ok(json!({
            "id": id,
            "messages": page.messages.iter().map(|message| message.to_json()).collect::<Vec<_>>(),
            "total": page.total,
            "truncated": offset > 0 || offset + page.messages.len() < page.total,
        }))
    }

    /// Move the conversation's directory, log and all, to recoverable Trash.
    pub fn delete_session(&self, session_id: &str) -> Result<()> {
        let id = self.require_conversation(session_id)?;
        self.cancel_handoff(&id);
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.admissions.contains_key(&id) || state.reserved.contains(&id) {
                return Err(GhostError::new("session_busy", "Wait for this conversation to finish before deleting it.", 409));
            }
            state.reserved.insert(id.clone());
        }
        let trashed = (|| -> Result<()> {
            let session_dir = self.session_dir();
            // The environment `gio trash` resolves the owner's Trash from.
            let mut env = self.inner.env.clone();
            env.insert("HOME".to_string(), self.inner.owner_home.to_string_lossy().into_owned());
            crate::trash::trash_path(&conversation_dir(&session_dir, &id), &env)?;
            {
                let _writing = self.inner.metadata.lock().unwrap();
                let pins = read_pins(&session_dir);
                if pins.contains(&id) {
                    write_pins(&session_dir, &pins.into_iter().filter(|pin| *pin != id).collect::<Vec<_>>())?;
                }
            }
            self.drop_question(&id)?;
            self.inner.logger.info("trashed conversation", json!({ "ghost": self.inner.ghost.name(), "conversation": id }));
            self.announce(&id);
            Ok(())
        })();
        self.inner.state.lock().unwrap().reserved.remove(&id);
        trashed
    }

    // ── Shutdown ──────────────────────────────────────────────────────

    /// Refuse new turns, abort the running ones, end the event streams, stop the model.
    pub fn dispose_all(&self) {
        let (aborts, closers) = {
            let mut state = self.inner.state.lock().unwrap();
            state.shutting_down = true;
            let closers: Vec<_> = state.listeners.drain(..).map(|listener| listener.close).collect();
            let writing: Vec<Abort> = state.handoffs.drain().map(|(_, (_, abort))| abort).collect();
            (state.admissions.values().cloned().chain(writing).collect::<Vec<_>>(), closers)
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
        let TurnAdmission { host, session_id: id, prompt, command, abort } = self;
        host.wait_for_handoff(&id, &emit, &abort);
        let outcome = host.run_admitted(&id, &prompt, command.as_ref(), &emit, &abort);
        // A turn that failed outside its passes (its log could not be written) is still a turn that ended.
        let terminal = outcome.unwrap_or_else(|error| error_event(if abort.is_aborted() { "aborted" } else { "error" }, &error.message));
        emit(terminal.clone());
        host.inner.state.lock().unwrap().admissions.remove(&id);
        host.announce(&id);
        host.start_handoff_if_due(&id);
        // An alert observes a settled turn; a slow push service never holds the conversation busy.
        std::thread::spawn(move || host.alert(&id, &terminal, &abort));
    }
}

#[cfg(test)]
#[path = "session_host_tests.rs"]
mod tests;
