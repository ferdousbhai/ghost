//! The conversation's record, `conversation/.conversation.jsonl` in the ghost
//! home: what the owner said, what the ghost answered, the tools it ran, the
//! owner's `!` commands. The bar, `ghost show` and the phone read it, and each
//! turn is handed it: the model keeps no session of its own.
//!
//! The file is one JSON object per line, appended only. Lengths and limits
//! are in characters, and a cut never lands inside one.
use crate::text;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::fs::File;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const LOG_VERSION: i64 = 1;
/// A stored text is cut here; the transcript marks a cut owner or hook message `contentTruncated`.
pub const MAX_LOG_TEXT: usize = 200_000;
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
    /// been added after those and before the note itself.
    Handoff {
        text: String,
        covers: usize,
    },
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
            Self::Handoff { text, covers } => json!({ "type": "handoff", "text": text, "covers": covers }),
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
    pub fn from_json(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        match value.get("type").and_then(Value::as_str) {
            Some("text") => text("text").map(|text| Self::Text { text }),
            Some("thinking") => text("text").map(|text| Self::Thinking { text }),
            Some("handoff") => match (text("text"), value.get("covers").and_then(Value::as_u64)) {
                (Some(text), Some(covers)) => Some(Self::Handoff { text, covers: covers as usize }),
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
            Self::User { at, .. } | Self::Assistant { at, .. } | Self::Command { at, .. } => Some(at),
        }
    }

    /// The line's JSON, keys in the order every version has written them.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Conversation { v, created_at } => json!({ "type": "conversation", "v": v, "createdAt": created_at }),
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
    pub fn from_json(value: &Value) -> Option<Self> {
        let entry: &Map<String, Value> = value.as_object()?;
        let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let at = || text("at");
        Some(match entry.get("type")?.as_str()? {
            "conversation" => Self::Conversation { v: entry.get("v").and_then(Value::as_i64).unwrap_or(LOG_VERSION), created_at: text("createdAt") },
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

/// The first line of a new log.
pub fn new_conversation_entry(now_ms: i64) -> LogEntry {
    LogEntry::Conversation { v: LOG_VERSION, created_at: crate::clock::iso(now_ms) }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LogState {
    /// The first line of the first thing the owner wrote.
    pub preview: Option<String>,
    pub message_count: usize,
    /// When the owner or the ghost last added to the conversation.
    pub active_at: Option<String>,
}

/// The owner's words without attachment markers: an imported `[Attachment: …]` or an attached image's line.
fn owner_words(text: &str) -> String {
    static MARKERS: OnceLock<Regex> = OnceLock::new();
    let markers =
        MARKERS.get_or_init(|| Regex::new(r"(?mR)\[Attachment:[^\]]*\]|^!\[[^\]]*\]\(attachments/[^)\s\x{feff}]+\)$").expect("a valid pattern"));
    markers.replace_all(text, " ").trim().to_string()
}

fn first_line(text: &str) -> Option<String> {
    let line = text.split('\n').map(str::trim).find(|part| !part.is_empty())?;
    Some(if text::len(line) > PREVIEW_MAX { text::prefix(line, PREVIEW_MAX).trim_end().to_string() } else { line.to_string() })
}

/// The conversation's summary, built one entry at a time so an index can carry on from where it stopped.
#[derive(Debug, Clone, Default)]
struct LogStateAccumulator {
    preview: Option<String>,
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
            LogEntry::User { text, origin: None, .. } if self.preview.is_none() => {
                // A message of attachments alone still says what it was.
                self.preview = first_line(&owner_words(text)).or_else(|| (!text.trim().is_empty()).then(|| "Photo".to_string()));
            }
            LogEntry::Command { command, excluded: false, .. } if self.preview.is_none() => self.preview = first_line(&format!("!{command}")),
            _ => {}
        }
    }

    fn value(&self) -> LogState {
        LogState { preview: self.preview.clone(), message_count: self.count, active_at: self.active_at.clone() }
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
    format!("{fence}\n{}\n{fence}{status}", output.trim_end())
}

/// One entry's renderable messages from its `skip`th, at most `take` of them;
/// `entry_id` names the entry, e<ordinal>.
pub fn entry_messages(entry: &LogEntry, entry_id: &str, skip: usize, take: usize) -> Vec<TranscriptMessage> {
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
        LogEntry::Conversation { .. } => 0,
    }
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
    LogEntry::from_json(&serde_json::from_str(&line).ok()?)
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

/// What is known of the log as far as it was read.
struct LogIndex {
    device: u64,
    inode: u64,
    size: u64,
    modified_ms: i64,
    ordinal: usize,
    total: usize,
    newline_ended: bool,
    summary: LogStateAccumulator,
    /// Every entry with messages, in order.
    entries: Vec<IndexedEntry>,
}

/// Read `index`'s file from `from` to its recorded size, adding each entry to the summary and the offsets.
fn scan_index(file: &File, index: &mut LogIndex, from: u64) -> io::Result<()> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut position = from;
    let mut line_start = from;
    let mut tail: Vec<u8> = Vec::new();
    let accept = |index: &mut LogIndex, bytes: &[u8], start: u64, end: u64| {
        let Some(entry) = parse_entry(bytes) else { return };
        let count = message_count(&entry);
        if count > 0 {
            index.entries.push(IndexedEntry { start, end, ordinal: index.ordinal, first: index.total, count });
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

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TranscriptPage {
    pub messages: Vec<TranscriptMessage>,
    /// Every message in the conversation, not only this page's.
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedLog {
    pub state: LogState,
    /// When the conversation was last added to, else when its file was last written.
    pub updated_at: String,
}

/// The log as its readers see it, through a disposable index of how far it was
/// read: a summary reads only what was appended since, and a page only its own
/// records.
pub struct IndexedLog {
    path: PathBuf,
    index: Mutex<Option<LogIndex>>,
}

impl IndexedLog {
    pub fn new(conversation_dir: &Path) -> Self {
        Self { path: log_path(conversation_dir), index: Mutex::new(None) }
    }

    /// Bring the index up to date and answer from it. `page` is the messages
    /// wanted, `(offset, limit)`; None when only the summary is. The log is
    /// indexed under one lock, so concurrent readers share one scan.
    fn refresh(&self, page: Option<(usize, usize)>) -> io::Result<Option<IndexedLogSnapshot>> {
        // The index is disposable, so a panic while it was held costs nothing: carry on with what is there.
        let mut held = self.index.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Taken out while it is brought up to date: a failed scan leaves no index behind, and the next read starts over.
        let cached = held.take();
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let info = file.metadata()?;
        // ghostd only ever appends, so the same file grown past a whole last
        // line is read from where the index stopped; anything else is reindexed.
        let (mut index, from) = match cached {
            Some(index) if index.inode == info.ino() && index.device == info.dev() && info.len() >= index.size && index.newline_ended => {
                let from = index.size;
                (index, from)
            }
            _ => {
                let index = LogIndex {
                    device: info.dev(),
                    inode: info.ino(),
                    size: 0,
                    modified_ms: 0,
                    ordinal: 0,
                    total: 0,
                    newline_ended: true,
                    summary: LogStateAccumulator::default(),
                    entries: Vec::new(),
                };
                (index, 0)
            }
        };
        if from == 0 || info.len() != index.size {
            index.size = info.len();
            index.modified_ms = info.mtime() * 1000 + info.mtime_nsec() / 1_000_000;
            scan_index(&file, &mut index, from)?;
        }
        let records = match page {
            Some((offset, limit)) => {
                let end = offset.saturating_add(limit);
                let low = index.entries.partition_point(|entry| entry.first + entry.count <= offset);
                index.entries[low..].iter().take_while(|entry| entry.first < end).copied().collect()
            }
            None => Vec::new(),
        };
        let snapshot = IndexedLogSnapshot { modified_ms: index.modified_ms, state: index.summary.value(), total: index.total, records };
        *held = Some(index);
        Ok(Some(snapshot))
    }

    /// Messages `offset..offset + limit` of the conversation. Only those are
    /// read from the file once the index is current.
    pub fn page(&self, offset: usize, limit: usize) -> io::Result<TranscriptPage> {
        let Some(index) = self.refresh(Some((offset, limit)))? else { return Ok(TranscriptPage::default()) };
        // Indexed records stay where they are while the log grows, so a page reads
        // them in place; a log trashed since it was indexed reads as empty.
        let file = match File::open(&self.path) {
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
            messages.extend(entry_messages(
                &entry,
                &format!("e{}", record.ordinal),
                offset.saturating_sub(record.first),
                end - offset.max(record.first),
            ));
        }
        Ok(TranscriptPage { messages, total: index.total })
    }

    /// The conversation's summary, or None when it has no log.
    pub fn listed(&self) -> io::Result<Option<ListedLog>> {
        Ok(self.refresh(None)?.map(|indexed| {
            let updated_at = indexed.state.active_at.clone().unwrap_or_else(|| crate::clock::iso(indexed.modified_ms));
            ListedLog { state: indexed.state, updated_at }
        }))
    }
}

#[cfg(test)]
#[path = "conversation_log_tests.rs"]
mod tests;
