//! The daemon's logging surface: small, injectable, and never a place where a
//! message body or a credential can land. Callers log categorical facts —
//! ghost names, event counts, error classes — not message text.
use serde_json::{Map, Value};
use std::os::unix::fs::MetadataExt;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "info" => Some(Self::Info),
            "warn" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Info => "info ",
            Self::Warn => "warn ",
            Self::Error => "error",
        }
    }
    fn journal_priority(self) -> u8 {
        match self {
            Self::Info => 6,
            Self::Warn => 4,
            Self::Error => 3,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub level: Level,
    pub message: String,
    pub fields: Map<String, Value>,
}

type Sink = Arc<dyn Fn(&Record) + Send + Sync>;

#[derive(Clone)]
pub struct Logger {
    min: Level,
    sink: Option<Sink>,
    bound: Map<String, Value>,
}

/// True when stderr is the journal stream systemd handed this process, not one a child inherited.
pub fn stderr_is_journal(journal_stream: Option<&str>) -> bool {
    let Some((dev, ino)) = journal_stream.and_then(|value| value.split_once(':')) else { return false };
    let (Ok(dev), Ok(ino)) = (dev.parse::<u64>(), ino.parse::<u64>()) else { return false };
    std::fs::metadata("/proc/self/fd/2").is_ok_and(|info| info.dev() == dev && info.ino() == ino)
}

fn format(record: &Record) -> String {
    let suffix = if record.fields.is_empty() { String::new() } else { format!(" {}", Value::Object(record.fields.clone())) };
    format!("ghostd: {}{suffix}", record.message)
}

/// A record as stderr gets it: for the journal, its priority and no time.
fn stderr_line(record: &Record, journal: bool) -> String {
    let message = format(record);
    if journal {
        format!("<{}>{message}", record.level.journal_priority())
    } else {
        format!("{} {} {message}", crate::clock::now_iso(), record.level.name())
    }
}

impl Logger {
    pub fn silent() -> Self {
        Self { min: Level::Error, sink: None, bound: Map::new() }
    }

    pub fn new(min: Level, sink: impl Fn(&Record) + Send + Sync + 'static) -> Self {
        Self { min, sink: Some(Arc::new(sink)), bound: Map::new() }
    }

    /// One line per record on stderr. Under systemd a `<N>` prefix sets the
    /// journal priority, and journald adds the time and the unit's identifier.
    pub fn stderr(min: Level, journal: bool) -> Self {
        Self::new(min, move |record| eprintln!("{}", stderr_line(record, journal)))
    }

    /// A logger that keeps its records, for tests.
    pub fn recording() -> (Self, Arc<Mutex<Vec<Record>>>) {
        let records = Arc::new(Mutex::new(Vec::new()));
        let kept = records.clone();
        (Self::new(Level::Info, move |record| kept.lock().unwrap().push(record.clone())), records)
    }

    pub fn child(&self, fields: Value) -> Self {
        let mut bound = self.bound.clone();
        if let Value::Object(extra) = fields {
            bound.extend(extra);
        }
        Self { min: self.min, sink: self.sink.clone(), bound }
    }

    fn emit(&self, level: Level, message: &str, fields: Value) {
        let Some(sink) = &self.sink else { return };
        if level < self.min {
            return;
        }
        let mut merged = self.bound.clone();
        if let Value::Object(extra) = fields {
            merged.extend(extra);
        }
        sink(&Record { level, message: message.to_string(), fields: merged });
    }

    /// `fields` is a JSON object, or `Value::Null` for none.
    pub fn info(&self, message: &str, fields: Value) {
        self.emit(Level::Info, message, fields);
    }
    pub fn warn(&self, message: &str, fields: Value) {
        self.emit(Level::Warn, message, fields);
    }
    pub fn error(&self, message: &str, fields: Value) {
        self.emit(Level::Error, message, fields);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn child_fields_merge_and_levels_filter() {
        let (logger, records) = Logger::recording();
        let child = logger.child(json!({ "ghost": "casper" }));
        child.info("hello", json!({ "n": 1 }));
        child.warn("plain", Value::Null);
        let records = records.lock().unwrap();
        assert_eq!(format(&records[0]), r#"ghostd: hello {"ghost":"casper","n":1}"#);
        assert_eq!(records[1].level, Level::Warn);
        let kept = Arc::new(Mutex::new(0));
        let count = kept.clone();
        let quiet = Logger::new(Level::Warn, move |_| *count.lock().unwrap() += 1);
        quiet.info("dropped", Value::Null);
        quiet.error("kept", Value::Null);
        assert_eq!(*kept.lock().unwrap(), 1);
    }

    #[test]
    fn journal_needs_stderr_itself() {
        assert!(!stderr_is_journal(None));
        assert!(!stderr_is_journal(Some("1:2")));
        assert!(!stderr_is_journal(Some("nonsense")));
    }

    // ── Logging ─────────────────────────────────────────────────────────

    #[test]
    fn merges_bound_fields_below_call_site_fields() {
        let (root, records) = Logger::recording();
        let logger = root.child(json!({ "ghost": "casper", "turn": "first", "inherited": true }));
        logger.info("opened", json!({ "turn": "second", "local": true }));
        // A child of a child keeps what its parent bound; the parent is unchanged by it.
        logger.child(json!({ "part": "hooks", "ghost": "wraith" })).error("failed", Value::Null);
        root.warn("bare", Value::Null);
        let records = records.lock().unwrap();
        let fields = |index: usize| Value::Object(records[index].fields.clone());
        assert_eq!((records[0].level, records[0].message.as_str()), (Level::Info, "opened"));
        assert_eq!(fields(0), json!({ "ghost": "casper", "turn": "second", "inherited": true, "local": true }));
        assert_eq!(fields(1), json!({ "ghost": "wraith", "turn": "first", "inherited": true, "part": "hooks" }));
        assert_eq!((records[2].level, fields(2)), (Level::Warn, json!({})));
    }

    #[test]
    fn silent_loggers_and_their_children_say_nothing() {
        let silent = Logger::silent();
        let child = silent.child(json!({ "ghost": "casper" }));
        child.error("unheard", json!({ "n": 1 }));
        assert!(silent.sink.is_none() && child.sink.is_none());
    }

    #[test]
    fn prefixes_the_journal_priority_under_systemd_and_writes_a_timestamped_line_anywhere_else() {
        let stalled =
            Record { level: Level::Warn, message: "stalled".to_string(), fields: json!({ "ghost": "casper" }).as_object().unwrap().clone() };
        // journald adds the time itself.
        assert_eq!(stderr_line(&stalled, true), r#"<4>ghostd: stalled {"ghost":"casper"}"#);
        let priority = |level: Level| stderr_line(&Record { level, message: "m".to_string(), fields: Map::new() }, true);
        assert_eq!((priority(Level::Info).as_str(), priority(Level::Error).as_str()), ("<6>ghostd: m", "<3>ghostd: m"));
        let plain = stderr_line(&stalled, false);
        let (time, rest) = plain.split_once(' ').unwrap();
        assert_eq!(rest, r#"warn  ghostd: stalled {"ghost":"casper"}"#);
        // 2026-11-25T08:15:30.123Z
        let shape: String = time.chars().map(|c| if c.is_ascii_digit() { '0' } else { c }).collect();
        assert_eq!(shape, "0000-00-00T00:00:00.000Z");
        let failed = stderr_line(&Record { level: Level::Error, message: "m".to_string(), fields: Map::new() }, false);
        assert!(failed.ends_with("Z error ghostd: m"), "{failed}");
    }

    #[test]
    fn treats_an_inherited_journal_stream_that_is_not_this_stderr_as_no_journal() {
        assert!(!stderr_is_journal(Some("1:1")));
        assert!(!stderr_is_journal(Some("1:1:1")) && !stderr_is_journal(Some(":")) && !stderr_is_journal(Some("")));
        // The stream systemd names is this stderr only when both numbers are its own.
        let info = std::fs::metadata("/proc/self/fd/2").unwrap();
        assert!(stderr_is_journal(Some(&format!("{}:{}", info.dev(), info.ino()))));
        assert!(!stderr_is_journal(Some(&format!("{}:{}", info.dev(), info.ino() + 1))));
    }

    #[test]
    fn levels_are_the_three_the_flag_names() {
        assert_eq!((Level::parse("info"), Level::parse("warn"), Level::parse("error")), (Some(Level::Info), Some(Level::Warn), Some(Level::Error)));
        assert_eq!((Level::parse("debug"), Level::parse("WARN"), Level::parse("")), (None, None, None));
    }
}
