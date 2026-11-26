//! A conversation's own record, `sessions/<id>/.conversation.jsonl` in the
//! ghost home: what the owner said, what the ghost answered, the tools it ran,
//! the owner's `!` commands. The window, `ghost show` and the phone read it,
//! and each turn is handed its newest part: the model keeps no session of its
//! own.
//!
//! The file is one JSON object per line, appended only. Lengths and limits
//! are in UTF-16 code units, as the logs written before this version counted
//! them; a cut never lands inside a character.
use crate::error::{GhostError, Result};
use crate::js_text::{is_space, trim, trim_end, utf16_len, utf16_prefix, utf16_suffix};
use crate::sidecars::SIDECAR_FILENAMES;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::fs::File;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

const LOG_VERSION: i64 = 1;
/// A stored text is cut here; the transcript marks a cut owner or hook message `contentTruncated`.
pub const MAX_LOG_TEXT: usize = 200_000;
const PREVIEW_MAX: usize = 120;
/// How much of the earlier conversation a turn is handed.
pub const HANDOFF_CONTEXT_CHARS: usize = 24_000;

pub const LOG_FILENAME: &str = ".conversation.jsonl";

/// One part of what the ghost answered.
#[derive(Debug, Clone, PartialEq)]
pub enum AssistantPart {
    Text {
        text: String,
    },
    /// The model's reasoning before what follows it, as far as it showed it.
    Thinking {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
        failed: bool,
        /// What the call returned, as the model was given it; None for a call
        /// that never ended, or one an earlier version logged.
        output: Option<String>,
    },
    /// A part in a shape this version does not write, kept as it was read so a client is served it unchanged.
    Other(Value),
}

impl AssistantPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    /// As the log and the API carry it: `type`, then `text`, or `id`, `name`, `arguments`, `failed` only when true, and `output` once the call has ended.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text { text } => json!({ "type": "text", "text": text }),
            Self::Thinking { text } => json!({ "type": "thinking", "text": text }),
            Self::ToolCall { id, name, arguments, failed, output } => {
                let mut part = json!({ "type": "toolCall", "id": id, "name": name, "arguments": arguments });
                if *failed {
                    part["failed"] = Value::Bool(true);
                }
                if let Some(output) = output {
                    part["output"] = json!(output);
                }
                part
            }
            Self::Other(value) => value.clone(),
        }
    }

    pub fn from_json(value: &Value) -> Self {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        let typed = match value.get("type").and_then(Value::as_str) {
            Some("text") => text("text").map(|text| Self::Text { text }),
            Some("thinking") => text("text").map(|text| Self::Thinking { text }),
            Some("toolCall") => match (text("id"), text("name"), value.get("arguments")) {
                (Some(id), Some(name), Some(arguments)) => Some(Self::ToolCall {
                    id,
                    name,
                    arguments: arguments.clone(),
                    failed: value.get("failed") == Some(&Value::Bool(true)),
                    output: text("output"),
                }),
                _ => None,
            },
            _ => None,
        };
        // Only a part that would be written back exactly as it was read is typed.
        typed.filter(|part| part.to_json() == *value).unwrap_or_else(|| Self::Other(value.clone()))
    }
}

/// Who a `user` entry is from when it is not the owner typing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    FollowUp,
    Hook,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FollowUp => "follow_up",
            Self::Hook => "hook",
        }
    }
}

/// One line of the log. `at` and `created_at` are ISO times as `crate::clock` writes them.
#[derive(Debug, Clone, PartialEq)]
pub enum LogEntry {
    Conversation {
        v: i64,
        id: String,
        created_at: String,
    },
    /// `origin` is None for an owner message.
    User {
        at: String,
        text: String,
        origin: Option<Origin>,
    },
    Assistant {
        at: String,
        content: Vec<AssistantPart>,
        error: Option<String>,
    },
    /// The owner's `!command`; `exit_code` is None when a signal ended it.
    Command {
        at: String,
        command: String,
        output: String,
        exit_code: Option<i32>,
        excluded: bool,
    },
    Title {
        at: String,
        title: Option<String>,
    },
}

impl LogEntry {
    /// A message added now: the owner's, or with an `origin`, a follow-up's or a hook's.
    pub fn user(text: impl Into<String>, origin: Option<Origin>) -> Self {
        Self::User { at: crate::clock::now_iso(), text: text.into(), origin }
    }

    /// When the entry was added; None for the `conversation` line, which has `created_at`.
    pub fn at(&self) -> Option<&str> {
        match self {
            Self::Conversation { .. } => None,
            Self::User { at, .. } | Self::Assistant { at, .. } | Self::Command { at, .. } | Self::Title { at, .. } => Some(at),
        }
    }

    /// The line's JSON, keys in the order every version has written them.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Conversation { v, id, created_at } => json!({ "type": "conversation", "v": v, "id": id, "createdAt": created_at }),
            Self::User { at, text, origin } => {
                let mut entry = json!({ "type": "user", "at": at, "text": text });
                if let Some(origin) = origin {
                    entry["origin"] = json!(origin.as_str());
                }
                entry
            }
            Self::Assistant { at, content, error } => {
                let mut entry = json!({ "type": "assistant", "at": at, "content": content.iter().map(AssistantPart::to_json).collect::<Vec<_>>() });
                if let Some(error) = error {
                    entry["error"] = json!(error);
                }
                entry
            }
            Self::Command { at, command, output, exit_code, excluded } => {
                json!({ "type": "command", "at": at, "command": command, "output": output, "exitCode": exit_code, "excluded": excluded })
            }
            Self::Title { at, title } => json!({ "type": "title", "at": at, "title": title }),
        }
    }

    /// The entry a parsed line holds, or None for a line this version does not
    /// read: a retired record of an earlier version (`harness`, `compacted`,
    /// `resources`, a `handoff`, or a user message with `origin: "auto"` or
    /// `"peer"`) or one from a later one. A known entry is never refused for a missing field (it reads as
    /// empty): every entry read keeps its place in the count that names them.
    pub fn from_json(value: &Value) -> Option<Self> {
        let entry: &Map<String, Value> = value.as_object()?;
        let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let at = || text("at");
        Some(match entry.get("type")?.as_str()? {
            "conversation" => {
                Self::Conversation { v: entry.get("v").and_then(Value::as_i64).unwrap_or(LOG_VERSION), id: text("id"), created_at: text("createdAt") }
            }
            "user" => {
                let origin = match entry.get("origin") {
                    None => None,
                    Some(Value::String(origin)) if origin == "follow_up" => Some(Origin::FollowUp),
                    Some(Value::String(origin)) if origin == "hook" => Some(Origin::Hook),
                    Some(_) => return None,
                };
                Self::User { at: at(), text: text("text"), origin }
            }
            "assistant" => Self::Assistant {
                at: at(),
                content: entry
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| parts.iter().map(AssistantPart::from_json).collect())
                    .unwrap_or_default(),
                error: entry.get("error").and_then(Value::as_str).filter(|error| !error.is_empty()).map(str::to_string),
            },
            "command" => Self::Command {
                at: at(),
                command: text("command"),
                output: text("output"),
                exit_code: entry.get("exitCode").and_then(Value::as_i64).and_then(|code| i32::try_from(code).ok()),
                excluded: entry.get("excluded").and_then(Value::as_bool).unwrap_or(false),
            },
            "title" => Self::Title { at: at(), title: entry.get("title").and_then(Value::as_str).map(str::to_string) },
            _ => return None,
        })
    }
}

/// Conversation ids are directory names in `sessions/`: letters, digits, `.`,
/// `_`, `-`; at most 128; not starting with `.`; not a sidecar's name.
pub fn is_valid_conversation_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0] != b'.'
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
        && !SIDECAR_FILENAMES.contains(&id)
}

pub fn require_conversation_id(id: &str) -> Result<&str> {
    if is_valid_conversation_id(id) {
        return Ok(id);
    }
    Err(GhostError::new(
        "invalid_conversation_id",
        format!("Conversation ids are 1-128 letters, digits, '.', '_' or '-', and not {}.", SIDECAR_FILENAMES.join(", ")),
        400,
    ))
}

/// The conversation's directory: its commands run there, and its log lives
/// there, so one rename moves or trashes the whole conversation.
pub fn conversation_dir(session_dir: &Path, id: &str) -> PathBuf {
    session_dir.join(id)
}

pub fn log_path(session_dir: &Path, id: &str) -> PathBuf {
    conversation_dir(session_dir, id).join(LOG_FILENAME)
}

/// `text` within the stored limit. A cut that would split a character ends in
/// U+FFFD instead, so a cut text is always exactly the limit long.
fn bounded(text: &str) -> String {
    if text.len() <= MAX_LOG_TEXT || utf16_len(text) <= MAX_LOG_TEXT {
        return text.to_string();
    }
    let kept = utf16_prefix(text, MAX_LOG_TEXT);
    if utf16_len(kept) < MAX_LOG_TEXT { format!("{kept}\u{fffd}") } else { kept.to_string() }
}

fn bounded_entry(entry: &LogEntry) -> LogEntry {
    let mut entry = entry.clone();
    match &mut entry {
        LogEntry::User { text, .. } => *text = bounded(text),
        LogEntry::Command { output, .. } => *output = bounded(output),
        LogEntry::Assistant { content, .. } => {
            for part in content {
                if let AssistantPart::Text { text } = part {
                    *text = bounded(text);
                }
            }
        }
        LogEntry::Conversation { .. } | LogEntry::Title { .. } => {}
    }
    entry
}

/// Add entries to the conversation's log in one write, making its directory (0700) and the file (0600) when new.
pub fn append_log(session_dir: &Path, id: &str, entries: &[LogEntry]) -> io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(conversation_dir(session_dir, id))?;
    let lines: String = entries.iter().map(|entry| format!("{}\n", bounded_entry(entry).to_json())).collect();
    std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(log_path(session_dir, id))?.write_all(lines.as_bytes())
}

/// Every well-formed entry, or None when the conversation has no log; a torn last line from a crash is skipped.
pub fn read_log(session_dir: &Path, id: &str) -> io::Result<Option<Vec<LogEntry>>> {
    let bytes = match std::fs::read(log_path(session_dir, id)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    // A partial line is what a crash mid-append leaves; the rest stands.
    Ok(Some(bytes.split(|byte| *byte == b'\n').filter_map(parse_entry).collect()))
}

/// The first line of a new conversation's log.
pub fn new_conversation_entry(id: &str, now_ms: i64) -> LogEntry {
    LogEntry::Conversation { v: LOG_VERSION, id: id.to_string(), created_at: crate::clock::iso(now_ms) }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LogState {
    /// The owner's title, else one derived from the first owner message.
    pub title: Option<String>,
    pub preview: Option<String>,
    pub message_count: usize,
    /// When the owner or the ghost last added to the conversation.
    pub active_at: Option<String>,
}

fn pattern(cell: &'static OnceLock<Regex>, source: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(source).expect("a valid pattern"))
}

/// The owner's words without attachment markers: an imported `[Attachment: …]` or an attached image's line.
fn owner_words(text: &str) -> String {
    static MARKERS: OnceLock<Regex> = OnceLock::new();
    let markers = pattern(&MARKERS, r"(?mR)\[Attachment:[^\]]*\]|^!\[[^\]]*\]\(attachments/[^)\s\x{feff}]+\)$");
    trim(&markers.replace_all(text, " ")).to_string()
}

fn first_line(text: &str) -> Option<String> {
    let line = text.split('\n').map(trim).find(|part| !part.is_empty())?;
    Some(if utf16_len(line) > PREVIEW_MAX { trim_end(utf16_prefix(line, PREVIEW_MAX)).to_string() } else { line.to_string() })
}

/// Words a title does not end on.
const TITLE_TAIL: &[&str] = &[
    "a", "an", "the", "to", "of", "and", "or", "for", "with", "in", "on", "at", "from", "by", "about", "as", "but", "if", "that", "this", "my",
    "your", "our", "so", "then", "is", "are", "be", "i", "me",
];
const TITLE_WORDS: usize = 7;

/// Where the first clause of `plain` ends: before white space that follows
/// `.`, `?` or `!`, or before a line break, `;`, `: `, a spaced dash, or a
/// comma that starts a new request.
fn first_clause(plain: &str) -> &str {
    static BREAK: OnceLock<Regex> = OnceLock::new();
    let breaks =
        pattern(&BREAK, r"(?i)\n|;|:[\s\x{feff}]|[\s\x{feff}][-–—][\s\x{feff}]|,[\s\x{feff}](?:and |but |so |then )?(?:i |can |could |please )");
    let mut end = breaks.find(plain).map_or(plain.len(), |found| found.start());
    let mut previous = '\0';
    for (at, character) in plain[..end].char_indices() {
        if is_space(character) && matches!(previous, '.' | '?' | '!') {
            end = at;
            break;
        }
        previous = character;
    }
    &plain[..end]
}

/// A title extracted from the first owner message, with no model: a quoted
/// name the message gives (`called "Coffee Ideas"`), else its first clause
/// without greeting or request frame, cut to a few words that do not end on
/// a filler word. None when nothing substantive is left (a bare "hey").
pub fn derived_title(text: &str) -> Option<String> {
    static NAMED: OnceLock<Regex> = OnceLock::new();
    static LEAD: OnceLock<Regex> = OnceLock::new();
    static FOR_ME: OnceLock<Regex> = OnceLock::new();
    let plain = owner_words(text);
    let named = pattern(&NAMED, r#"(?i)(?-u:\b)(?:called|named|titled)[\s\x{feff}]+["“]([^"”]{2,60})["”]"#)
        .captures(&plain)
        .map(|found| trim(found[1].trim_start_matches('#').trim_start_matches(is_space)).to_string())
        .filter(|name| !name.is_empty());
    if named.is_some() {
        return named;
    }
    // Openers that say nothing about the subject: greetings and request frames.
    let lead = pattern(
        &LEAD,
        r"(?i)^(?:(?:hey|hi|hello|yo|ok(?:ay)?|so|well|please|pls)(?-u:\b)[\s\x{feff},!.:-]*|(?:can|could|would|will) you[\s\x{feff}]+(?:please[\s\x{feff}]+)?|(?:i(?:'d| would) like (?:you )?to|i (?:want|need) (?:you )?to|help me(?: to)?|let'?s|tell me)[\s\x{feff}]+)",
    );
    let mut clause = first_clause(&plain).to_string();
    loop {
        let stripped = trim(&lead.replace(&clause, "")).to_string();
        if stripped == clause {
            break;
        }
        clause = stripped;
    }
    let clause = pattern(&FOR_ME, r"(?i)^(?:for )?me[\s\x{feff}]+").replace(&clause, "");
    let mut words: Vec<&str> =
        clause.trim_end_matches(['?', '!', '.', ',', ':', ';']).split(is_space).filter(|word| !word.is_empty()).take(TITLE_WORDS).collect();
    while words.len() > 1 {
        let last: String = words[words.len() - 1].to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || *c == '\'').collect();
        if !TITLE_TAIL.contains(&last.as_str()) {
            break;
        }
        words.pop();
    }
    if words.len() < 2 {
        return None;
    }
    let title = words.join(" ");
    let title = title.trim_end_matches([',', ':', ';']);
    let mut rest = title.chars();
    Some(match rest.next() {
        Some(first) if first.len_utf16() == 1 => first.to_uppercase().chain(rest).collect(),
        _ => title.to_string(),
    })
}

/// A conversation's summary, built one entry at a time so an index can carry on from where it stopped.
#[derive(Debug, Clone, Default)]
struct LogStateAccumulator {
    title: Option<String>,
    preview: Option<String>,
    derived: Option<String>,
    owner_wrote: bool,
    count: usize,
    active_at: Option<String>,
}

impl LogStateAccumulator {
    fn append(&mut self, entry: &LogEntry) {
        self.count += message_count(entry);
        if let Some(at) = entry.at() {
            self.active_at = (!at.is_empty()).then(|| at.to_string());
        }
        match entry {
            LogEntry::Title { title, .. } => self.title = title.clone(),
            LogEntry::User { text, origin: None, .. } if !self.owner_wrote => {
                // The first owner message titles the conversation, even after a `!command` previewed it.
                self.owner_wrote = true;
                if self.preview.is_none() {
                    // A message of attachments alone still says what it was.
                    self.preview = first_line(&owner_words(text)).or_else(|| (!trim(text).is_empty()).then(|| "Photo".to_string()));
                }
                self.derived = derived_title(text);
            }
            LogEntry::Command { command, excluded: false, .. } if self.preview.is_none() => self.preview = first_line(&format!("!{command}")),
            _ => {}
        }
    }

    fn value(&self) -> LogState {
        LogState {
            title: self.title.clone().or_else(|| self.derived.clone()),
            preview: self.preview.clone(),
            message_count: self.count,
            active_at: self.active_at.clone(),
        }
    }
}

pub fn log_state(entries: &[LogEntry]) -> LogState {
    let mut state = LogStateAccumulator::default();
    for entry in entries {
        state.append(entry);
    }
    state.value()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    Hook,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Hook => "hook",
        }
    }
}

/// One message of a transcript page, as the API serves it.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptMessage {
    pub role: Role,
    pub content: Vec<AssistantPart>,
    pub entry_id: String,
    pub content_truncated: bool,
    pub error_message: Option<String>,
}

impl TranscriptMessage {
    /// `role`, `content`, `entryId`, then `contentTruncated: true` and `errorMessage` only when they apply.
    pub fn to_json(&self) -> Value {
        let mut message = json!({ "role": self.role.as_str(), "content": self.content.iter().map(AssistantPart::to_json).collect::<Vec<_>>(), "entryId": self.entry_id });
        if self.content_truncated {
            message["contentTruncated"] = Value::Bool(true);
        }
        if let Some(error) = &self.error_message {
            message["errorMessage"] = json!(error);
        }
        message
    }
}

fn command_text(output: &str, exit_code: Option<i32>) -> String {
    let status = match exit_code {
        Some(0) => String::new(),
        Some(code) => format!("\n\n(exit {code})"),
        None => "\n\n(exit signal)".to_string(),
    };
    // A fence longer than any backtick run inside, so output holding ``` stays code.
    let (mut fence_length, mut run) = (3, 0);
    for character in output.chars() {
        run = if character == '`' { run + 1 } else { 0 };
        fence_length = fence_length.max(run + 1);
    }
    let fence = "`".repeat(fence_length);
    format!("{fence}\n{}\n{fence}{status}", trim_end(output))
}

/// One entry's renderable messages from its `skip`th, at most `take` of them;
/// `entry_id` names the entry, e<ordinal>.
pub fn entry_messages(entry: &LogEntry, entry_id: &str, skip: usize, take: usize) -> Vec<TranscriptMessage> {
    let message = |role, content, entry_id: String| TranscriptMessage { role, content, entry_id, content_truncated: false, error_message: None };
    match entry {
        LogEntry::User { text, origin, .. } => vec![TranscriptMessage {
            content_truncated: text.len() >= MAX_LOG_TEXT && utf16_len(text) >= MAX_LOG_TEXT,
            ..message(
                if *origin == Some(Origin::Hook) { Role::Hook } else { Role::User },
                vec![AssistantPart::text(text.as_str())],
                entry_id.to_string(),
            )
        }],
        LogEntry::Assistant { content, error, .. } => {
            vec![TranscriptMessage {
                error_message: error.clone().filter(|error| !error.is_empty()),
                ..message(Role::Assistant, content.clone(), entry_id.to_string())
            }]
        }
        LogEntry::Command { command, output, exit_code, excluded: false, .. } => {
            // The owner's `!command`, then its output, as the live turn showed them.
            let mut messages = Vec::new();
            if skip == 0 {
                messages.push(message(Role::User, vec![AssistantPart::text(format!("!{command}"))], entry_id.to_string()));
            }
            if skip.saturating_add(take) > 1 {
                messages.push(message(Role::Assistant, vec![AssistantPart::text(command_text(output, *exit_code))], format!("{entry_id}o")));
            }
            messages
        }
        _ => Vec::new(),
    }
}

fn assistant_text(content: &[AssistantPart]) -> String {
    let parts: Vec<String> = content
        .iter()
        .map(|part| match part {
            AssistantPart::Text { text } => text.clone(),
            // Earlier reasoning is not handed on: only what was said and done.
            AssistantPart::Thinking { .. } => String::new(),
            AssistantPart::ToolCall { name, .. } => format!("[ran {name}]"),
            AssistantPart::Other(value) if value.get("type").and_then(Value::as_str) == Some("text") => {
                value.get("text").and_then(Value::as_str).unwrap_or_default().to_string()
            }
            AssistantPart::Other(value) => format!("[ran {}]", value.get("name").and_then(Value::as_str).unwrap_or("undefined")),
        })
        .collect();
    parts.join("\n")
}

/// The earlier conversation as text, handed to each turn: the newest
/// `HANDOFF_CONTEXT_CHARS`, owner and ghost lines labelled. Read from the
/// newest entry back, so old history costs nothing once the context is full.
pub fn handoff_context(entries: &[LogEntry]) -> Option<String> {
    let mut context = String::new();
    for entry in entries.iter().rev() {
        let line = match entry {
            LogEntry::User { text, origin, .. } => format!("{}: {text}", if *origin == Some(Origin::Hook) { "Hook" } else { "Owner" }),
            LogEntry::Assistant { content, .. } => {
                let text = assistant_text(content);
                match trim(&text) {
                    "" => continue,
                    text => format!("You: {text}"),
                }
            }
            LogEntry::Command { command, output, excluded: false, .. } => format!("Owner ran `{command}`:\n{output}"),
            _ => continue,
        };
        context = if context.is_empty() { line } else { format!("{line}\n\n{context}") };
        if utf16_len(&context) > HANDOFF_CONTEXT_CHARS {
            return Some(format!("…{}", utf16_suffix(&context, HANDOFF_CONTEXT_CHARS)));
        }
    }
    (!context.is_empty()).then_some(context)
}

/// How many transcript messages an entry shows: a `!command` is two, the owner's words and its output.
pub fn message_count(entry: &LogEntry) -> usize {
    match entry {
        LogEntry::Command { excluded, .. } => {
            if *excluded {
                0
            } else {
                2
            }
        }
        LogEntry::User { .. } | LogEntry::Assistant { .. } => 1,
        LogEntry::Conversation { .. } | LogEntry::Title { .. } => 0,
    }
}

/// `\uXXXX` escapes of half a surrogate pair replaced by U+FFFD's, or None
/// when the line has none. The earlier daemon cut a stored text at a UTF-16
/// unit, which could leave half a pair as the last escape of a string; such
/// a line is still an entry.
fn repair_lone_surrogates(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let unit = |at: usize| -> Option<u32> {
        let escape = bytes.get(at..at + 6)?;
        (escape[0] == b'\\' && escape[1] == b'u').then(|| u32::from_str_radix(std::str::from_utf8(&escape[2..]).ok()?, 16).ok())?
    };
    let mut repaired = String::with_capacity(line.len());
    let (mut copied, mut at, mut changed) = (0, 0, false);
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        match unit(at) {
            Some(0xd800..=0xdbff) if matches!(unit(at + 6), Some(0xdc00..=0xdfff)) => at += 12,
            Some(0xd800..=0xdfff) => {
                repaired.push_str(&line[copied..at]);
                repaired.push_str("\\ufffd");
                at += 6;
                copied = at;
                changed = true;
            }
            // Any other escape, an escaped backslash included, is two bytes or more that are not a backslash to read again.
            _ => at += 2,
        }
    }
    repaired.push_str(line.get(copied..).unwrap_or_default());
    changed.then_some(repaired)
}

#[cfg(test)]
thread_local! {
    /// How many lines this thread has parsed, so a test can tell what an index re-read.
    static PARSED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn parse_entry(bytes: &[u8]) -> Option<LogEntry> {
    #[cfg(test)]
    PARSED.with(|parsed| parsed.set(parsed.get() + 1));
    let line = String::from_utf8_lossy(bytes);
    let value: Value = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(_) => serde_json::from_str(&repair_lone_surrogates(&line)?).ok()?,
    };
    LogEntry::from_json(&value)
}

/// Where one entry with messages sits in the file, and which messages are its.
#[derive(Debug, Clone, Copy)]
struct IndexedEntry {
    start: u64,
    end: u64,
    ordinal: usize,
    first: usize,
    count: usize,
}

/// What is known of a log as far as it was read.
struct LogIndex {
    /// Names this index, so offsets kept apart from it are known to be its own.
    generation: u64,
    device: u64,
    inode: u64,
    size: u64,
    modified_ms: i64,
    ordinal: usize,
    total: usize,
    newline_ended: bool,
    summary: LogStateAccumulator,
}

/// Disposable lookup results by path; the one read longest ago is dropped past the limit.
struct Recent<V> {
    limit: usize,
    entries: Vec<(PathBuf, V)>,
}

impl<V> Recent<V> {
    const fn new(limit: usize) -> Self {
        Self { limit, entries: Vec::new() }
    }

    fn take(&mut self, path: &Path) -> Option<V> {
        let at = self.entries.iter().position(|(known, _)| known == path)?;
        Some(self.entries.remove(at).1)
    }

    fn put(&mut self, path: &Path, value: V) {
        self.take(path);
        self.entries.push((path.to_path_buf(), value));
        if self.entries.len() > self.limit {
            self.entries.remove(0);
        }
    }
}

struct Indexes {
    generations: u64,
    logs: Recent<LogIndex>,
    offsets: Recent<(u64, Vec<IndexedEntry>)>,
}

// Summaries remain cheap for long lists; only sixteen logs retain historical offsets.
static INDEXES: Mutex<Indexes> = Mutex::new(Indexes { generations: 0, logs: Recent::new(256), offsets: Recent::new(16) });

/// The indexes are disposable, so a panic while they were held costs nothing: carry on with what is there.
fn indexes() -> MutexGuard<'static, Indexes> {
    INDEXES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Read `index`'s file from `from` to its recorded size, adding each entry to the summary and, when kept, its offsets.
fn scan_index(file: &File, index: &mut LogIndex, from: u64, mut entries: Option<&mut Vec<IndexedEntry>>) -> io::Result<()> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut position = from;
    let mut line_start = from;
    let mut tail: Vec<u8> = Vec::new();
    let mut accept = |index: &mut LogIndex, bytes: &[u8], start: u64, end: u64| {
        let Some(entry) = parse_entry(bytes) else { return };
        let count = message_count(&entry);
        if count > 0
            && let Some(entries) = entries.as_deref_mut()
        {
            entries.push(IndexedEntry { start, end, ordinal: index.ordinal, first: index.total, count });
        }
        index.ordinal += 1;
        index.total += count;
        index.summary.append(&entry);
    };
    while position < index.size {
        let wanted = buffer.len().min((index.size - position) as usize);
        let read = file.read_at(&mut buffer[..wanted], position)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        let mut start = 0;
        while let Some(newline) = chunk[start..].iter().position(|byte| *byte == b'\n').map(|found| start + found) {
            let end = position + newline as u64 + 1;
            if tail.is_empty() {
                accept(index, &chunk[start..newline], line_start, end);
            } else {
                tail.extend_from_slice(&chunk[start..newline]);
                accept(index, &tail, line_start, end);
                tail.clear();
            }
            line_start = end;
            start = newline + 1;
        }
        tail.extend_from_slice(&chunk[start..]);
        position += read as u64;
    }
    index.newline_ended = line_start == index.size;
    if !tail.is_empty() {
        accept(index, &tail, line_start, position);
    }
    Ok(())
}

struct IndexedLogSnapshot {
    modified_ms: i64,
    state: LogState,
    total: usize,
    /// The entries holding the messages asked for, in order.
    records: Vec<IndexedEntry>,
}

/// Bring the log's index up to date and answer from it. `page` is the
/// messages wanted, `(offset, limit)`; None when only the summary is.
/// One log is indexed at a time, so concurrent readers share one scan.
fn indexed_log(path: &Path, page: Option<(usize, usize)>) -> io::Result<Option<IndexedLogSnapshot>> {
    let mut indexes = indexes();
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            indexes.logs.take(path);
            return if error.kind() == io::ErrorKind::NotFound { Ok(None) } else { Err(error) };
        }
    };
    let info = file.metadata()?;
    let cached = indexes.logs.take(path);
    let offsets = match (indexes.offsets.take(path), &cached) {
        (Some((generation, entries)), Some(index)) if generation == index.generation => Some(entries),
        _ => None,
    };
    // ghostd only ever appends, so the same file grown past a whole last
    // line is read from where the index stopped; anything else is reindexed.
    let (mut index, mut entries, from) = match cached {
        Some(index)
            if index.inode == info.ino()
                && index.device == info.dev()
                && info.len() >= index.size
                && index.newline_ended
                && (page.is_none() || offsets.is_some()) =>
        {
            let from = index.size;
            (index, offsets, from)
        }
        _ => {
            indexes.generations += 1;
            let index = LogIndex {
                generation: indexes.generations,
                device: info.dev(),
                inode: info.ino(),
                size: 0,
                modified_ms: 0,
                ordinal: 0,
                total: 0,
                newline_ended: true,
                summary: LogStateAccumulator::default(),
            };
            (index, Some(Vec::new()), 0)
        }
    };
    if from == 0 || info.len() != index.size {
        index.size = info.len();
        index.modified_ms = info.mtime() * 1000 + info.mtime_nsec() / 1_000_000;
        // A failed scan leaves no index behind: the next read starts over.
        scan_index(&file, &mut index, from, entries.as_mut())?;
    }
    let records = match (page, &entries) {
        (Some((offset, limit)), Some(entries)) => {
            let end = offset.saturating_add(limit);
            let low = entries.partition_point(|entry| entry.first + entry.count <= offset);
            entries[low..].iter().take_while(|entry| entry.first < end).copied().collect()
        }
        _ => Vec::new(),
    };
    let snapshot = IndexedLogSnapshot { modified_ms: index.modified_ms, state: index.summary.value(), total: index.total, records };
    if let Some(entries) = entries {
        indexes.offsets.put(path, (index.generation, entries));
    }
    indexes.logs.put(path, index);
    Ok(Some(snapshot))
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TranscriptPage {
    pub messages: Vec<TranscriptMessage>,
    /// Every message in the conversation, not only this page's.
    pub total: usize,
}

/// Messages `offset..offset + limit` of the conversation. Only those are
/// read from the file once the disposable index is current.
pub fn read_transcript_page(session_dir: &Path, id: &str, offset: usize, limit: usize) -> io::Result<TranscriptPage> {
    let path = log_path(session_dir, id);
    let Some(index) = indexed_log(&path, Some((offset, limit)))? else { return Ok(TranscriptPage::default()) };
    // Indexed records stay where they are while the log grows, so a page reads
    // them in place; a log trashed since it was indexed reads as empty.
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(TranscriptPage::default()),
        Err(error) => return Err(error),
    };
    let end = offset.saturating_add(limit);
    let mut messages = Vec::new();
    for record in index.records {
        let mut bytes = vec![0u8; (record.end - record.start) as usize];
        let mut read = 0;
        while read < bytes.len() {
            match file.read_at(&mut bytes[read..], record.start + read as u64)? {
                0 => break,
                more => read += more,
            }
        }
        let Some(entry) = parse_entry(&bytes[..read]) else { continue };
        messages.extend(entry_messages(&entry, &format!("e{}", record.ordinal), offset.saturating_sub(record.first), end - offset.max(record.first)));
    }
    Ok(TranscriptPage { messages, total: index.total })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedLog {
    pub state: LogState,
    /// When the conversation was last added to, else when its file was last written.
    pub updated_at: String,
}

/// The conversation's summary, or None when it has no log. Summary reads and
/// transcript pages share one disposable file index.
pub fn listed_log(session_dir: &Path, id: &str) -> io::Result<Option<ListedLog>> {
    Ok(indexed_log(&log_path(session_dir, id), None)?.map(|indexed| {
        let updated_at = indexed.state.active_at.clone().unwrap_or_else(|| crate::clock::iso(indexed.modified_ms));
        ListedLog { state: indexed.state, updated_at }
    }))
}

/// How a shell command started in a conversation names it: the variables the
/// `ghost` CLI reads to address this conversation. Every tool the model runs
/// and every owner `!` command runs with them.
pub fn conversation_environment(id: &str) -> [(String, String); 1] {
    [("GHOST_SESSION".to_string(), id.to_string())]
}

#[cfg(test)]
#[path = "conversation_log_tests.rs"]
mod tests;
