//! The conversation's record, `conversation/.conversation.jsonl` in the ghost
//! home: what the owner said, what the ghost answered, the tools it ran, the
//! owner's `!` commands. The bar, `ghost show` and the phone read it, and each
//! turn is handed it: the model keeps no session of its own.
//!
//! The file is one JSON object per line, appended only. Lengths and limits
//! are in characters, and a cut never lands inside one.
use crate::text;
use serde_json::{Map, Value, json};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

/// A stored text is cut here; the transcript marks a cut owner or hook message `contentTruncated`.
const MAX_LOG_TEXT: usize = 200_000;
const PREVIEW_MAX: usize = 120;
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
        /// that never ended.
        output: Option<String>,
    },
    /// The note the ghost wrote when the conversation neared the model's
    /// context: later turns are handed it in place of the log's first
    /// `covers` entries. It is written in the background, so entries may have
    /// been added after those and before the note itself. `topics` is what
    /// those turns are told of the topic documents, as they stood when the
    /// note was written; None when there were none. The entry's other parts
    /// are what the ghost did to bring those documents up to date.
    Handoff {
        text: String,
        covers: usize,
        topics: Option<String>,
    },
}

impl AssistantPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    /// As the log and the API carry it: `type`, then `text` (a handoff's with `covers`, and `topics` when it has them), or `id`, `name`, `arguments`, `failed` only when true, and `output` once the call has ended.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text { text } => json!({ "type": "text", "text": text }),
            Self::Thinking { text } => json!({ "type": "thinking", "text": text }),
            Self::Handoff { text, covers, topics } => {
                let mut part = json!({ "type": "handoff", "text": text, "covers": covers });
                if let Some(topics) = topics {
                    part["topics"] = json!(topics);
                }
                part
            }
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
        }
    }

    /// The part a logged value holds, or None for a shape this version does not write.
    fn from_json(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        match value.get("type").and_then(Value::as_str) {
            Some("text") => text("text").map(|text| Self::Text { text }),
            Some("thinking") => text("text").map(|text| Self::Thinking { text }),
            Some("handoff") => match (text("text"), value.get("covers").and_then(Value::as_u64)) {
                (Some(note), Some(covers)) => Some(Self::Handoff { text: note, covers: covers as usize, topics: text("topics") }),
                _ => None,
            },
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
        }
    }
}

/// Who a `user` entry is from when it is not the owner typing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    FollowUp,
    Hook,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Self::FollowUp => "follow_up",
            Self::Hook => "hook",
        }
    }
}

/// One line of the log. `at` and `created_at` are ISO times as `crate::clock` writes them.
#[derive(Debug, Clone, PartialEq)]
pub enum LogEntry {
    /// `topics` is what the conversation is told of the topic documents, as
    /// they stood when it started; None when there were none.
    Conversation {
        created_at: String,
        topics: Option<String>,
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
}

impl LogEntry {
    /// A message added now: the owner's, or with an `origin`, a follow-up's or a hook's.
    pub fn user(text: impl Into<String>, origin: Option<Origin>) -> Self {
        Self::User { at: crate::clock::now_iso(), text: text.into(), origin }
    }

    /// When the entry was added; None for the `conversation` line, which has `created_at`.
    fn at(&self) -> Option<&str> {
        match self {
            Self::Conversation { .. } => None,
            Self::User { at, .. } | Self::Assistant { at, .. } | Self::Command { at, .. } => Some(at),
        }
    }

    /// The line's JSON, its keys in the order the log's tests pin.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Conversation { created_at, topics } => {
                let mut entry = json!({ "type": "conversation", "createdAt": created_at });
                if let Some(topics) = topics {
                    entry["topics"] = json!(topics);
                }
                entry
            }
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
        }
    }

    /// The entry a parsed line holds, or None for a line this version does not
    /// write. A known entry is never refused for a missing field (it reads as
    /// empty): every entry read keeps its place in the count that names them.
    fn from_json(value: &Value) -> Option<Self> {
        let entry: &Map<String, Value> = value.as_object()?;
        let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let at = || text("at");
        Some(match entry.get("type")?.as_str()? {
            "conversation" => {
                Self::Conversation { created_at: text("createdAt"), topics: entry.get("topics").and_then(Value::as_str).map(str::to_string) }
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
                    .map(|parts| parts.iter().filter_map(AssistantPart::from_json).collect())
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
            _ => return None,
        })
    }
}

pub fn log_path(conversation_dir: &Path) -> PathBuf {
    conversation_dir.join(LOG_FILENAME)
}

/// `text` within the stored limit. A cut that would split a character ends in
/// U+FFFD instead, so a cut text is always exactly the limit long.
fn bounded(text: &str) -> String {
    text::prefix(text, MAX_LOG_TEXT).to_string()
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
        LogEntry::Conversation { .. } => {}
    }
    entry
}

/// Add entries to the conversation's log in one write, making its directory (0700) and the file (0600) when new.
pub fn append_log(conversation_dir: &Path, entries: &[LogEntry]) -> io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(conversation_dir)?;
    let lines: String = entries.iter().map(|entry| format!("{}\n", bounded_entry(entry).to_json())).collect();
    std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(log_path(conversation_dir))?.write_all(lines.as_bytes())
}

/// Every well-formed entry, or None when the conversation has no log; a torn last line from a crash is skipped.
pub fn read_log(conversation_dir: &Path) -> io::Result<Option<Vec<LogEntry>>> {
    let bytes = match std::fs::read(log_path(conversation_dir)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    // A partial line is what a crash mid-append leaves; the rest stands.
    Ok(Some(bytes.split(|byte| *byte == b'\n').filter_map(parse_entry).collect()))
}

/// The first line of a new log; `topics` is what the conversation is told of the topic documents (`topics::opening`).
pub fn new_conversation_entry(now_ms: i64, topics: Option<String>) -> LogEntry {
    LogEntry::Conversation { created_at: crate::clock::iso(now_ms), topics }
}

/// What `GET /api/conversation` says of the log.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LogState {
    /// The first line of the first thing the owner wrote.
    pub preview: Option<String>,
    pub message_count: usize,
    /// When the owner or the ghost last added to the conversation.
    pub active_at: Option<String>,
}

/// A line that is one attached image and nothing else: `![…](attachments/<name>)`.
fn is_attachment_line(line: &str) -> bool {
    let name = line
        .strip_prefix("![")
        .and_then(|rest| rest.split_once(']'))
        .and_then(|(_, rest)| rest.strip_prefix("(attachments/"))
        .and_then(|rest| rest.strip_suffix(')'));
    name.is_some_and(|name| {
        !name.is_empty() && !name.contains(|character: char| character == ')' || character == '\u{feff}' || character.is_whitespace())
    })
}

/// The first line of `lines` that says anything, cut to the preview's length.
fn first_line<'a>(lines: impl Iterator<Item = &'a str>) -> Option<String> {
    let line = lines.map(str::trim).find(|line| !line.is_empty())?;
    Some(if text::len(line) > PREVIEW_MAX { text::prefix(line, PREVIEW_MAX).trim_end().to_string() } else { line.to_string() })
}

pub fn log_state(entries: &[LogEntry]) -> LogState {
    let mut state = LogState::default();
    for entry in entries {
        state.message_count += message_count(entry);
        if let Some(at) = entry.at() {
            state.active_at = (!at.is_empty()).then(|| at.to_string());
        }
        match entry {
            LogEntry::User { text, origin: None, .. } if state.preview.is_none() => {
                // The owner's words, without the lines that only attach an image; a message of attachments alone still says what it was.
                let words = text.split('\n').filter(|line| !is_attachment_line(line.strip_suffix('\r').unwrap_or(line)));
                state.preview = first_line(words).or_else(|| (!text.trim().is_empty()).then(|| "Photo".to_string()));
            }
            LogEntry::Command { command, excluded: false, .. } if state.preview.is_none() => {
                state.preview = first_line(format!("!{command}").split('\n'));
            }
            _ => {}
        }
    }
    state
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    User,
    Assistant,
    Hook,
}

impl Role {
    fn as_str(self) -> &'static str {
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
    role: Role,
    content: Vec<AssistantPart>,
    entry_id: String,
    content_truncated: bool,
    error_message: Option<String>,
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
    format!("{fence}\n{}\n{fence}{status}", output.trim_end())
}

/// One entry's renderable messages from its `skip`th, at most `take` of them;
/// `entry_id` names the entry, e<ordinal>.
fn entry_messages(entry: &LogEntry, entry_id: &str, skip: usize, take: usize) -> Vec<TranscriptMessage> {
    let message = |role, content, entry_id: String| TranscriptMessage { role, content, entry_id, content_truncated: false, error_message: None };
    match entry {
        LogEntry::User { text, origin, .. } => vec![TranscriptMessage {
            content_truncated: text.len() >= MAX_LOG_TEXT && text::len(text) >= MAX_LOG_TEXT,
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

/// How many transcript messages an entry shows: a `!command` is two, the owner's words and its output.
fn message_count(entry: &LogEntry) -> usize {
    match entry {
        LogEntry::Command { excluded, .. } => {
            if *excluded {
                0
            } else {
                2
            }
        }
        LogEntry::User { .. } | LogEntry::Assistant { .. } => 1,
        LogEntry::Conversation { .. } => 0,
    }
}

fn parse_entry(bytes: &[u8]) -> Option<LogEntry> {
    let line = String::from_utf8_lossy(bytes);
    LogEntry::from_json(&serde_json::from_str(&line).ok()?)
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TranscriptPage {
    pub messages: Vec<TranscriptMessage>,
    /// Every message in the conversation, not only this page's.
    pub total: usize,
}

/// Messages `offset..offset + limit` of the conversation, each named by its entry's place in the log.
pub fn transcript_page(entries: &[LogEntry], offset: usize, limit: usize) -> TranscriptPage {
    let end = offset.saturating_add(limit);
    let mut page = TranscriptPage::default();
    for (index, entry) in entries.iter().enumerate() {
        let count = message_count(entry);
        let first = page.total;
        page.total += count;
        if count == 0 || first >= end || page.total <= offset {
            continue;
        }
        page.messages.extend(entry_messages(entry, &format!("e{index}"), offset.saturating_sub(first), end - offset.max(first)));
    }
    page
}

#[cfg(test)]
#[path = "conversation_log_tests.rs"]
mod tests;
