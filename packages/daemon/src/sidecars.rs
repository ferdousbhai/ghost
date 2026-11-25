//! Per-ghost conversation sidecars in `sessions/`: `pins.json` lists pinned
//! ids in pin order, `reads.json` maps an id to when the owner last read it,
//! `questions.json` maps an id to the question the ghost is waiting on.
//! Each is replaced whole and privately; a missing, malformed, or hand-edited
//! file reads as empty rather than failing the listing.
use crate::clock::{iso, parse_iso};
use crate::private_file::{read_text, write_json_atomic};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

const VERSION: u64 = 2;

/// The sidecars' names in `sessions/`, which no conversation id may take.
pub const SIDECAR_FILENAMES: [&str; 3] = ["pins.json", "reads.json", "questions.json"];

pub fn pins_path(session_dir: &Path) -> PathBuf {
    session_dir.join("pins.json")
}
pub fn reads_path(session_dir: &Path) -> PathBuf {
    session_dir.join("reads.json")
}
pub fn questions_path(session_dir: &Path) -> PathBuf {
    session_dir.join("questions.json")
}

/// What a ghost asked the owner in one conversation, waiting for their next message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerQuestion {
    pub text: String,
    /// Suggested answers; the owner may answer anything.
    pub options: Vec<String>,
    pub asked_at: String,
}

impl OwnerQuestion {
    /// As the file and the API carry it: `text`, `options`, `askedAt`.
    pub fn to_json(&self) -> Value {
        json!({ "text": self.text, "options": self.options, "askedAt": self.asked_at })
    }
}

fn read_field(path: &Path, field: &str) -> Option<Value> {
    let text = read_text(path).ok()??;
    serde_json::from_str::<Value>(&text).ok()?.get(field).cloned()
}

fn write(path: &Path, field: &str, value: Value) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut document = Map::new();
    document.insert("version".to_string(), json!(VERSION));
    document.insert(field.to_string(), value);
    write_json_atomic(path, &Value::Object(document))
}

/// A stored time as Ghost writes one, or None when it does not parse.
fn timestamp(value: &Value) -> Option<String> {
    Some(iso(parse_iso(value.as_str()?)?))
}

/// Pinned ids, deduplicated; anything but a non-empty string is dropped.
pub fn read_pins(session_dir: &Path) -> Vec<String> {
    let mut pinned: Vec<String> = Vec::new();
    if let Some(Value::Array(ids)) = read_field(&pins_path(session_dir), "pinned") {
        for id in ids.iter().filter_map(Value::as_str) {
            if !id.is_empty() && !pinned.iter().any(|known| known == id) {
                pinned.push(id.to_string());
            }
        }
    }
    pinned
}

pub fn write_pins(session_dir: &Path, ids: &[String]) -> io::Result<()> {
    write(&pins_path(session_dir), "pinned", json!(ids))
}

/// Read times by id, as ISO timestamps; an entry without a parseable time is dropped.
pub fn read_reads(session_dir: &Path) -> BTreeMap<String, String> {
    let mut kept = BTreeMap::new();
    if let Some(Value::Object(reads)) = read_field(&reads_path(session_dir), "reads") {
        for (id, value) in &reads {
            if let Some(time) = timestamp(value).filter(|_| !id.is_empty()) {
                kept.insert(id.clone(), time);
            }
        }
    }
    kept
}

pub fn write_reads(session_dir: &Path, reads: &BTreeMap<String, String>) -> io::Result<()> {
    write(&reads_path(session_dir), "reads", json!(reads))
}

/// Open questions by conversation id; an entry without text or a parseable time is dropped.
pub fn read_questions(session_dir: &Path) -> BTreeMap<String, OwnerQuestion> {
    let mut kept = BTreeMap::new();
    if let Some(Value::Object(questions)) = read_field(&questions_path(session_dir), "questions") {
        for (id, entry) in &questions {
            let Some(text) = entry.get("text").and_then(Value::as_str).filter(|text| !text.is_empty() && !id.is_empty() && entry.is_object()) else {
                continue;
            };
            let Some(asked_at) = entry.get("askedAt").and_then(timestamp) else { continue };
            let options = match entry.get("options") {
                Some(Value::Array(options)) => {
                    options.iter().filter_map(Value::as_str).filter(|option| !option.is_empty()).map(str::to_string).collect()
                }
                _ => Vec::new(),
            };
            kept.insert(id.clone(), OwnerQuestion { text: text.to_string(), options, asked_at });
        }
    }
    kept
}

pub fn write_questions(session_dir: &Path, questions: &BTreeMap<String, OwnerQuestion>) -> io::Result<()> {
    let document: Map<String, Value> = questions.iter().map(|(id, question)| (id.clone(), question.to_json())).collect();
    write(&questions_path(session_dir), "questions", Value::Object(document))
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

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn pins_round_trip_under_the_contracts_key_creating_the_directory_privately() {
        let root = Scratch::new();
        let dir = root.0.join("nested").join("sessions");
        write_pins(&dir, &ids(&["conv-1", "conv-2"])).unwrap();
        assert_eq!(read_pins(&dir), ids(&["conv-1", "conv-2"]));
        assert_eq!(
            std::fs::read_to_string(pins_path(&dir)).unwrap(),
            "{\n  \"version\": 2,\n  \"pinned\": [\n    \"conv-1\",\n    \"conv-2\"\n  ]\n}\n"
        );
        assert_eq!(mode(&pins_path(&dir)), 0o600);
    }

    #[test]
    fn pins_read_a_missing_malformed_or_hand_edited_file_as_empty_and_drop_bad_entries() {
        let root = Scratch::new();
        assert_eq!(read_pins(&root.0), Vec::<String>::new());
        for body in ["", "{", "null", "[]", "\"conv-1\"", "{}", "{\"pinned\":\"conv-1\"}"] {
            std::fs::write(pins_path(&root.0), body).unwrap();
            assert_eq!(read_pins(&root.0), Vec::<String>::new(), "{body:?}");
        }
        std::fs::write(pins_path(&root.0), r#"{"pinned":["conv-1","",7,null,"conv-1","conv-2"]}"#).unwrap();
        assert_eq!(read_pins(&root.0), ids(&["conv-1", "conv-2"]));
    }

    #[test]
    fn pins_read_a_file_over_the_control_file_bound_as_empty_without_loading_it() {
        let root = Scratch::new();
        std::fs::write(pins_path(&root.0), json!({ "pinned": ["conv-1"], "pad": "x".repeat(1024 * 1024) }).to_string()).unwrap();
        assert_eq!(read_pins(&root.0), Vec::<String>::new());
    }

    #[test]
    fn pins_replace_atomically_concurrent_writers_leave_one_whole_file_no_debris() {
        let root = Scratch::new();
        std::thread::scope(|scope| {
            for id in ["a", "b", "c"] {
                let dir = &root.0;
                scope.spawn(move || write_pins(dir, &ids(&[id])).unwrap());
            }
        });
        let names: Vec<String> = std::fs::read_dir(&root.0).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names, ["pins.json"]);
        let pinned = read_pins(&root.0);
        assert!(pinned.len() == 1 && ["a", "b", "c"].contains(&pinned[0].as_str()), "{pinned:?}");
    }

    #[test]
    fn reads_take_missing_and_malformed_state_as_empty() {
        let root = Scratch::new();
        assert!(read_reads(&root.0).is_empty());
        for body in ["", "{", "null", "[]", "{}", r#"{"reads":[]}"#] {
            std::fs::write(reads_path(&root.0), body).unwrap();
            assert!(read_reads(&root.0).is_empty(), "{body:?}");
        }
    }

    #[test]
    fn reads_round_trip_valid_timestamps_drop_invalid_entries_and_write_privately() {
        let root = Scratch::new();
        std::fs::write(
            reads_path(&root.0),
            r#"{"reads":{"conv-1":"2026-08-25T10:11:12.000Z","":"2026-08-25T10:11:12.000Z","bad":"yesterday","number":7,"zoned":"2026-08-25T12:11:12+02:00"}}"#,
        )
        .unwrap();
        let expected = BTreeMap::from([
            ("conv-1".to_string(), "2026-08-25T10:11:12.000Z".to_string()),
            ("zoned".to_string(), "2026-08-25T10:11:12.000Z".to_string()),
        ]);
        assert_eq!(read_reads(&root.0), expected);
        let written = BTreeMap::from([("a".to_string(), "2026-08-25T10:00:00.000Z".to_string())]);
        write_reads(&root.0, &written).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&std::fs::read_to_string(reads_path(&root.0)).unwrap()).unwrap(),
            json!({ "version": 2, "reads": { "a": "2026-08-25T10:00:00.000Z" } })
        );
        assert_eq!(mode(&reads_path(&root.0)), 0o600);
        assert_eq!(read_reads(&root.0), written);
    }

    #[test]
    fn questions_round_trip_and_drop_entries_without_text_or_a_time() {
        let root = Scratch::new();
        assert!(read_questions(&root.0).is_empty());
        std::fs::write(
            questions_path(&root.0),
            r#"{"questions":{"a":{"text":"Tea?","options":["yes","",3,"no"],"askedAt":"2026-08-25T10:11:12Z"},"b":{"text":"","askedAt":"2026-08-25T10:11:12Z"},"c":{"text":"When?","askedAt":"soon"},"d":"Tea?","":{"text":"x","askedAt":"2026-08-25T10:11:12Z"},"e":{"text":"Plain?","options":"yes","askedAt":"2026-08-25T10:11:12.5Z"}}}"#,
        )
        .unwrap();
        let kept = read_questions(&root.0);
        let tea = OwnerQuestion { text: "Tea?".into(), options: ids(&["yes", "no"]), asked_at: "2026-08-25T10:11:12.000Z".into() };
        let plain = OwnerQuestion { text: "Plain?".into(), options: Vec::new(), asked_at: "2026-08-25T10:11:12.500Z".into() };
        assert_eq!(kept, BTreeMap::from([("a".to_string(), tea.clone()), ("e".to_string(), plain)]));
        write_questions(&root.0, &kept).unwrap();
        assert_eq!(read_questions(&root.0), kept);
        assert_eq!(mode(&questions_path(&root.0)), 0o600);
        assert_eq!(tea.to_json().to_string(), r#"{"text":"Tea?","options":["yes","no"],"askedAt":"2026-08-25T10:11:12.000Z"}"#);
    }
}
