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
        Self::new(min, move |record| {
            let message = format(record);
            if journal {
                eprintln!("<{}>{message}", record.level.journal_priority());
            } else {
                eprintln!("{} {} {message}", crate::clock::now_iso(), record.level.name());
            }
        })
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
}
