//! The owner's own data, one adapter per product (CONTRACTS.md "Sources").
//! Each product keeps its own sign-in, sync, local copy, and CLI; an adapter
//! only lists, reads, and searches what that product already has, through
//! its JSON output or its documented folder. Ghost copies nothing and syncs
//! nothing. File-backed sources share one meaning index, Recall's, and a hit
//! is labelled with the source whose folder holds it.
use crate::abort::Abort;
use crate::env::{Env, which};
use crate::error::{GhostError, Result};
use crate::process::CommandFailure;
use crate::xdg;
use regex::Regex;
use serde_json::{Map, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, UNIX_EPOCH};

pub const SOURCE_IDS: &[&str] = &[
    "files",
    "notes",
    "reminders",
    "keep",
    "whatsapp",
    "drive",
    "google-drive",
    "mail",
    "contacts",
    "calendar",
    "photos",
    "google-photos",
    "lastbook",
];

/// How many items a search returns from each source when the caller names no limit.
pub const DEFAULT_SEARCH_LIMIT: usize = 8;

/// The largest picture served; a product's thumbnail is a small fraction of it.
const PICTURE_BYTES: u64 = 4 * 1024 * 1024;

/// The most text one read returns; a model's result is cut far shorter.
pub const READ_CHARS: usize = 256 * 1024;

/// How long one product command gets to answer.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Where a request's home, environment and stop signal come from. It is a
/// handful of borrowed references, so it is copied freely.
#[derive(Clone, Copy)]
pub struct SourceContext<'a> {
    pub home: &'a Path,
    pub env: &'a Env,
    pub abort: &'a Abort,
}

/// What a source returns for one thing: enough to show it in a list and to read it.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceItem {
    pub source: &'static str,
    /// Stable within the source; `read` takes it.
    pub id: String,
    pub title: String,
    pub snippet: String,
    /// Milliseconds since the epoch, or None when the source keeps no time.
    pub at: Option<f64>,
    /// The local file, when the item is one.
    pub path: Option<String>,
    /// A search hit's PDF page or matching line.
    pub page: Option<u64>,
    pub line: Option<u64>,
}

impl SourceItem {
    /// The item on the wire; a key with no value is left out.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("source".into(), self.source.into());
        map.insert("id".into(), self.id.as_str().into());
        map.insert("title".into(), self.title.as_str().into());
        map.insert("snippet".into(), self.snippet.as_str().into());
        map.insert("at".into(), self.at.map_or(Value::Null, number_json));
        if let Some(path) = &self.path {
            map.insert("path".into(), path.as_str().into());
        }
        if let Some(page) = self.page {
            map.insert("page".into(), page.into());
        }
        if let Some(line) = self.line {
            map.insert("line".into(), line.into());
        }
        Value::Object(map)
    }
}

/// A hit as `read` needs it: the item's locators, and Recall's passage for a file.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SourceRef {
    pub source: String,
    pub id: String,
    pub page: Option<u64>,
    pub line: Option<u64>,
    /// Recall's segment id; valid until Recall reindexes, so never on the wire.
    pub segment: Option<f64>,
}

/// One item read: its text and which part of it that is.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceDocument {
    pub title: String,
    pub text: String,
    /// `whole`, `passage`, `start`, `lines 12-91`, `page 3`, `latest`.
    pub part: String,
    pub path: Option<String>,
}

impl SourceDocument {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("title".into(), self.title.as_str().into());
        map.insert("text".into(), self.text.as_str().into());
        map.insert("part".into(), self.part.as_str().into());
        if let Some(path) = &self.path {
            map.insert("path".into(), path.as_str().into());
        }
        Value::Object(map)
    }
}

/// One page of a list. `next` goes back as `cursor` for the next page; None on the last.
#[derive(Debug, Clone, PartialEq)]
pub struct SourcePage {
    pub items: Vec<SourceItem>,
    pub next: Option<String>,
}

impl SourcePage {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("items".into(), self.items.iter().map(SourceItem::to_json).collect());
        map.insert("next".into(), self.next.as_deref().map_or(Value::Null, Value::from));
        Value::Object(map)
    }
}

/// A file search hit with what `read` needs to return its passage.
#[derive(Debug, Clone, PartialEq)]
pub struct FileHit {
    pub item: SourceItem,
    /// Recall's segment id for the passage that matched.
    pub segment: Option<f64>,
}

impl FileHit {
    pub fn to_ref(&self) -> SourceRef {
        SourceRef {
            source: self.item.source.to_string(),
            id: self.item.id.clone(),
            page: self.item.page,
            line: self.item.line,
            segment: self.segment,
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

/// What a command printed, and why it failed when it did.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandOutput {
    pub out: String,
    /// The command's stderr, or what went wrong running it; None when it exited 0.
    pub error: Option<String>,
}

/// Run one product command to its end, with `input` on its stdin.
pub fn run_command(command: &str, args: &[impl AsRef<str>], context: SourceContext, input: Option<&str>) -> CommandOutput {
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    match crate::process::run_command(command, &args, context.env, input, COMMAND_TIMEOUT, context.abort) {
        Ok(result) if result.code == 0 => CommandOutput { out: result.stdout, error: None },
        Ok(result) => {
            let stderr = result.stderr.trim();
            let error = if stderr.is_empty() { format!("Command failed: {command} {}", args.join(" ")) } else { stderr.to_string() };
            CommandOutput { out: result.stdout, error: Some(error) }
        }
        Err(CommandFailure::Missing) => CommandOutput { out: String::new(), error: Some(format!("spawn {command} ENOENT")) },
        Err(CommandFailure::Other(message)) => CommandOutput { out: String::new(), error: Some(message) },
    }
}

/// A product CLI's `--quiet` data, or the 502 that names the product's own error.
fn cli_data(command: &str, args: &[impl AsRef<str>], context: SourceContext) -> Result<Value> {
    let CommandOutput { out, error } = run_command(command, args, context, None);
    let data = json(&out);
    match error {
        Some(error) if data.is_null() => Err(GhostError::new("source_failed", format!("{command} failed: {}", one_line(&error, 300)), 502)),
        _ => Ok(data),
    }
}

/// The JSON a command printed, or null when it is not JSON.
pub fn json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// The start of `text` that is at most `limit` UTF-16 units long, as
/// JavaScript counts a string, never ending inside a character.
pub fn cut(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (at, character) in text.char_indices() {
        units += character.len_utf16();
        if units > limit {
            return &text[..at];
        }
    }
    text
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text` on one line: every run of white space is one space, the ends are trimmed, and it is cut at `limit`.
pub fn one_line(text: &str, limit: usize) -> String {
    let joined = text.split(|c: char| c.is_whitespace() || c == '\u{feff}').filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
    cut(&joined, limit).to_string()
}

/// A JSON value that is there and not null.
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// A number as JavaScript prints it: no `.0` on a whole one.
pub fn number_text(number: f64) -> String {
    if number.is_nan() {
        "NaN".into()
    } else if number.is_infinite() {
        if number > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if number.fract() == 0.0 && number.abs() < 9.0e15 {
        (number as i64).to_string()
    } else {
        number.to_string()
    }
}

/// A number as JSON: an integer when it is whole, as JavaScript writes it.
fn number_json(number: f64) -> Value {
    if number.fract() == 0.0 && number.abs() < 9.0e15 {
        Value::from(number as i64)
    } else {
        serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

/// A JSON value as text, the way JavaScript's `String(value)` reads one.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.as_f64().map_or_else(|| number.to_string(), number_text),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => {
            items.iter().map(|item| if item.is_null() { String::new() } else { js_string(Some(item)) }).collect::<Vec<_>>().join(",")
        }
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// A value's text, empty when it is missing or null.
fn text_of(value: Option<&Value>) -> String {
    present(value).map_or_else(String::new, |value| js_string(Some(value)))
}

/// One line of a JSON value, empty when it is missing or null.
pub fn one_line_of(value: Option<&Value>, limit: usize) -> String {
    one_line(&text_of(value), limit)
}

/// Whether JavaScript would take the value as true.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A piece of text as a number, as JavaScript's `Number(text)`: empty is 0, anything else unreadable is NaN.
fn text_number(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) }
}

/// A JSON value as a number, 0 when it is missing or null.
pub fn number_of(value: Option<&Value>) -> f64 {
    match present(value) {
        None => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => text_number(text),
        Some(_) => f64::NAN,
    }
}

/// The rows of a JSON array that are objects.
fn records(value: Option<&Value>) -> Vec<&Value> {
    value.and_then(Value::as_array).map(|rows| rows.iter().filter(|row| row.is_object() || row.is_array()).collect()).unwrap_or_default()
}

/// A time a product gave, as milliseconds: a number as it is, an ISO string parsed, anything else no time.
fn ms(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite()),
        Some(Value::String(text)) => crate::clock::parse_iso(text).map(|ms| ms as f64),
        _ => None,
    }
}

/// Newest first, from before a time cursor, one page of `limit`.
fn time_page(items: Vec<SourceItem>, limit: usize, cursor: Option<&str>) -> SourcePage {
    let before = cursor.map_or(f64::INFINITY, text_number);
    let mut sorted: Vec<SourceItem> = items.into_iter().filter(|item| item.at.unwrap_or(0.0) < before).collect();
    sorted.sort_by(|a, b| b.at.unwrap_or(0.0).total_cmp(&a.at.unwrap_or(0.0)));
    let more = sorted.len() > limit;
    sorted.truncate(limit);
    let next = sorted.last().filter(|_| more).map(|last| number_text(last.at.unwrap_or(0.0)));
    SourcePage { items: sorted, next }
}

/// An offset page, for sources with no time order.
fn offset_page(items: Vec<SourceItem>, limit: usize, cursor: Option<&str>) -> SourcePage {
    let offset = cursor.map_or(0.0, text_number);
    let from = if offset.is_nan() || offset <= 0.0 { 0 } else { (offset.min(items.len() as f64)) as usize };
    let end = from.saturating_add(limit);
    let next = (end < items.len()).then(|| end.to_string());
    SourcePage { items: items.into_iter().skip(from).take(limit).collect(), next }
}

/// A path made absolute without touching the disk; a relative one is under the daemon's working directory, where opening it would look.
fn absolute(path: &str) -> PathBuf {
    let base = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    xdg::resolve(&base, Path::new(path))
}

/// Whether `path` is below `root`, by name alone: `..` is folded first, and links are not followed.
fn inside(root: &str, path: &str) -> bool {
    let (root, path) = (absolute(root), absolute(path));
    match path.strip_prefix(&root) {
        Ok(rest) => rest.components().next().is_some_and(|first| !first.as_os_str().to_string_lossy().starts_with("..")),
        Err(_) => false,
    }
}

/// The last name in a path.
fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// A path without its last name.
fn dirname(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/",
        Some(at) => &trimmed[..at],
        None => ".",
    }
}

fn join(base: &str, name: &str) -> String {
    Path::new(base).join(name).to_string_lossy().into_owned()
}

/// `bytes` without a character cut in half at its end.
fn whole_characters(bytes: &[u8]) -> &[u8] {
    let length = bytes.len();
    for back in 1..=length.min(4) {
        let byte = bytes[length - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let needed = match byte {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => 1,
        };
        return if needed > back { &bytes[..length - back] } else { bytes };
    }
    bytes
}

/// A file's first `limit` bytes, and whether that is all of it.
fn file_head(path: &str, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    let whole = bytes.len() <= limit;
    if !whole {
        bytes.truncate(limit);
        let kept = whole_characters(&bytes).len();
        bytes.truncate(kept);
    }
    Ok((bytes, whole))
}

/// A file's text up to the read limit (counted in bytes); None when it holds a zero byte, so is not text.
fn file_text(path: &str) -> std::io::Result<Option<(String, bool)>> {
    let (bytes, whole) = file_head(path, READ_CHARS)?;
    Ok((!bytes.contains(&0)).then(|| (String::from_utf8_lossy(&bytes).into_owned(), whole)))
}

/// The end of a file, at most `limit` bytes, starting at a whole line when the file is longer.
fn file_tail(path: &str, limit: usize) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let length = size.min(limit as u64);
    file.seek(SeekFrom::Start(size - length))?;
    let mut bytes = Vec::new();
    file.take(length).read_to_end(&mut bytes)?;
    if size <= length {
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    // The cut may land inside a character; its leftover bytes are not text.
    let start = bytes.iter().take(3).take_while(|byte| *byte & 0xC0 == 0x80).count();
    let text = String::from_utf8_lossy(&bytes[start..]);
    Ok(text[text.find('\n').map_or(0, |at| at + 1)..].to_string())
}

static PADDING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]{2,}").unwrap());

fn pdf_page(path: &str, page: u64, context: SourceContext) -> Result<SourceDocument> {
    let number = page.to_string();
    let CommandOutput { out, error } = run_command("pdftotext", &["-layout", "-f", &number, "-l", &number, path, "-"], context, None);
    if let Some(error) = error {
        return Err(GhostError::new("source_failed", format!("Cannot read page {page} of {path}: {}", one_line(&error, 300)), 502));
    }
    // Layout mode keeps a table's rows together; its column padding is collapsed, which halves an invoice page.
    let text = PADDING.replace_all(&out, "  ").trim().to_string();
    Ok(SourceDocument {
        title: basename(path).to_string(),
        path: Some(path.to_string()),
        part: format!("page {page}"),
        text: if text.is_empty() { "(no text on this page)".into() } else { text },
    })
}

// ── Folders ────────────────────────────────────────────────────────────

fn home_text(context: SourceContext) -> String {
    context.home.to_string_lossy().into_owned()
}

/// The products' documented folders, so a file hit is labelled with its source.
fn folders(context: SourceContext) -> [(&'static str, String); 6] {
    let documents = xdg::documents_dir(context.env, context.home);
    let under = |base: &Path, name: &str| base.join(name).to_string_lossy().into_owned();
    [
        ("notes", under(&documents, "Notes")),
        ("reminders", under(&documents, "Reminders")),
        ("whatsapp", under(context.home, "WhatsApp")),
        ("drive", under(context.home, "iCloud Drive")),
        ("keep", under(&documents, "Keep")),
        ("google-drive", under(context.home, "Google Drive")),
    ]
}

fn source_of_path(path: &str, context: SourceContext) -> &'static str {
    folders(context).into_iter().find(|(_, root)| inside(root, path)).map_or("files", |(source, _)| source)
}

fn folder_of(source: &str, context: SourceContext) -> String {
    folders(context).into_iter().find(|(id, _)| *id == source).map_or_else(|| home_text(context), |(_, root)| root)
}

struct RecallFolders {
    roots: Vec<String>,
    excluded: Vec<String>,
}

/// Recall's folders and exclusions, so the keyword search covers what Recall would; home alone without Recall.
fn recall_folders(context: SourceContext) -> RecallFolders {
    if which("recall", context.env).is_none() {
        return RecallFolders { roots: vec![home_text(context)], excluded: Vec::new() };
    }
    let config = json(&run_command("recall", &["config"], context, None).out);
    let strings = |key: &str| -> Vec<String> {
        config
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    };
    let roots = strings("roots");
    RecallFolders { roots: if roots.is_empty() { vec![home_text(context)] } else { roots }, excluded: strings("excluded_folders") }
}

/// A path the files source may read: inside Recall's folders and outside its exclusions.
fn readable_path(path: &str, context: SourceContext) -> bool {
    let RecallFolders { roots, excluded } = recall_folders(context);
    roots.iter().any(|root| inside(root, path)) && !excluded.iter().any(|folder| inside(folder, path) || absolute(folder) == absolute(path))
}

// ── Files: Recall, ripgrep, fd ─────────────────────────────────────────

fn lines_of(text: &str) -> Vec<String> {
    text.split('\n').filter(|line| !line.is_empty()).map(str::to_string).collect()
}

/// Files whose names match, typos forgiven: fd lists the files and fzf ranks
/// their names (Omarchy's `ff`); fd's plain substring match without fzf.
fn match_names(pattern: &str, roots: &[String], names: &[String], context: SourceContext) -> Vec<String> {
    if which("fd", context.env).is_none() {
        return Vec::new();
    }
    let skip = names.iter().flat_map(|name| ["--exclude", name.as_str()]);
    if which("fzf", context.env).is_none() {
        let args: Vec<&str> =
            ["-i", "-F", "--max-results", "5"].into_iter().chain(skip).chain(["--", pattern]).chain(roots.iter().map(String::as_str)).collect();
        return lines_of(&run_command("fd", &args, context, None).out);
    }
    let args: Vec<&str> = ["-t", "f"].into_iter().chain(skip).chain(["."]).chain(roots.iter().map(String::as_str)).collect();
    let files = run_command("fd", &args, context, None);
    let ranked = run_command("fzf", &["--filter", pattern, "--delimiter", "/", "--nth", "-1"], context, Some(&files.out));
    let mut found = lines_of(&ranked.out);
    found.truncate(5);
    found
}

struct KeywordMatch {
    path: String,
    line: Option<u64>,
    text: String,
}

static KEYWORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}][\p{L}\p{N}'.-]*").unwrap());
static GREP_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?):(\d+):(.*)$").unwrap());

/// The two longest of `words`, the earlier first among equals.
fn two_longest<'a>(words: &[&'a str]) -> Vec<&'a str> {
    let mut sorted = words.to_vec();
    sorted.sort_by_key(|word| std::cmp::Reverse(utf16_len(word)));
    sorted.truncate(2);
    sorted
}

/// ripgrep for the words in files and fd for them in names, both shipped with
/// Omarchy, over Recall's folders: exact words and files Recall has not indexed
/// yet, and everything when Recall is missing or failing. A short query is one
/// phrase, a longer one its two longest words.
fn search_keywords(query: &str, context: SourceContext) -> Vec<KeywordMatch> {
    let words: Vec<&str> = KEYWORD.find_iter(query).map(|word| word.as_str()).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let patterns: Vec<String> = if words.len() <= 3 { vec![words.join(" ")] } else { two_longest(&words).into_iter().map(str::to_string).collect() };
    let RecallFolders { roots, excluded } = recall_folders(context);
    let names: Vec<String> = excluded.iter().map(|folder| folder.rsplit('/').next().unwrap_or("").to_string()).collect();
    let (grep, find) = std::thread::scope(|scope| {
        let grep = scope.spawn(|| {
            which("rg", context.env)?;
            let globs: Vec<String> = names.iter().map(|name| format!("!{name}/**")).collect();
            let args: Vec<&str> = ["-i", "-F", "-n", "--max-count", "1", "--max-columns", "300", "--max-filesize", "10M"]
                .into_iter()
                .chain(globs.iter().flat_map(|glob| ["--glob", glob.as_str()]))
                .chain(patterns.iter().flat_map(|pattern| ["-e", pattern.as_str()]))
                .chain(roots.iter().map(String::as_str))
                .collect();
            Some(run_command("rg", &args, context, None).out)
        });
        let find = match_names(&patterns.join(" "), &roots, &names, context);
        (grep.join().ok().flatten().unwrap_or_default(), find)
    });
    let matches = grep.split('\n').filter_map(|line| {
        let at = GREP_LINE.captures(line)?;
        Some(KeywordMatch { path: at[1].to_string(), line: Some(at[2].parse().ok()?), text: one_line(&at[3], 300) })
    });
    matches.chain(find.into_iter().map(|path| KeywordMatch { path, line: None, text: "(name matches)".into() })).collect()
}

/// A WhatsApp hit is titled by its chat, not `_chat.txt`.
fn file_title(path: &str, source: &str) -> String {
    if source == "whatsapp" {
        let chat = basename(dirname(path));
        return chat.strip_prefix("WhatsApp Chat - ").unwrap_or(chat).to_string();
    }
    basename(path).to_string()
}

static PAGE_LOCATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:page|p\.)\s*(\d+)").unwrap());

/// Recall's hits by meaning and keywords, then ripgrep's and fd's that Recall did not return; each hit carries what `read` needs.
pub fn search_files(query: &str, context: SourceContext, limit: usize) -> Vec<FileHit> {
    let (recall, keywords) = std::thread::scope(|scope| {
        let recall = scope.spawn(|| {
            which("recall", context.env)?;
            Some(run_command("recall", &["search", "--limit", &limit.to_string(), "--", query], context, None))
        });
        let keywords = search_keywords(query, context);
        (recall.join().ok().flatten(), keywords)
    });
    let answer = match recall {
        Some(CommandOutput { out, error: None }) => json(&out),
        _ => Value::Null,
    };
    let found = records(answer.get("hits"));
    let mut results: Vec<FileHit> = found
        .iter()
        .map(|hit| {
            let path = js_string(hit.get("path"));
            let location = text_of(hit.get("location"));
            let page = PAGE_LOCATION.captures(&location).and_then(|at| at[1].parse::<u64>().ok());
            let source = source_of_path(&path, context);
            let place = if location.is_empty() { String::new() } else { format!("({location}) ") };
            let item = SourceItem {
                source,
                id: path.clone(),
                title: file_title(&path, source),
                snippet: format!("{place}{}", one_line_of(hit.get("excerpt"), 500)),
                at: hit.get("modified").and_then(Value::as_f64).map(|seconds| seconds * 1000.0),
                path: Some(path),
                page,
                line: None,
            };
            FileHit { item, segment: hit.get("segment_id").and_then(Value::as_f64) }
        })
        .collect();
    let mut seen: std::collections::HashSet<String> = results.iter().map(|hit| hit.item.id.clone()).collect();
    for found_by_word in keywords {
        if seen.contains(&found_by_word.path) || results.len() >= found.len() + 6 {
            continue;
        }
        seen.insert(found_by_word.path.clone());
        let source = source_of_path(&found_by_word.path, context);
        let snippet = match found_by_word.line {
            Some(line) if line > 0 => format!("(line {line}) {}", found_by_word.text),
            _ => found_by_word.text,
        };
        let item = SourceItem {
            source,
            id: found_by_word.path.clone(),
            title: file_title(&found_by_word.path, source),
            snippet,
            at: None,
            path: Some(found_by_word.path),
            page: None,
            line: found_by_word.line,
        };
        results.push(FileHit { item, segment: None });
    }
    results
}

fn is_pdf(path: &str) -> bool {
    path.len() >= 4 && path.is_char_boundary(path.len() - 4) && path[path.len() - 4..].eq_ignore_ascii_case(".pdf")
}

/// Read a file: a PDF's page, the lines around a match, the whole file when
/// it fits `chars`, else Recall's passage, else (a file Recall has not
/// indexed) its start.
pub fn read_file_ref(reference: &SourceRef, context: SourceContext, chars: usize) -> Result<SourceDocument> {
    let path = reference.id.as_str();
    let document = |part: &str, text: String| SourceDocument {
        title: file_title(path, &reference.source),
        path: Some(path.to_string()),
        part: part.to_string(),
        text,
    };
    if is_pdf(path) {
        return pdf_page(path, reference.page.unwrap_or(1), context);
    }
    if let Some(line) = reference.line {
        let bytes = std::fs::read(path)?;
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.split('\n').collect();
        let from = line.saturating_sub(20).min(usize::MAX as u64) as usize;
        let shown: Vec<&str> = lines.iter().skip(from).take(80).copied().collect();
        return Ok(document(&format!("lines {}-{}", from.saturating_add(1), lines.len().min(from.saturating_add(80))), shown.join("\n")));
    }
    let head = file_text(path).ok().flatten();
    if let Some((text, true)) = &head
        && utf16_len(text) <= chars
    {
        return Ok(document("whole", text.clone()));
    }
    if let Some(segment) = reference.segment {
        let CommandOutput { out, error } = run_command("recall", &["text", &number_text(segment)], context, None);
        if let (None, Some(text)) = (error, json(&out).get("text").and_then(Value::as_str)) {
            return Ok(document("passage", text.to_string()));
        }
    }
    match head {
        Some((text, _)) => Ok(document("start", text)),
        None => Err(GhostError::new("source_failed", format!("{path} cannot be read as text."), 422)),
    }
}

// ── Notes and reminders: Ghost's own state, as Markdown ────────────────
//
// `Documents/Notes` and `Documents/Reminders` are where a ghost keeps what it
// must know next time, with or without iCloud: icloud-notes and
// icloud-reminders sync these same folders when the owner connects them, in
// these same formats, and nothing here needs either installed.

static NOTE_HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A---\n[\s\S]*?\n---\n+").unwrap());

/// A note's text without the `apple-note-id` header icloud-notes keeps at its top.
fn note_body(text: &str) -> String {
    NOTE_HEADER.replace(text, "").into_owned()
}

/// Every Markdown file under `root`, hidden names left out.
fn markdown_files(root: &str, found: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let path = join(root, &name);
        if kind.is_dir() {
            markdown_files(&path, found);
        } else if kind.is_file() && name.ends_with(".md") {
            found.push(path);
        }
    }
}

/// When a file last changed, in milliseconds with their fraction, as Node's `mtimeMs`.
fn modified_ms(path: &str) -> std::io::Result<f64> {
    let modified = std::fs::metadata(path)?.modified()?;
    Ok(match modified.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs() as f64 * 1000.0 + f64::from(since.subsec_nanos()) / 1e6,
        Err(before) => -(before.duration().as_secs_f64() * 1000.0),
    })
}

/// The start of a file, enough for a list row's snippet.
fn file_start(path: &str) -> String {
    file_head(path, 1024).map(|(bytes, _)| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default()
}

/// A folder of Markdown notes as a list: one item per file, named by the file, newest change first.
fn markdown_list(id: &'static str, context: SourceContext, limit: usize, cursor: Option<&str>) -> Result<SourcePage> {
    let mut paths = Vec::new();
    markdown_files(&folder_of(id, context), &mut paths);
    let mut items = Vec::new();
    for path in paths {
        let name = basename(&path);
        let title = name.strip_suffix(".md").unwrap_or(name).to_string();
        let body = note_body(&file_start(&path));
        let first = body.split('\n').map(|line| line.trim_start_matches('#').trim()).find(|line| !line.is_empty() && *line != title).unwrap_or("");
        let snippet = one_line(first, 300);
        let at = Some(modified_ms(&path)?);
        items.push(SourceItem { source: id, id: path.clone(), title, snippet, at, path: Some(path), page: None, line: None });
    }
    Ok(time_page(items, limit, cursor))
}

fn reminders_list(context: SourceContext, limit: usize, cursor: Option<&str>) -> Result<SourcePage> {
    let root = folder_of("reminders", context);
    let mut items = Vec::new();
    for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(title) = name.strip_suffix(".md") else { continue };
        let path = join(&root, &name);
        let text = std::fs::read(&path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
        let open: Vec<&str> = text.split('\n').filter_map(|line| line.trim_start().strip_prefix("- [ ]")).collect();
        let first = open.first().map(|line| format!(": {}", one_line(line, 200))).unwrap_or_default();
        items.push(SourceItem {
            source: "reminders",
            id: path.clone(),
            title: title.to_string(),
            snippet: format!("{} open{first}", open.len()),
            at: Some(modified_ms(&path)?),
            path: Some(path),
            page: None,
            line: None,
        });
    }
    Ok(time_page(items, limit, cursor))
}

// ── WhatsApp: wacli's chat folders ─────────────────────────────────────

/// Every chat wacli keeps, as its documented folders
/// (`~/WhatsApp/<account>/WhatsApp Chat - <name>/_chat.txt`). Reading them
/// needs no wacli.
fn whatsapp_chats(context: SourceContext) -> Vec<SourceItem> {
    let root = folder_of("whatsapp", context);
    let mut chats = Vec::new();
    for account in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        if !account.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let account_name = account.file_name().to_string_lossy().into_owned();
        let dir = join(&root, &account_name);
        for chat in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = chat.file_name().to_string_lossy().into_owned();
            if !name.starts_with("WhatsApp Chat - ") {
                continue;
            }
            let path = join(&join(&dir, &name), "_chat.txt");
            let Ok(at) = modified_ms(&path) else { continue };
            chats.push(SourceItem {
                source: "whatsapp",
                id: path.clone(),
                title: file_title(&path, "whatsapp"),
                snippet: account_name.clone(),
                at: Some(at),
                path: Some(path),
                page: None,
                line: None,
            });
        }
    }
    chats
}

// ── Mail: cloudmail ────────────────────────────────────────────────────

fn plain_item(source: &'static str, id: String, title: String, snippet: String, at: Option<f64>) -> SourceItem {
    SourceItem { source, id, title, snippet, at, path: None, page: None, line: None }
}

/// A sender's name, else their address.
fn sender(from: Option<&Value>) -> Option<&Value> {
    present(from.and_then(|from| from.get("name"))).or_else(|| present(from.and_then(|from| from.get("email"))))
}

fn mail_item(thread: &Value) -> SourceItem {
    let subject = one_line_of(thread.get("subject"), 200);
    plain_item(
        "mail",
        js_string(thread.get("id")),
        if subject.is_empty() { "(no subject)".into() } else { subject },
        format!("{}: {}", one_line_of(sender(thread.get("from")), 80), one_line_of(thread.get("snippet"), 300)),
        ms(thread.get("last_at")),
    )
}

fn mail_list(context: SourceContext, limit: usize, cursor: Option<&str>) -> Result<SourcePage> {
    let mut args = vec!["inbox".to_string(), "--quiet".into(), "-n".into(), limit.saturating_add(1).to_string()];
    if let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) {
        args.extend(["--before".to_string(), cursor.to_string()]);
    }
    let data = cli_data("cloudmail", &args, context)?;
    let rows = records(Some(&data));
    let items: Vec<SourceItem> = rows.iter().take(limit).map(|row| mail_item(row)).collect();
    let next = if rows.len() > limit { items.last().and_then(|last| last.at).map(number_text) } else { None };
    Ok(SourcePage { items, next })
}

fn mail_read(context: SourceContext, id: &str) -> Result<SourceDocument> {
    let body = cli_data("cloudmail", &["thread", "read", "--quiet", "--", id], context)?;
    let Some(thread) = body.get("thread").filter(|thread| truthy(Some(thread))) else {
        return Err(GhostError::not_found("No such mail thread."));
    };
    let messages: Vec<String> = records(body.get("messages"))
        .into_iter()
        .map(|message| {
            let from = message.get("from");
            let part = |key: &str| text_of(from.and_then(|from| from.get(key)));
            let date = match ms(message.get("date")) {
                Some(when) if when != 0.0 => format!("\nDate: {}", crate::clock::iso(when as i64)),
                _ => String::new(),
            };
            format!("From: {} <{}>{date}\n\n{}", part("name"), part("email"), text_of(message.get("text")).trim())
        })
        .collect();
    Ok(SourceDocument { title: one_line_of(thread.get("subject"), 200), text: messages.join("\n\n---\n\n"), part: "whole".into(), path: None })
}

static MAIL_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}@.'-]+").unwrap());

/// Cloudmail matches every word, so a long query falls back to its two longest words.
fn mail_search(context: SourceContext, query: &str, limit: usize) -> Result<Vec<SourceItem>> {
    let words: Vec<&str> = MAIL_WORD.find_iter(query).map(|word| word.as_str()).collect();
    let mut attempts = vec![words.clone()];
    if words.len() > 2 {
        attempts.push(two_longest(&words));
    }
    for attempt in attempts {
        if attempt.is_empty() {
            continue;
        }
        let limit = limit.to_string();
        let args: Vec<&str> = ["search", "--quiet", "-n", &limit, "--"].into_iter().chain(attempt).collect();
        let data = cli_data("cloudmail", &args, context)?;
        let threads = records(Some(&data));
        if !threads.is_empty() {
            return Ok(threads.into_iter().map(mail_item).collect());
        }
    }
    Ok(Vec::new())
}

// ── Contacts: cloud-contacts (iCloud and Google), from its last fetch ──

fn contact_item(contact: &Value) -> SourceItem {
    let first = |key: &str| records(contact.get(key)).first().and_then(|row| row.get("value"));
    let detail: Vec<String> = [contact.get("company"), first("phones"), first("emails")]
        .into_iter()
        .filter(|value| truthy(*value))
        .map(|value| one_line_of(value, 80))
        .collect();
    let name = one_line_of(contact.get("name"), 200);
    plain_item("contacts", js_string(contact.get("id")), if name.is_empty() { "(no name)".into() } else { name }, detail.join(" · "), None)
}

fn contacts_read(context: SourceContext, id: &str) -> Result<SourceDocument> {
    let contact = cli_data("cloud-contacts", &["show", "--cached", "--quiet", "--", id], context)?;
    if !contact.is_object() && !contact.is_array() {
        return Err(GhostError::not_found("No such contact."));
    }
    let values = |label: &str, key: &str| -> Vec<String> {
        records(contact.get(key))
            .into_iter()
            .map(|row| {
                let kind = if truthy(row.get("label")) { format!(" ({})", one_line_of(row.get("label"), 40)) } else { String::new() };
                format!("{label}: {}{kind}", one_line_of(row.get("value"), 200))
            })
            .collect()
    };
    let listed = |source: &Value, keys: &[&str]| -> Vec<String> {
        keys.iter().map(|key| source.get(*key)).filter(|value| truthy(*value)).map(|value| one_line_of(value, 120)).collect()
    };
    let mut lines = Vec::new();
    let work = listed(&contact, &["job_title", "company"]).join(", ");
    if !work.is_empty() {
        lines.push(work);
    }
    lines.extend(values("Phone", "phones"));
    lines.extend(values("Email", "emails"));
    lines.extend(values("Link", "urls"));
    for address in records(contact.get("addresses")) {
        lines.push(format!("Address: {}", listed(address, &["street", "city", "state", "postal_code", "country"]).join(", ")));
    }
    if truthy(contact.get("birthday")) {
        lines.push(format!("Birthday: {}", one_line_of(contact.get("birthday"), 40)));
    }
    if truthy(contact.get("notes")) {
        lines.push(format!("\n{}", js_string(contact.get("notes")).trim()));
    }
    lines.push(format!("\nIn {}.", one_line_of(present(contact.get("account")).or(contact.get("provider")), 80)));
    Ok(SourceDocument { title: one_line_of(contact.get("name"), 200), text: lines.join("\n"), part: "whole".into(), path: None })
}

// ── Calendar: cloud-calendar's agenda ──────────────────────────────────

/// Days per calendar page, from today forward; the cursor is the next page's first day.
const CALENDAR_DAYS: i64 = 14;

fn calendar_list(context: SourceContext, limit: usize, cursor: Option<&str>) -> Result<SourcePage> {
    let from = cursor.map_or_else(|| crate::clock::iso_day(crate::clock::now_ms()), str::to_string);
    let day = from.as_bytes();
    if day.len() != 10 || !day.iter().enumerate().all(|(at, byte)| if at == 4 || at == 7 { *byte == b'-' } else { byte.is_ascii_digit() }) {
        return Err(GhostError::invalid("A calendar cursor is a YYYY-MM-DD day."));
    }
    let data = cli_data("cloud-calendar", &["agenda", "--from", &from, "--days", &CALENDAR_DAYS.to_string(), "--quiet"], context)?;
    let start =
        crate::clock::parse_iso(&format!("{from}T00:00:00Z")).ok_or_else(|| GhostError::internal(format!("{from} is not a day of the calendar")))?;
    let next = crate::clock::iso_day(start + CALENDAR_DAYS * 86_400_000);
    let items = records(Some(&data))
        .into_iter()
        .take(limit)
        .map(|event| {
            let title = one_line_of(event.get("title"), 200);
            let when = if truthy(event.get("all_day")) {
                "all day".to_string()
            } else {
                format!("{} – {}", text_of(event.get("start")), text_of(event.get("end")))
            };
            plain_item(
                "calendar",
                js_string(event.get("id")),
                if title.is_empty() { "(no title)".into() } else { title },
                format!("{when} · {}", one_line_of(event.get("calendar"), 80)),
                ms(event.get("start")),
            )
        })
        .collect();
    Ok(SourcePage { items, next: Some(next) })
}

// ── Photos: icloud-photos' catalog ─────────────────────────────────────

/// Both list newest first with no offset, so a page is cut from one long listing.
const PHOTOS_LISTED: usize = 5_000;

/// `4032×3024`, from a catalog row.
fn dimensions(row: &Value) -> String {
    format!("{}×{}", number_text(number_of(row.get("width"))), number_text(number_of(row.get("height"))))
}

fn photos_list(id: &'static str, command: &str, context: SourceContext, limit: usize, cursor: Option<&str>) -> Result<SourcePage> {
    let data = cli_data(command, &["list", "--limit", &PHOTOS_LISTED.to_string(), "--quiet"], context)?;
    let items = records(Some(&data))
        .into_iter()
        .map(|row| SourceItem {
            source: id,
            id: js_string(row.get("id")),
            title: one_line_of(row.get("filename"), 200),
            snippet: format!("{} · {}", present(row.get("kind")).map_or_else(|| "photo".to_string(), |kind| js_string(Some(kind))), dimensions(row)),
            at: ms(row.get("created")).or_else(|| row.get("created_unix").and_then(Value::as_f64).map(|seconds| seconds * 1000.0)),
            path: row.get("local_path").and_then(Value::as_str).map(str::to_string),
            page: None,
            line: None,
        })
        .collect();
    Ok(time_page(items, limit, cursor))
}

fn photos_read(command: &str, context: SourceContext, id: &str) -> Result<SourceDocument> {
    let info = cli_data(command, &["info", "--quiet", "--", id], context)?;
    if !info.is_object() && !info.is_array() {
        return Err(GhostError::not_found("No such photo."));
    }
    let albums: Vec<String> = info
        .get("albums")
        .and_then(Value::as_array)
        .map(|albums| {
            albums.iter().map(|album| one_line_of(present(album.get("name")).or(Some(album)), 80)).filter(|name| !name.is_empty()).collect()
        })
        .unwrap_or_default();
    let size = match info.get("size").and_then(Value::as_f64) {
        Some(bytes) if bytes > 0.0 => format!(", {:.1} MB", bytes / 1e6),
        _ => String::new(),
    };
    let local = info.get("local_path").and_then(Value::as_str);
    let mut lines = vec![
        format!("Taken: {}", one_line_of(info.get("created"), 40)),
        format!("Kind: {}, {}{size}", one_line_of(present(info.get("kind")).or(Some(&Value::from("photo"))), 20), dimensions(&info)),
    ];
    if !albums.is_empty() {
        lines.push(format!("Albums: {}", albums.join(", ")));
    }
    if let Some(place) = info.get("place").and_then(Value::as_str).filter(|place| !place.is_empty()) {
        lines.push(format!("Place: {}", one_line(place, 120)));
    }
    lines.push(local.map_or_else(|| "Not downloaded to this computer.".to_string(), |path| format!("File: {path}")));
    Ok(SourceDocument {
        title: one_line_of(info.get("filename"), 200),
        text: lines.join("\n"),
        part: "whole".into(),
        path: local.map(str::to_string),
    })
}

/// The product's thumbnail, which it fetches into its cache on first use.
fn photos_picture(command: &str, context: SourceContext, item: &str) -> Result<String> {
    let found = cli_data(command, &["thumb", "--quiet", "--", item], context)?;
    found.get("path").and_then(Value::as_str).map(str::to_string).ok_or_else(|| GhostError::not_found("No such photo."))
}

// ── Lastbook: its library's search index, read-only ────────────────────

fn lastbook_db(context: SourceContext) -> String {
    xdg::base_dir(context.env, xdg::Base::Data, context.home).join("Lastbook/LastbookData/library-data/search.sqlite").to_string_lossy().into_owned()
}

static FTS_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());

/// FTS5 words, each quoted so punctuation cannot become query syntax.
fn fts_words(query: &str) -> Vec<String> {
    FTS_WORD.find_iter(&query.to_lowercase()).take(12).map(|word| format!("\"{}\"", word.as_str())).collect()
}

/// The index's best pages for one FTS5 expression, through the `sqlite3` command, which opens it read-only.
fn lastbook_rows(db: &str, expression: &str, limit: usize, context: SourceContext) -> Result<Vec<Value>> {
    // The expression is SQL text here, not a bound value: its words are letters and digits in double quotes, and a `'` is doubled.
    let sql = format!(
        "SELECT title, page, path, snippet(pages, 6, '', '', '…', 40) AS excerpt FROM pages WHERE pages MATCH '{}' ORDER BY bm25(pages, 0, 6, 1, 1, 0, 0, 1) LIMIT {limit}",
        expression.replace('\'', "''")
    );
    let CommandOutput { out, error } = run_command("sqlite3", &["-readonly", "-json", db, &sql], context, None);
    if let Some(error) = error {
        return Err(GhostError::new("source_failed", format!("sqlite3 failed: {}", one_line(&error, 300)), 502));
    }
    // No rows prints nothing, not `[]`.
    Ok(match json(&out) {
        Value::Array(rows) => rows,
        _ => Vec::new(),
    })
}

fn lastbook_search(context: SourceContext, query: &str, limit: usize) -> Result<Vec<SourceItem>> {
    let db = lastbook_db(context);
    let words = fts_words(query);
    if words.is_empty() || !Path::new(&db).exists() {
        return Ok(Vec::new());
    }
    if which("sqlite3", context.env).is_none() {
        return Err(GhostError::new("source_failed", "Searching Lastbook needs the sqlite3 command, which is not installed.", 502));
    }
    let mut rows = lastbook_rows(&db, &words.join(" "), limit, context)?;
    if rows.is_empty() && words.len() > 1 {
        rows = lastbook_rows(&db, &words.join(" OR "), limit, context)?;
    }
    let library = dirname(&db);
    Ok(rows
        .iter()
        .map(|row| {
            let relative = text_of(row.get("path"));
            let file = xdg::resolve(Path::new(library), Path::new(relative.trim_start_matches('/'))).to_string_lossy().into_owned();
            SourceItem {
                source: "lastbook",
                id: file.clone(),
                title: format!("{}, page {}", js_string(row.get("title")), js_string(row.get("page"))),
                snippet: one_line_of(row.get("excerpt"), 500),
                at: None,
                path: Some(file),
                page: row.get("page").and_then(Value::as_u64),
                line: None,
            }
        })
        .collect())
}

// ── The registry ───────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Files,
    /// Files in one product folder, searched through the shared file search.
    Folder,
    Mail,
    Contacts,
    Calendar,
    /// A photo library behind a catalog CLI: icloud-photos, and google-photos,
    /// which prints the same `list` and `info`. `thumb` says the product has
    /// a command that fetches an item's small picture.
    Photos {
        command: &'static str,
        thumb: bool,
    },
    Lastbook,
}

struct Source {
    id: &'static str,
    label: &'static str,
    kind: Kind,
}

// Google's, as folders: google-keep keeps `Documents/Keep` in sync (a note per
// Markdown file, archived ones under `Archive/`), and `rclone bisync` keeps
// `~/Google Drive`. Ghost only reads both; a Keep note is edited as a file.
// google-photos keeps originals only: no thumbnails, so its items are a list, not a grid.
const SOURCES: [Source; 13] = [
    Source { id: "files", label: "Files", kind: Kind::Files },
    Source { id: "notes", label: "Notes", kind: Kind::Folder },
    Source { id: "reminders", label: "Reminders", kind: Kind::Folder },
    Source { id: "keep", label: "Google Keep", kind: Kind::Folder },
    Source { id: "whatsapp", label: "WhatsApp", kind: Kind::Folder },
    Source { id: "drive", label: "iCloud Drive", kind: Kind::Folder },
    Source { id: "google-drive", label: "Google Drive", kind: Kind::Folder },
    Source { id: "mail", label: "Mail", kind: Kind::Mail },
    Source { id: "contacts", label: "Contacts", kind: Kind::Contacts },
    Source { id: "calendar", label: "Calendar", kind: Kind::Calendar },
    Source { id: "photos", label: "Photos", kind: Kind::Photos { command: "icloud-photos", thumb: true } },
    Source { id: "google-photos", label: "Google Photos", kind: Kind::Photos { command: "google-photos", thumb: false } },
    Source { id: "lastbook", label: "Lastbook", kind: Kind::Lastbook },
];

impl Source {
    fn available(&self, context: SourceContext) -> bool {
        let installed = |command: &str| which(command, context.env).is_some();
        match self.kind {
            Kind::Files => true,
            // Notes and reminders are Ghost's own folders: sources even while empty.
            Kind::Folder => matches!(self.id, "notes" | "reminders") || Path::new(&folder_of(self.id, context)).exists(),
            Kind::Mail => installed("cloudmail"),
            Kind::Contacts => installed("cloud-contacts"),
            Kind::Calendar => installed("cloud-calendar"),
            Kind::Photos { command, .. } => installed(command),
            Kind::Lastbook => Path::new(&lastbook_db(context)).exists(),
        }
    }

    fn lists(&self) -> bool {
        match self.kind {
            Kind::Files | Kind::Lastbook => false,
            Kind::Folder => matches!(self.id, "notes" | "reminders" | "keep" | "whatsapp"),
            _ => true,
        }
    }

    fn reads(&self) -> bool {
        self.kind != Kind::Calendar
    }

    fn searches(&self) -> bool {
        matches!(self.kind, Kind::Files | Kind::Folder | Kind::Mail | Kind::Contacts | Kind::Lastbook)
    }

    fn pictures(&self) -> bool {
        matches!(self.kind, Kind::Photos { thumb: true, .. })
    }

    fn list(&self, context: SourceContext, limit: usize, cursor: Option<&str>) -> Result<SourcePage> {
        match (self.kind, self.id) {
            (Kind::Folder, "reminders") => reminders_list(context, limit, cursor),
            (Kind::Folder, "whatsapp") => Ok(time_page(whatsapp_chats(context), limit, cursor)),
            (Kind::Folder, _) => markdown_list(self.id, context, limit, cursor),
            (Kind::Mail, _) => mail_list(context, limit, cursor),
            (Kind::Contacts, _) => {
                let data = cli_data("cloud-contacts", &["list", "--cached", "--quiet"], context)?;
                Ok(offset_page(records(Some(&data)).into_iter().map(contact_item).collect(), limit, cursor))
            }
            (Kind::Calendar, _) => calendar_list(context, limit, cursor),
            (Kind::Photos { command, .. }, _) => photos_list(self.id, command, context, limit, cursor),
            (Kind::Files | Kind::Lastbook, _) => Ok(SourcePage { items: Vec::new(), next: None }),
        }
    }

    fn read(&self, context: SourceContext, reference: &SourceRef) -> Result<SourceDocument> {
        let id = reference.id.as_str();
        match (self.kind, self.id) {
            (Kind::Files, _) => {
                if !readable_path(id, context) {
                    return Err(GhostError::not_found("That file is outside the folders Ghost searches."));
                }
                read_file_ref(reference, context, READ_CHARS)
            }
            (Kind::Folder, "notes") => {
                if !inside(&folder_of("notes", context), id) {
                    return Err(GhostError::not_found("That is not in Notes."));
                }
                let mut document = read_file_ref(reference, context, READ_CHARS)?;
                if document.part == "whole" || document.part == "start" {
                    document.text = note_body(&document.text);
                }
                Ok(document)
            }
            (Kind::Folder, "whatsapp") => {
                if !inside(&folder_of("whatsapp", context), id) || !id.ends_with("_chat.txt") {
                    return Err(GhostError::not_found("No such chat."));
                }
                if reference.line.is_some() || reference.segment.is_some() {
                    return read_file_ref(reference, context, READ_CHARS);
                }
                Ok(SourceDocument {
                    title: file_title(id, "whatsapp"),
                    path: Some(id.to_string()),
                    part: "latest".into(),
                    text: file_tail(id, READ_CHARS)?,
                })
            }
            (Kind::Folder, _) => {
                if !inside(&folder_of(self.id, context), id) {
                    return Err(GhostError::not_found(format!("That is not in {}.", self.label)));
                }
                read_file_ref(reference, context, READ_CHARS)
            }
            (Kind::Mail, _) => mail_read(context, id),
            (Kind::Contacts, _) => contacts_read(context, id),
            (Kind::Photos { command, .. }, _) => photos_read(command, context, id),
            (Kind::Lastbook, _) => {
                if !inside(dirname(&lastbook_db(context)), id) {
                    return Err(GhostError::not_found("That is not in the Lastbook library."));
                }
                pdf_page(id, reference.page.unwrap_or(1), context)
            }
            (Kind::Calendar, _) => Err(GhostError::new("not_readable", format!("{} items are read from its list.", self.label), 405)),
        }
    }

    fn search(&self, context: SourceContext, query: &str, limit: usize) -> Result<Vec<SourceItem>> {
        match self.kind {
            Kind::Files => Ok(search_files(query, context, limit).into_iter().map(|hit| hit.item).collect()),
            Kind::Folder => {
                let hits = search_files(query, context, limit.saturating_mul(3));
                Ok(hits.into_iter().map(|hit| hit.item).filter(|item| item.source == self.id).take(limit).collect())
            }
            Kind::Mail => mail_search(context, query, limit),
            Kind::Contacts => {
                if query.split(char::is_whitespace).filter(|word| !word.is_empty()).count() > 3 {
                    return Ok(Vec::new());
                }
                let data = cli_data("cloud-contacts", &["list", "--cached", "--quiet", "--", query], context)?;
                Ok(records(Some(&data)).into_iter().take(limit).map(contact_item).collect())
            }
            Kind::Lastbook => lastbook_search(context, query, limit),
            Kind::Calendar | Kind::Photos { .. } => Ok(Vec::new()),
        }
    }
}

/// Every source, with what it can do and whether its product is set up here: the array of `{ "sources": [...] }`.
pub fn list_sources(context: SourceContext) -> Value {
    SOURCES
        .iter()
        .map(|source| {
            let mut map = Map::new();
            map.insert("id".into(), source.id.into());
            map.insert("label".into(), source.label.into());
            map.insert("available".into(), source.available(context).into());
            map.insert("list".into(), source.lists().into());
            map.insert("read".into(), source.reads().into());
            map.insert("search".into(), source.searches().into());
            // Its items have pictures, so a client shows them as a grid.
            map.insert("pictures".into(), source.pictures().into());
            Value::Object(map)
        })
        .collect()
}

fn source(id: &str, context: SourceContext) -> Result<&'static Source> {
    let found = SOURCES.iter().find(|source| source.id == id).ok_or_else(|| GhostError::not_found(format!("There is no source \"{id}\".")))?;
    if !found.available(context) {
        return Err(GhostError::new("source_unavailable", format!("{} is not set up on this computer.", found.label), 409));
    }
    Ok(found)
}

/// One page of a source's list.
pub fn list_source_page(id: &str, context: SourceContext, limit: usize, cursor: Option<&str>) -> Result<SourcePage> {
    let found = source(id, context)?;
    if !found.lists() {
        return Err(GhostError::new("not_listable", format!("{} has no list; search it instead.", found.label), 405));
    }
    found.list(context, limit, cursor)
}

/// One page of a source's list, as `{ items, next }`.
pub fn list_source(id: &str, context: SourceContext, limit: usize, cursor: Option<&str>) -> Result<Value> {
    list_source_page(id, context, limit, cursor).map(|page| page.to_json())
}

/// One item read, cut at the read limit.
pub fn read_source_ref(reference: &SourceRef, context: SourceContext) -> Result<SourceDocument> {
    let found = source(&reference.source, context)?;
    if !found.reads() {
        return Err(GhostError::new("not_readable", format!("{} items are read from its list.", found.label), 405));
    }
    let mut document = found.read(context, reference)?;
    let kept = cut(&document.text, READ_CHARS).len();
    document.text.truncate(kept);
    Ok(document)
}

/// One item read, as `{ title, text, part, path? }`.
pub fn read_source(source: &str, id: &str, page: Option<u64>, line: Option<u64>, context: SourceContext) -> Result<Value> {
    read_source_ref(&SourceRef { source: source.to_string(), id: id.to_string(), page, line, segment: None }, context)
        .map(|document| document.to_json())
}

/// One item's small picture, with its content type. Only bytes that are a JPEG or a PNG leave, whatever file the product named.
pub fn picture_of(source_id: &str, item: &str, context: SourceContext) -> Result<(&'static str, Vec<u8>)> {
    let found = source(source_id, context)?;
    let Kind::Photos { command, thumb: true } = found.kind else {
        return Err(GhostError::new("no_pictures", format!("{} items have no pictures.", found.label), 405));
    };
    let path = photos_picture(command, context, item)?;
    let missing = || GhostError::not_found("That item has no picture.");
    if !std::fs::metadata(&path).is_ok_and(|info| info.is_file() && info.len() <= PICTURE_BYTES) {
        return Err(missing());
    }
    let bytes = std::fs::read(&path)?;
    let kind = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        "image/png"
    } else {
        return Err(missing());
    };
    Ok((kind, bytes))
}

/// What a search found, and each source that failed with what it said.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub items: Vec<SourceItem>,
    pub failed: Vec<(&'static str, String)>,
}

impl SearchResult {
    pub fn to_json(&self) -> Value {
        let failed: Value = self
            .failed
            .iter()
            .map(|(source, message)| {
                let mut map = Map::new();
                map.insert("source".into(), (*source).into());
                map.insert("message".into(), message.as_str().into());
                Value::Object(map)
            })
            .collect();
        let mut map = Map::new();
        map.insert("items".into(), self.items.iter().map(SourceItem::to_json).collect());
        map.insert("failed".into(), failed);
        Value::Object(map)
    }
}

/// Search the named sources, or every searchable one that is set up, all at
/// once; a failing source is named, not fatal.
pub fn search_all(query: &str, context: SourceContext, sources: Option<&[String]>, limit: usize) -> Result<SearchResult> {
    let query = query.trim();
    if query.is_empty() {
        return Err(GhostError::invalid("A search needs a query."));
    }
    let wanted: Vec<&'static Source> = match sources {
        Some(ids) => ids.iter().map(|id| source(id, context)).collect::<Result<_>>()?,
        None => ["files", "lastbook", "mail", "contacts"]
            .iter()
            .filter_map(|id| SOURCES.iter().find(|source| source.id == *id))
            .filter(|source| source.available(context))
            .collect(),
    };
    let answers: Vec<Result<Vec<SourceItem>>> = std::thread::scope(|scope| {
        let running: Vec<_> = wanted.iter().map(|found| scope.spawn(move || found.search(context, query, limit))).collect();
        running.into_iter().map(|search| search.join().unwrap_or_else(|_| Err(GhostError::internal("the search stopped unexpectedly")))).collect()
    });
    let mut result = SearchResult { items: Vec::new(), failed: Vec::new() };
    for (found, answer) in wanted.iter().zip(answers) {
        match answer {
            Ok(items) => result.items.extend(items),
            Err(error) => result.failed.push((found.id, error.message)),
        }
    }
    Ok(result)
}

/// A search, as `{ items, failed }`.
pub fn search_sources(query: &str, context: SourceContext, sources: Option<&[String]>, limit: usize) -> Result<Value> {
    search_all(query, context, sources, limit).map(|result| result.to_json())
}

/// A scratch owner for tests: a home and stand-in product commands, so no
/// test reads the owner's real data or reaches a network.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub struct Owner {
        pub home: PathBuf,
        pub bin: PathBuf,
        pub env: Env,
        pub abort: Abort,
    }

    impl Owner {
        /// `tools` are shell script bodies by command name. Only they, and the
        /// search tools Omarchy ships, are on `PATH`, so a product CLI on the
        /// test machine never stands in for a missing one.
        pub fn new(tools: &[(&str, &str)]) -> Self {
            let root = std::env::temp_dir().join(format!("ghost-sources-{}", crate::random::uuid()));
            let (home, bin) = (root.join("home"), root.join("bin"));
            std::fs::create_dir_all(&home).unwrap();
            std::fs::create_dir_all(&bin).unwrap();
            let owner = Self { env: Env::new(), home, bin, abort: Abort::new() };
            for name in ["rg", "fd", "fzf"] {
                owner.link(name);
            }
            for (name, body) in tools {
                owner.tool(name, body);
            }
            let home = owner.home.clone();
            owner.at_home(&home)
        }

        /// The same commands over another home.
        pub fn at_home(mut self, home: &Path) -> Self {
            self.env = Env::from([
                ("HOME".to_string(), home.to_string_lossy().into_owned()),
                ("XDG_DOCUMENTS_DIR".to_string(), home.join("Documents").to_string_lossy().into_owned()),
                ("PATH".to_string(), self.bin.to_string_lossy().into_owned()),
            ]);
            self.home = home.to_path_buf();
            self
        }

        /// Put a real tool from `/usr/bin` on the scratch `PATH`; false when this machine lacks it.
        pub fn link(&self, name: &str) -> bool {
            let real = Path::new("/usr/bin").join(name);
            real.exists() && (self.bin.join(name).exists() || std::os::unix::fs::symlink(real, self.bin.join(name)).is_ok())
        }

        pub fn has(&self, name: &str) -> bool {
            self.bin.join(name).exists()
        }

        /// Write a stand-in command. A child shell writes it, so no thread of
        /// this process ever holds the script open for writing while another
        /// test starts a command ("text file busy").
        pub fn tool(&self, name: &str, body: &str) {
            let path = self.bin.join(name);
            let mut writer = Command::new("/bin/sh")
                .args(["-c", "/bin/cat > \"$1\" && /bin/chmod 755 \"$1\"", "sh"])
                .arg(&path)
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            writer.stdin.take().unwrap().write_all(format!("#!/bin/sh\n{body}\n").as_bytes()).unwrap();
            assert!(writer.wait().unwrap().success());
        }

        pub fn context(&self) -> SourceContext<'_> {
            SourceContext { home: &self.home, env: &self.env, abort: &self.abort }
        }

        /// A path under the home, as text.
        pub fn path(&self, relative: &str) -> String {
            self.home.join(relative).to_string_lossy().into_owned()
        }

        /// Write a file under the home, making its folders.
        pub fn write(&self, relative: &str, contents: impl AsRef<[u8]>) -> String {
            let path = self.home.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for Owner {
        fn drop(&mut self) {
            if let Some(root) = self.bin.parent() {
                let _ = std::fs::remove_dir_all(root);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::Owner;
    use super::*;
    use serde_json::json as value;
    use std::time::{Instant, SystemTime};

    fn at(iso: &str) -> i64 {
        crate::clock::parse_iso(iso).unwrap()
    }

    fn set_modified(path: &str, ms: i64) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(ms as u64)).unwrap();
    }

    fn failure<T: std::fmt::Debug>(result: Result<T>) -> (String, u16) {
        let error = result.unwrap_err();
        (error.code, error.status)
    }

    fn names(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn items(value: &Value) -> &Vec<Value> {
        value["items"].as_array().unwrap()
    }

    #[test]
    fn labels_a_file_hit_with_the_source_whose_folder_holds_it() {
        let files = Owner::new(&[]);
        if !files.has("rg") {
            println!("skipped: ripgrep (/usr/bin/rg) is not installed");
            return;
        }
        let chat = files.write("WhatsApp/+1/WhatsApp Chat - Sara/_chat.txt", "the boat leaves at nine\n");
        let note = files.write("Documents/Notes/boat.md", "the boat leaves at nine\n");
        files.write("Downloads/boat.txt", "the boat leaves at nine\n");
        let home = files.path("");
        let recall = format!(
            "case \"$1\" in\n  search) printf '%s' '{{\"hits\":[{{\"path\":\"{note}\",\"excerpt\":\"boat\",\"modified\":1700000000}},{{\"path\":\"{chat}\",\"excerpt\":\"boat\"}}]}}' ;;\n  config) printf '%s' '{{\"roots\":[\"{home}\"]}}' ;;\nesac"
        );
        let owner = Owner::new(&[("recall", &recall)]).at_home(&files.home);

        let found = search_sources("boat", owner.context(), Some(&names(&["files"])), DEFAULT_SEARCH_LIMIT).unwrap();
        let labelled: Vec<(&str, &str)> =
            items(&found).iter().map(|item| (item["source"].as_str().unwrap(), item["title"].as_str().unwrap())).collect();
        for expected in [("notes", "boat.md"), ("whatsapp", "Sara"), ("files", "boat.txt")] {
            assert!(labelled.contains(&expected), "{expected:?} in {labelled:?}");
        }
        let from_notes = items(&found).iter().find(|item| item["source"] == "notes").unwrap();
        assert_eq!(from_notes["at"], value!(1_700_000_000_000_i64));
        assert_eq!(from_notes["path"], value!(note));
        // One source's search is the shared index cut to that source's folder.
        let chats = search_sources("boat", owner.context(), Some(&names(&["whatsapp"])), DEFAULT_SEARCH_LIMIT).unwrap();
        assert_eq!(items(&chats).iter().map(|item| item["title"].as_str().unwrap()).collect::<Vec<_>>(), ["Sara"]);
    }

    #[test]
    fn reads_only_files_inside_the_folders_ghost_searches() {
        let owner =
            Owner::new(&[("recall", r#"printf '%s' '{"roots":["'"$HOME"'/Documents"],"excluded_folders":["'"$HOME"'/Documents/private"]}'"#)]);
        let plan = owner.write("Documents/plan.md", "the plan");
        let key = owner.write("Documents/private/key.md", "secret");
        let outside = owner.write("outside.md", "outside");
        let read = read_source("files", &plan, None, None, owner.context()).unwrap();
        assert_eq!(read, value!({ "title": "plan.md", "text": "the plan", "part": "whole", "path": plan }));
        for path in [outside, key, owner.path("Documents/../outside.md"), owner.path("Documents/private"), owner.path("Documents")] {
            assert_eq!(failure(read_source("files", &path, None, None, owner.context())), ("not_found".into(), 404), "{path}");
        }
    }

    #[test]
    fn pages_mail_with_cloudmails_own_before_cursor() {
        let thread = |id: &str, last: u32| format!(r#"{{"id":"{id}","subject":"s{id}","snippet":"x","from":{{"name":"A"}},"last_at":{last}}}"#);
        let cloudmail = format!(
            "case \"$*\" in\n  *--before\\ 2000*) printf '[%s]' '{c}' ;;\n  inbox*) printf '[%s,%s,%s]' '{a}' '{b}' '{c}' ;;\nesac",
            a = thread("a", 3000),
            b = thread("b", 2000),
            c = thread("c", 1000)
        );
        let owner = Owner::new(&[("cloudmail", &cloudmail)]);
        let first = list_source("mail", owner.context(), 2, None).unwrap();
        assert_eq!(items(&first).iter().map(|item| item["id"].as_str().unwrap()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(first["next"], "2000");
        let second = list_source("mail", owner.context(), 2, first["next"].as_str()).unwrap();
        assert_eq!(second, value!({ "items": [{ "source": "mail", "id": "c", "title": "sc", "snippet": "A: x", "at": 1000 }], "next": null }));
    }

    #[test]
    fn lists_notes_newest_first_across_folders_and_reminders_as_one_item_per_list_with_no_product_installed() {
        let owner = Owner::new(&[]);
        let context = owner.context();
        // Nothing exists yet: Ghost's own folders are still sources, just empty.
        let summary = list_sources(context);
        for id in ["notes", "reminders"] {
            assert_eq!(summary.as_array().unwrap().iter().find(|row| row["id"] == id).unwrap()["available"], true);
            assert_eq!(list_source(id, context, 10, None).unwrap(), value!({ "items": [], "next": null }));
        }

        let old = owner.write("Documents/Notes/Old.md", "# Old\n\nfirst line\n");
        // As icloud-notes leaves a synced note: its id header on top.
        let fresh = owner.write("Documents/Notes/Trips/New.md", "---\napple-note-id: 1234\n---\n\n# New\n\nThe boat leaves at nine.\n");
        owner.write("Documents/Notes/Trips/.icloud-notes/state.md", "not a note");
        set_modified(&old, at("2026-01-01"));
        set_modified(&fresh, at("2026-06-01"));
        owner.write("Documents/Reminders/Groceries.md", "- [ ] Milk\n- [x] Eggs\n- [ ] Bread\n");

        let listed = list_source("notes", context, 10, None).unwrap();
        let rows: Vec<(&str, &str)> =
            items(&listed).iter().map(|item| (item["title"].as_str().unwrap(), item["snippet"].as_str().unwrap())).collect();
        assert_eq!(rows, [("New", "The boat leaves at nine."), ("Old", "first line")]);
        assert_eq!(items(&listed)[0]["at"], value!(at("2026-06-01")));
        // The cursor is the last row's time: the next page starts before it.
        let first = list_source("notes", context, 1, None).unwrap();
        assert_eq!(first["next"], value!(at("2026-06-01").to_string()));
        let second = list_source("notes", context, 1, first["next"].as_str()).unwrap();
        assert_eq!((items(&second)[0]["title"].as_str(), &second["next"]), (Some("Old"), &Value::Null));

        let read = read_source("notes", &fresh, None, None, context).unwrap();
        assert_eq!((read["text"].as_str(), read["part"].as_str()), (Some("# New\n\nThe boat leaves at nine.\n"), Some("whole")));
        let chat = owner.write("WhatsApp/+1/WhatsApp Chat - Sara/_chat.txt", "[1/1/26, 09:00:00] Sara: first\n[1/2/26, 10:00:00] Sara: latest\n");
        let chats = list_source("whatsapp", context, 10, None).unwrap();
        assert_eq!(items(&chats).len(), 1);
        assert_eq!(
            (&items(&chats)[0]["id"], &items(&chats)[0]["title"], &items(&chats)[0]["snippet"]),
            (&value!(chat), &value!("Sara"), &value!("+1"))
        );
        let latest = read_source("whatsapp", &chat, None, None, context).unwrap();
        assert_eq!(latest["part"], "latest");
        assert!(latest["text"].as_str().unwrap().contains("Sara: latest"));
        // A line from a search hit reads the lines around it instead.
        assert_eq!(read_source("whatsapp", &chat, None, Some(2), context).unwrap()["part"], "lines 1-3");
        assert_eq!(failure(read_source("whatsapp", &owner.path("Documents/x.md"), None, None, context)).0, "not_found");
        let reminders = list_source("reminders", context, 10, None).unwrap();
        assert_eq!(items(&reminders).len(), 1);
        let row = &items(&reminders)[0];
        assert_eq!((&row["source"], &row["title"], &row["snippet"]), (&value!("reminders"), &value!("Groceries"), &value!("2 open: Milk")));
    }

    #[test]
    fn says_what_a_source_cannot_do_and_which_sources_are_set_up() {
        let owner = Owner::new(&[("cloudmail", "printf '[]'")]);
        let context = owner.context();
        let summary = list_sources(context);
        let rows = summary.as_array().unwrap();
        assert_eq!(rows.iter().map(|row| row["id"].as_str().unwrap()).collect::<Vec<_>>(), SOURCE_IDS);
        assert_eq!(
            rows.iter().find(|row| row["id"] == "mail").unwrap(),
            &value!({ "id": "mail", "label": "Mail", "available": true, "list": true, "read": true, "search": true, "pictures": false })
        );
        assert_eq!(rows.iter().find(|row| row["id"] == "photos").unwrap()["available"], false);
        assert_eq!(failure(list_source("photos", context, 10, None)), ("source_unavailable".into(), 409));
        assert_eq!(failure(list_source("files", context, 10, None)), ("not_listable".into(), 405));
        let unknown = list_source("nope", context, 10, None).unwrap_err();
        assert_eq!((unknown.code.as_str(), unknown.status, unknown.message.as_str()), ("not_found", 404, "There is no source \"nope\"."));
        assert_eq!(failure(search_sources("  ", context, None, 8)), ("invalid_request".into(), 400));
        assert_eq!(failure(search_sources("x", context, Some(&names(&["photos"])), 8)), ("source_unavailable".into(), 409));
    }

    #[test]
    fn what_each_source_can_do_is_the_contracts_table() {
        let can = |test: fn(&Source) -> bool| -> Vec<&str> { SOURCES.iter().filter(|source| test(source)).map(|source| source.id).collect() };
        assert_eq!(can(Source::lists), ["notes", "reminders", "keep", "whatsapp", "mail", "contacts", "calendar", "photos", "google-photos"]);
        assert_eq!(SOURCES.iter().filter(|source| !source.reads()).map(|source| source.id).collect::<Vec<_>>(), ["calendar"]);
        assert_eq!(
            can(Source::searches),
            ["files", "notes", "reminders", "keep", "whatsapp", "drive", "google-drive", "mail", "contacts", "lastbook"]
        );
        assert_eq!(can(Source::pictures), ["photos"]);
    }

    #[test]
    fn hands_a_product_a_query_or_an_id_as_a_value_never_as_an_option() {
        // Each stand-in answers only when what follows `--` is the value alone.
        let cloudmail = r#"case "$*" in
  "search --quiet -n 8 -- -n 9999") printf '[{"id":"t1","subject":"found","snippet":"x","from":{"name":"A"},"last_at":1}]' ;;
  "thread read --quiet -- --all") printf '{"thread":{"subject":"read"},"messages":[{"from":{"name":"A","email":"a@x"},"date":"2026-11-25T08:21:20Z","text":" hi "}]}' ;;
  *) echo "taken as an option: $*" >&2; exit 2 ;;
esac"#;
        let photos = r#"[ "$*" = "info --quiet -- --data-dir=/x" ] && printf '{"filename":"a.jpg","created":"2026-11-13T06:40:22Z","kind":"photo","width":4032,"height":3024,"size":2100000,"albums":[{"id":"a1","name":"Trip"}]}' || exit 2"#;
        let owner = Owner::new(&[("cloudmail", cloudmail), ("icloud-photos", photos)]);
        let context = owner.context();
        let found = search_sources("-n 9999", context, Some(&names(&["mail"])), 8).unwrap();
        assert_eq!(found, value!({ "items": [{ "source": "mail", "id": "t1", "title": "found", "snippet": "A: x", "at": 1 }], "failed": [] }));
        let mail = read_source("mail", "--all", None, None, context).unwrap();
        assert_eq!(mail, value!({ "title": "read", "text": "From: A <a@x>\nDate: 2026-11-25T08:21:20.000Z\n\nhi", "part": "whole" }));
        assert_eq!(
            read_source("photos", "--data-dir=/x", None, None, context).unwrap(),
            value!({ "title": "a.jpg", "text": "Taken: 2026-11-13T06:40:22Z\nKind: photo, 4032×3024, 2.1 MB\nAlbums: Trip\nNot downloaded to this computer.", "part": "whole" })
        );
        // A product that fails with nothing to say is still named.
        let refused = read_source("photos", "other", None, None, context).unwrap_err();
        assert_eq!(
            (refused.code.as_str(), refused.status, refused.message.as_str()),
            ("source_failed", 502, "icloud-photos failed: Command failed: icloud-photos info --quiet -- other")
        );
    }

    #[test]
    fn serves_a_photos_thumbnail_only_when_the_file_the_product_names_is_a_picture() {
        let owner = Owner::new(&[("icloud-photos", r#"printf '{"id":"%s","path":"%s"}' "$4" "$HOME/$4""#)]);
        let context = owner.context();
        let jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
        let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9];
        owner.write("p1", &jpeg);
        owner.write("p2", &png);
        owner.write("secret", "token=abc");
        assert_eq!(picture_of("photos", "p1", context).unwrap(), ("image/jpeg", jpeg));
        assert_eq!(picture_of("photos", "p2", context).unwrap(), ("image/png", png));
        assert_eq!(failure(picture_of("photos", "secret", context)), ("not_found".into(), 404));
        assert_eq!(failure(picture_of("photos", "missing", context)), ("not_found".into(), 404));
        assert_eq!(failure(picture_of("notes", "p1", context)), ("no_pictures".into(), 405));
        let with_pictures: Vec<Value> =
            list_sources(context).as_array().unwrap().iter().filter(|row| row["pictures"] == true).map(|row| row["id"].clone()).collect();
        assert_eq!(with_pictures, [value!("photos")]);
    }

    #[test]
    fn lists_keep_notes_and_google_photos_and_reads_a_drive_file_from_what_the_google_tools_keep_here() {
        let photos = r#"case "$*" in
  "list --limit 5000 --quiet") printf '[{"id":"g1","filename":"IMG_1.HEIC","created":"2026-11-13T06:40:22Z","kind":"photo","width":4032,"height":3024,"local_path":null}]' ;;
  "info --quiet -- g1") printf '{"filename":"IMG_1.HEIC","created":"2026-11-13T06:40:22Z","kind":"photo","width":4032,"height":3024,"size":2100000,"place":"Helsinki","local_path":null}' ;;
  *) exit 2 ;;
esac"#;
        let owner = Owner::new(&[("google-photos", photos)]);
        let context = owner.context();
        let note = owner.write("Documents/Keep/Archive/Packing.md", "Passport\nCharger\n");
        let sheet = owner.write("Google Drive/plan.txt", "the plan\n");
        let keep = list_source("keep", context, 10, None).unwrap();
        assert_eq!(items(&keep).len(), 1);
        let row = &items(&keep)[0];
        assert_eq!(
            (&row["source"], &row["id"], &row["title"], &row["snippet"]),
            (&value!("keep"), &value!(note), &value!("Packing"), &value!("Passport"))
        );
        assert_eq!(read_source("keep", &note, None, None, context).unwrap()["text"], "Passport\nCharger\n");
        let refused = read_source("keep", &sheet, None, None, context).unwrap_err();
        assert_eq!((refused.code.as_str(), refused.message.as_str()), ("not_found", "That is not in Google Keep."));
        assert_eq!(read_source("google-drive", &sheet, None, None, context).unwrap()["text"], "the plan\n");
        assert_eq!(
            list_source("google-photos", context, 10, None).unwrap(),
            value!({ "items": [{ "source": "google-photos", "id": "g1", "title": "IMG_1.HEIC", "snippet": "photo · 4032×3024", "at": at("2026-11-13T06:40:22Z") }], "next": null })
        );
        assert_eq!(
            read_source("google-photos", "g1", None, None, context).unwrap()["text"],
            "Taken: 2026-11-13T06:40:22Z\nKind: photo, 4032×3024, 2.1 MB\nPlace: Helsinki\nNot downloaded to this computer."
        );
        assert_eq!(failure(picture_of("google-photos", "g1", context)).0, "no_pictures");
    }

    #[test]
    fn names_a_failing_source_and_still_returns_the_others() {
        let owner = Owner::new(&[
            ("cloudmail", "echo 'worker unreachable' >&2; exit 5"),
            ("cloud-contacts", r#"printf '%s' '[{"id":"p1","name":"Sara","company":"Emy Terra","phones":[{"value":"+1 555"}]}]'"#),
        ]);
        let result = search_sources("Sara", owner.context(), Some(&names(&["mail", "contacts"])), 8).unwrap();
        assert_eq!(
            result,
            value!({
                "items": [{ "source": "contacts", "id": "p1", "title": "Sara", "snippet": "Emy Terra · +1 555", "at": null }],
                "failed": [{ "source": "mail", "message": "cloudmail failed: worker unreachable" }],
            })
        );
    }

    #[test]
    fn a_search_across_sources_runs_them_at_once() {
        let owner = Owner::new(&[("cloudmail", "/usr/bin/sleep 1; printf '[]'"), ("cloud-contacts", "/usr/bin/sleep 1; printf '[]'")]);
        if !Path::new("/usr/bin/sleep").exists() {
            println!("skipped: /usr/bin/sleep is not installed");
            return;
        }
        let started = Instant::now();
        // Mail asks twice for a three-word query that finds nothing, so one after another this is three seconds.
        let result = search_sources("one two three", owner.context(), Some(&names(&["mail", "contacts"])), 8).unwrap();
        assert_eq!(result, value!({ "items": [], "failed": [] }));
        assert!(started.elapsed() < Duration::from_millis(2800), "{:?}", started.elapsed());
    }

    #[test]
    fn reads_contacts_and_the_calendar_as_the_products_print_them() {
        let contacts = r#"case "$*" in
  "list --cached --quiet") printf '[{"id":"p1","name":"Sara"},{"id":"p2","name":""},{"id":"p3","name":"Tom","emails":[{"value":"t@x"}]}]' ;;
  "show --cached --quiet -- p1") printf '{"name":"Sara","job_title":"Chef","company":"Emy Terra","phones":[{"value":"+1 555","label":"mobile"}],"emails":[{"value":"s@x"}],"addresses":[{"street":"1 Main","city":"Ubud","country":"ID"}],"birthday":"1990-01-02","notes":" likes tea ","provider":"icloud"}' ;;
  *) printf 'null' ;;
esac"#;
        let calendar = r#"[ "$*" = "agenda --from 2026-12-25 --days 14 --quiet" ] && printf '[{"id":"e1","title":"Lunch","start":"2026-12-26T04:00:00Z","end":"2026-12-26T05:00:00Z","calendar":"Home"},{"id":"e2","title":"","all_day":true,"start":"2026-12-27","calendar":"Work"}]' || exit 2"#;
        let owner = Owner::new(&[("cloud-contacts", contacts), ("cloud-calendar", calendar)]);
        let context = owner.context();
        let first = list_source("contacts", context, 2, None).unwrap();
        assert_eq!(items(&first).iter().map(|item| item["title"].as_str().unwrap()).collect::<Vec<_>>(), ["Sara", "(no name)"]);
        assert_eq!(first["next"], "2");
        let rest = list_source("contacts", context, 2, Some("2")).unwrap();
        assert_eq!(rest, value!({ "items": [{ "source": "contacts", "id": "p3", "title": "Tom", "snippet": "t@x", "at": null }], "next": null }));
        assert_eq!(
            read_source("contacts", "p1", None, None, context).unwrap()["text"],
            "Chef, Emy Terra\nPhone: +1 555 (mobile)\nEmail: s@x\nAddress: 1 Main, Ubud, ID\nBirthday: 1990-01-02\n\nlikes tea\n\nIn icloud."
        );
        assert_eq!(failure(read_source("contacts", "nobody", None, None, context)), ("not_found".into(), 404));
        // A long query is a question, not a name.
        assert_eq!(search_sources("who is sara again", context, Some(&names(&["contacts"])), 8).unwrap(), value!({ "items": [], "failed": [] }));

        assert_eq!(
            list_source("calendar", context, 10, Some("2026-12-25")).unwrap(),
            value!({
                "items": [
                    { "source": "calendar", "id": "e1", "title": "Lunch", "snippet": "2026-12-26T04:00:00Z – 2026-12-26T05:00:00Z · Home", "at": at("2026-12-26T04:00:00Z") },
                    { "source": "calendar", "id": "e2", "title": "(no title)", "snippet": "all day · Work", "at": at("2026-12-27") },
                ],
                "next": "2027-01-08",
            })
        );
        let refused = list_source("calendar", context, 10, Some("tomorrow")).unwrap_err();
        assert_eq!(
            (refused.code.as_str(), refused.status, refused.message.as_str()),
            ("invalid_request", 400, "A calendar cursor is a YYYY-MM-DD day.")
        );
        assert_eq!(failure(read_source("calendar", "e1", None, None, context)), ("not_readable".into(), 405));
    }

    #[test]
    fn reads_are_cut_at_the_limit_without_splitting_a_character() {
        let owner = Owner::new(&[]);
        let context = owner.context();
        // 'é' is two bytes: the byte limit falls inside one.
        let long = owner.write("Documents/Notes/long.md", format!("a{}", "é".repeat(READ_CHARS)));
        let read = read_source("notes", &long, None, None, context).unwrap();
        let text = read["text"].as_str().unwrap();
        assert_eq!(read["part"], "start");
        assert_eq!(text.len(), READ_CHARS - 1);
        assert!(!text.contains('\u{fffd}'));
        let lines: String = (1..=200).map(|n| format!("line {n}\n")).collect();
        let listed = owner.write("Documents/Notes/lines.md", lines);
        let around = read_source("notes", &listed, None, Some(100), context).unwrap();
        assert_eq!(around["part"], "lines 81-160");
        assert!(around["text"].as_str().unwrap().starts_with("line 81\n"));
        assert!(around["text"].as_str().unwrap().ends_with("line 160"));
        let binary = owner.write("Documents/Notes/blob.md", [1u8, 0, 2]);
        assert_eq!(failure(read_source("notes", &binary, None, None, context)), ("source_failed".into(), 422));
        // A chat longer than the limit reads from a whole line near its end.
        let chat = owner.write("WhatsApp/+1/WhatsApp Chat - Long/_chat.txt", format!("{}\nlast line\n", "é".repeat(READ_CHARS)));
        let latest = read_source("whatsapp", &chat, None, None, context).unwrap();
        assert_eq!(latest["text"], "last line\n");
    }

    #[test]
    fn text_helpers_count_as_javascript_does() {
        assert_eq!(one_line("  a\n\tb  c ", 10), "a b c");
        assert_eq!(one_line("abcdef", 3), "abc");
        // An emoji is two UTF-16 units: it is kept whole or left out.
        assert_eq!(cut("a😀b", 2), "a");
        assert_eq!(cut("a😀b", 3), "a😀");
        assert_eq!(js_string(Some(&value!(3.0))), "3");
        assert_eq!(js_string(Some(&value!(2.5))), "2.5");
        assert_eq!(js_string(Some(&value!([1, null, "x"]))), "1,,x");
        assert_eq!(js_string(None), "undefined");
        assert_eq!(number_json(1_700_000_000_000.0), value!(1_700_000_000_000_i64));
        assert_eq!(number_json(1.5), value!(1.5));
        assert_eq!(ms(Some(&value!("not a time"))), None);
        assert_eq!(ms(Some(&value!("2026-11-25T08:21:20Z"))), Some(1_795_594_880_000.0));
        assert_eq!(whole_characters("aé".as_bytes()), "aé".as_bytes());
        assert_eq!(whole_characters(&"aé".as_bytes()[..2]), b"a");
        assert_eq!(whole_characters(&"a😀".as_bytes()[..4]), b"a");
    }

    #[test]
    fn inside_is_decided_by_name_alone() {
        assert!(inside("/home/o/Notes", "/home/o/Notes/a.md"));
        assert!(inside("/home/o/Notes/", "/home/o/Notes/x/../a.md"));
        assert!(!inside("/home/o/Notes", "/home/o/Notes"));
        assert!(!inside("/home/o/Notes", "/home/o/Notes/../a.md"));
        assert!(!inside("/home/o/Notes", "/home/o/Notes2/a.md"));
        assert!(inside("/", "/a"));
        assert_eq!((basename("/a/b/c.txt"), dirname("/a/b/c.txt"), dirname("/a"), dirname("a")), ("c.txt", "/a/b", "/", "."));
    }

    #[test]
    fn pages_are_cut_by_time_or_by_offset() {
        let item = |id: &str, at: Option<f64>| plain_item("photos", id.into(), id.into(), String::new(), at);
        let all = || vec![item("b", Some(2.0)), item("none", None), item("c", Some(3.5)), item("a", Some(1.0))];
        let ids = |page: &SourcePage| page.items.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
        let first = time_page(all(), 2, None);
        assert_eq!((ids(&first), first.next.as_deref()), (vec!["c".to_string(), "b".into()], Some("2")));
        let second = time_page(all(), 2, Some("2"));
        assert_eq!((ids(&second), second.next), (vec!["a".to_string(), "none".into()], None));
        assert_eq!(time_page(all(), 1, None).next.as_deref(), Some("3.5"));
        assert!(time_page(all(), 2, Some("soon")).items.is_empty());
        let offset = offset_page(all(), 3, Some("1"));
        assert_eq!((ids(&offset), offset.next), (vec!["none".to_string(), "c".into(), "a".into()], None));
        assert_eq!(offset_page(all(), 3, None).next.as_deref(), Some("3"));
        assert_eq!(ids(&offset_page(all(), 3, Some("-4"))), ids(&offset_page(all(), 3, Some("junk"))));
        assert!(offset_page(all(), 3, Some("99")).items.is_empty());
    }

    /// A library index shaped as Lastbook builds it, with a few pages.
    fn library(owner: &Owner) -> Option<String> {
        if !owner.link("sqlite3") {
            println!("skipped: sqlite3 (/usr/bin/sqlite3) is not installed");
            return None;
        }
        let db = owner.path(".local/share/Lastbook/LastbookData/library-data/search.sqlite");
        std::fs::create_dir_all(Path::new(&db).parent().unwrap()).unwrap();
        let sql = "CREATE VIRTUAL TABLE pages USING fts5(doc_id UNINDEXED,title,collection,category,path UNINDEXED,page UNINDEXED,body,tokenize=\"unicode61\");
INSERT INTO pages VALUES ('d1','Where There Is No Doctor','health','first-aid','books/doctor.pdf',12,'To purify water boil it for one minute, then let it cool.');
INSERT INTO pages VALUES ('d1','Where There Is No Doctor','health','first-aid','books/doctor.pdf',40,'A burn is cooled with clean water at once.');
INSERT INTO pages VALUES ('d2','Solar Power Basics','power','solar','books/solar.pdf',3,'A panel charges the battery through a controller.');";
        let made = std::process::Command::new("/usr/bin/sqlite3").arg(&db).arg(sql).output().unwrap();
        if !made.status.success() {
            println!("skipped: this sqlite3 cannot build an FTS5 index: {}", String::from_utf8_lossy(&made.stderr).trim());
            return None;
        }
        Some(db)
    }

    #[test]
    fn searches_lastbooks_index_through_the_sqlite3_command() {
        let owner = Owner::new(&[]);
        assert_eq!(list_sources(owner.context()).as_array().unwrap().iter().find(|row| row["id"] == "lastbook").unwrap()["available"], false);
        let Some(db) = library(&owner) else { return };
        let context = owner.context();
        let lastbook = names(&["lastbook"]);
        let file = |name: &str| format!("{}/books/{name}", dirname(&db));
        assert_eq!(list_sources(context).as_array().unwrap().iter().find(|row| row["id"] == "lastbook").unwrap()["available"], true);

        // Every word on one page.
        let found = search_sources("Purify WATER!", context, Some(&lastbook), 8).unwrap();
        assert_eq!(
            found,
            value!({
                "items": [{
                    "source": "lastbook", "id": file("doctor.pdf"), "title": "Where There Is No Doctor, page 12",
                    "snippet": "To purify water boil it for one minute, then let it cool.", "at": null, "path": file("doctor.pdf"), "page": 12,
                }],
                "failed": [],
            })
        );
        // No page has both words: any of them, best first, and the limit holds.
        let either = search_sources("battery burn", context, Some(&lastbook), 8).unwrap();
        let mut pages: Vec<u64> = items(&either).iter().map(|item| item["page"].as_u64().unwrap()).collect();
        pages.sort_unstable();
        assert_eq!(pages, [3, 40]);
        assert_eq!(items(&search_sources("battery burn", context, Some(&lastbook), 1).unwrap()).len(), 1);
        // A word in the title outranks the same word in a body.
        let titled = search_sources("doctor water", context, Some(&lastbook), 8).unwrap();
        assert_eq!(items(&titled).len(), 2);
        // Nothing matches, and punctuation is never query syntax or SQL.
        for query in ["zebra", "'; DROP TABLE pages; --", "\"water", "water) OR (", "'"] {
            let result = search_sources(query, context, Some(&lastbook), 8).unwrap();
            assert_eq!(result["failed"], value!([]), "{query}");
        }
        assert_eq!(search_sources("zebra", context, Some(&lastbook), 8).unwrap(), value!({ "items": [], "failed": [] }));
        assert_eq!(items(&search_sources("\"water", context, Some(&lastbook), 8).unwrap()).len(), 2);
        // It is part of a search across every source that is set up.
        let everywhere = search_sources("controller", context, None, 8).unwrap();
        assert!(items(&everywhere).iter().any(|item| item["source"] == "lastbook" && item["page"] == 3), "{everywhere}");
        // A page is read only from inside the library.
        assert_eq!(failure(read_source("lastbook", &owner.path("Documents/x.pdf"), Some(1), None, context)), ("not_found".into(), 404));
    }

    #[test]
    fn a_lastbook_search_without_sqlite3_says_so() {
        let owner = Owner::new(&[]);
        owner.write(".local/share/Lastbook/LastbookData/library-data/search.sqlite", "");
        let result = search_sources("water", owner.context(), Some(&names(&["lastbook"])), 8).unwrap();
        assert_eq!(
            result,
            value!({ "items": [], "failed": [{ "source": "lastbook", "message": "Searching Lastbook needs the sqlite3 command, which is not installed." }] })
        );
        let failed = lastbook_search(owner.context(), "water", 8).unwrap_err();
        assert_eq!((failed.code.as_str(), failed.status), ("source_failed", 502));
        // A file that is not an index fails as the source's own error, naming sqlite3.
        if owner.link("sqlite3") {
            owner.write(".local/share/Lastbook/LastbookData/library-data/search.sqlite", "not a database, just some text that is long enough");
            let broken = lastbook_search(owner.context(), "water", 8).unwrap_err();
            assert_eq!((broken.code.as_str(), broken.status), ("source_failed", 502));
            assert!(broken.message.starts_with("sqlite3 failed: "), "{}", broken.message);
        }
    }
}
