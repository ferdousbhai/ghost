//! The conversation's sidecars, beside its log in the conversation directory:
//! `.question.json` is the question the ghost is waiting on, `.read.json`
//! when the owner last read the conversation. They are in that directory so
//! the one rename that trashes the conversation takes them with it. Each is
//! replaced whole and privately; a missing, malformed, or hand-edited file
//! reads as nothing rather than failing the request.
use crate::clock::{iso, parse_iso};
use crate::private_file::{read_text, write_json_atomic};
use serde_json::{Value, json};
use std::io;
use std::path::{Path, PathBuf};

pub fn question_path(conversation_dir: &Path) -> PathBuf {
    conversation_dir.join(".question.json")
}
pub fn read_path(conversation_dir: &Path) -> PathBuf {
    conversation_dir.join(".read.json")
}

/// How many answers a question offers: the `ask` tool's bound, held wherever a question is.
pub const QUESTION_OPTIONS: std::ops::RangeInclusive<usize> = 2..=4;

/// What the ghost asked the owner, waiting for their next message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerQuestion {
    pub text: String,
    /// The answers offered, `QUESTION_OPTIONS` of them; the owner may answer anything.
    pub options: Vec<String>,
    pub asked_at: String,
}

impl OwnerQuestion {
    /// As the file and the API carry it: `text`, `options`, `askedAt`.
    pub fn to_json(&self) -> Value {
        json!({ "text": self.text, "options": self.options, "askedAt": self.asked_at })
    }
}

fn read(path: &Path) -> Option<Value> {
    serde_json::from_str(&read_text(path).ok()??).ok()
}

/// A stored time as Ghost writes one, or None when it does not parse.
fn timestamp(value: &Value) -> Option<String> {
    Some(iso(parse_iso(value.as_str()?)?))
}

/// The open question; one without text, a parseable time, or 2 to 4 answers that are all text is none.
pub fn read_question(conversation_dir: &Path) -> Option<OwnerQuestion> {
    let stored = read(&question_path(conversation_dir))?;
    let text = stored.get("text").and_then(Value::as_str).filter(|text| !text.is_empty())?;
    let asked_at = stored.get("askedAt").and_then(timestamp)?;
    let options = stored.get("options")?.as_array()?;
    let options: Vec<String> =
        options.iter().map(|option| option.as_str().filter(|text| !text.is_empty()).map(str::to_string)).collect::<Option<_>>()?;
    QUESTION_OPTIONS.contains(&options.len()).then(|| OwnerQuestion { text: text.to_string(), options, asked_at })
}

/// Record the question; one that does not offer 2 to 4 answers is refused.
pub fn write_question(conversation_dir: &Path, question: &OwnerQuestion) -> io::Result<()> {
    if !QUESTION_OPTIONS.contains(&question.options.len()) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "a question offers 2 to 4 answers"));
    }
    write_json_atomic(&question_path(conversation_dir), &question.to_json())
}

/// Forget the open question; true when there was a file to remove.
pub fn remove_question(conversation_dir: &Path) -> io::Result<bool> {
    match std::fs::remove_file(question_path(conversation_dir)) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// When the owner last read the conversation, as an ISO timestamp.
pub fn read_read_at(conversation_dir: &Path) -> Option<String> {
    read(&read_path(conversation_dir))?.get("readAt").and_then(timestamp)
}

pub fn write_read_at(conversation_dir: &Path, read_at: &str) -> io::Result<()> {
    write_json_atomic(&read_path(conversation_dir), &json!({ "readAt": read_at }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ghostd-sidecars-{}", crate::random::uuid()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn the_read_time_takes_missing_and_malformed_state_as_none() {
        let root = Scratch::new();
        assert_eq!(read_read_at(&root.0), None);
        for body in ["", "{", "null", "[]", "{}", r#"{"readAt":"yesterday"}"#, r#"{"readAt":"2026-08-25T12:11:12+02:00"}"#, r#"{"readAt":7}"#] {
            std::fs::write(read_path(&root.0), body).unwrap();
            assert_eq!(read_read_at(&root.0), None, "{body:?}");
        }
    }

    #[test]
    fn the_read_time_round_trips_as_ghost_writes_times_and_is_written_privately() {
        let root = Scratch::new();
        std::fs::write(read_path(&root.0), r#"{"readAt":"2026-08-25T10:11:12Z"}"#).unwrap();
        assert_eq!(read_read_at(&root.0).as_deref(), Some("2026-08-25T10:11:12.000Z"));
        write_read_at(&root.0, "2026-08-25T10:00:00.000Z").unwrap();
        assert_eq!(std::fs::read_to_string(read_path(&root.0)).unwrap(), "{\n  \"readAt\": \"2026-08-25T10:00:00.000Z\"\n}\n");
        assert_eq!(mode(&read_path(&root.0)), 0o600);
        assert_eq!(read_read_at(&root.0).as_deref(), Some("2026-08-25T10:00:00.000Z"));
    }

    #[test]
    fn a_file_over_the_control_file_bound_reads_as_none_without_loading_it() {
        let root = Scratch::new();
        std::fs::write(read_path(&root.0), json!({ "readAt": "2026-08-25T10:00:00.000Z", "pad": "x".repeat(1024 * 1024) }).to_string()).unwrap();
        assert_eq!(read_read_at(&root.0), None);
    }

    #[test]
    fn the_question_round_trips_and_one_without_text_or_a_time_is_none() {
        let root = Scratch::new();
        assert_eq!(read_question(&root.0), None);
        for body in [
            "",
            "{",
            "\"Tea?\"",
            r#"{"text":"","askedAt":"2026-08-25T10:11:12Z"}"#,
            r#"{"text":"When?","askedAt":"soon"}"#,
            r#"{"askedAt":"2026-08-25T10:11:12Z"}"#,
        ] {
            std::fs::write(question_path(&root.0), body).unwrap();
            assert_eq!(read_question(&root.0), None, "{body:?}");
        }
        // Fewer than two answers, more than four, or one that is not text: no question either.
        for options in [r#""yes""#, "[]", r#"["yes"]"#, r#"["a","b","c","d","e"]"#, r#"["yes","",3,"no"]"#] {
            std::fs::write(question_path(&root.0), format!(r#"{{"text":"Tea?","options":{options},"askedAt":"2026-08-25T10:11:12Z"}}"#)).unwrap();
            assert_eq!(read_question(&root.0), None, "{options}");
        }
        std::fs::write(question_path(&root.0), r#"{"text":"Tea?","options":["yes","no"],"askedAt":"2026-08-25T10:11:12Z"}"#).unwrap();
        let tea = OwnerQuestion { text: "Tea?".into(), options: vec!["yes".into(), "no".into()], asked_at: "2026-08-25T10:11:12.000Z".into() };
        assert_eq!(read_question(&root.0), Some(tea.clone()));
        let four = OwnerQuestion { options: ["a", "b", "c", "d"].map(String::from).to_vec(), ..tea.clone() };
        write_question(&root.0, &four).unwrap();
        assert_eq!(read_question(&root.0), Some(four));
        for count in [0, 1, 5] {
            let off = OwnerQuestion { options: vec!["x".to_string(); count], ..tea.clone() };
            assert_eq!(write_question(&root.0, &off).unwrap_err().kind(), io::ErrorKind::InvalidInput, "{count}");
        }
        write_question(&root.0, &tea).unwrap();
        assert_eq!(read_question(&root.0), Some(tea.clone()));
        assert_eq!(mode(&question_path(&root.0)), 0o600);
        assert_eq!(tea.to_json().to_string(), r#"{"text":"Tea?","options":["yes","no"],"askedAt":"2026-08-25T10:11:12.000Z"}"#);
    }

    #[test]
    fn removing_the_question_says_whether_there_was_one() {
        let root = Scratch::new();
        assert!(!remove_question(&root.0).unwrap());
        let asked = OwnerQuestion { text: "Tea?".into(), options: vec!["yes".into(), "no".into()], asked_at: "2026-08-25T10:11:12.000Z".into() };
        write_question(&root.0, &asked).unwrap();
        assert!(remove_question(&root.0).unwrap());
        assert_eq!(read_question(&root.0), None);
    }
}
