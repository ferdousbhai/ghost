//! What the CLI prints: the `--json` and `-q` shapes, tables, relative times,
//! and the usage and help texts. Widths are counted as the first CLI counted
//! them (UTF-16 units), so columns and cut-offs land where they always did.
use serde_json::Value;
use std::io::Write;

/// Write and flush: a turn's text must reach a terminal as it streams, and a
/// reader that went away is not worth failing for.
pub fn write(stream: &mut dyn Write, text: &str) {
    let _ = stream.write_all(text.as_bytes());
    let _ = stream.flush();
}

pub fn write_json(stream: &mut dyn Write, value: &Value) {
    write(stream, &format!("{value}\n"));
}

fn width(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A JSON value as a template would print it: a string bare, anything else as JSON.
pub fn text_of(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// Whether a JSON value counts as present: not missing, null, false, zero or empty text.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// The value at `key` unless it is missing or null.
pub fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|found| !found.is_null())
}

/// How long ago an ISO time was, in the largest whole unit; `—` when it is not a time.
pub fn relative_time(value: &str, now_ms: i64) -> String {
    let Some(timestamp) = crate::clock::parse_iso(value) else { return "—".to_string() };
    let minutes = (now_ms - timestamp).max(0) / 60_000;
    let hours = minutes / 60;
    match () {
        () if minutes < 1 => "now".to_string(),
        () if minutes < 60 => format!("{minutes}m"),
        () if hours < 24 => format!("{hours}h"),
        () => format!("{}d", hours / 24),
    }
}

/// What a verb prints for a person, and what is left of it under `-q`.
pub enum Rendered {
    /// An acknowledgement: `-q` drops it.
    Secondary(String),
    Both {
        human: String,
        quiet: String,
    },
}

/// Output that is all primary: `-q` keeps it whole.
pub fn primary(text: String) -> Rendered {
    Rendered::Both { human: text.clone(), quiet: text }
}

/// `text` cut to `limit` units, the last one an ellipsis when anything was cut.
pub fn truncate(value: &str, limit: usize) -> String {
    if width(value) <= limit {
        return value.to_string();
    }
    let mut kept = String::new();
    let mut units = 0;
    for letter in value.chars() {
        units += letter.len_utf16();
        if units > limit.saturating_sub(1) {
            break;
        }
        kept.push(letter);
    }
    kept.push('…');
    kept
}

/// Columns padded to their widest cell and joined by two spaces; no trailing spaces.
pub fn table(rows: &[Vec<String>], headers: Option<&[&str]>) -> String {
    let mut all: Vec<Vec<String>> = headers.map(|headers| headers.iter().map(|cell| cell.to_string()).collect()).into_iter().collect();
    all.extend(rows.iter().cloned());
    let columns = all.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> =
        (0..columns).map(|column| all.iter().map(|row| row.get(column).map_or(0, |cell| width(cell))).max().unwrap_or(0)).collect();
    let line = |row: &Vec<String>| {
        let cells: Vec<String> = row
            .iter()
            .enumerate()
            .map(|(column, cell)| {
                let padding = if column + 1 == columns { 0 } else { widths[column].saturating_sub(width(cell)) };
                format!("{cell}{}", " ".repeat(padding))
            })
            .collect();
        cells.join("  ").trim_end().to_string()
    };
    all.iter().map(line).collect::<Vec<_>>().join("\n")
}

pub fn dim(text: &str, enabled: bool) -> String {
    if enabled { format!("\u{1b}[2m{text}\u{1b}[22m") } else { text.to_string() }
}

/// One verb as the usage screen and `ghost help <verb>` describe it.
pub struct CommandDocumentation {
    pub verb: &'static str,
    pub usage: String,
    pub summary: &'static str,
    pub example: &'static str,
}

pub fn render_usage(commands: &[&CommandDocumentation]) -> String {
    let widest = commands.iter().map(|command| width(&command.usage)).max().unwrap_or(0);
    let rows: Vec<String> =
        commands.iter().map(|command| format!("  {}{}  {}", command.usage, " ".repeat(widest - width(&command.usage)), command.summary)).collect();
    format!(
        "ghost — talk to your ghost through ghostd

Usage:
  ghost <verb> [args] [flags]
  ghost help [command|exit-codes|<topic>]

Commands:
{}

Common flags:
  -s, --session <id>       Select by id or unique prefix (verbs that list it)
      --json               Emit API JSON (streams use one object per line)
  -q, --quiet              Suppress secondary output
  -h, --help               Show command help
  -v, --version            Show the ghost package version

ghostd runs the machine (tokens, remote access, and conversations, each turn
answered by a model on this machine); ghost talks to the ghost.
",
        rows.join("\n")
    )
}

pub fn render_command_help(command: &CommandDocumentation) -> String {
    format!("Usage: ghost {}\n\n{}\n\nExample: {}\n", command.usage, command.summary, command.example)
}

pub fn render_exit_codes(exit_codes: &[(i32, &str)]) -> String {
    let widest = exit_codes.iter().map(|(code, _)| code.to_string().len()).max().unwrap_or(0);
    let rows: Vec<String> = exit_codes.iter().map(|(code, meaning)| format!("  {code:>widest$}  {meaning}")).collect();
    format!("ghost exit codes\n\n{}\n", rows.join("\n"))
}
