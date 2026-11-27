//! Reads and atomic writes for the small files ghostd keeps in a ghost home
//! and its own state: capped at 1 MiB and decoded strictly on read, written
//! private (0600) through a temporary file and one rename.
use serde_json::Value;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const MAX_PRIVATE_FILE_BYTES: u64 = 1_048_576;

/// The file's text, or None when it does not exist; past 1 MiB or invalid UTF-8 is an error naming the file.
pub fn read_text(path: &Path) -> Result<Option<String>, String> {
    let size = match std::fs::metadata(path) {
        Ok(info) => info.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if size > MAX_PRIVATE_FILE_BYTES {
        return Err(format!("{} exceeds the 1 MiB limit.", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map(Some).map_err(|_| format!("{} is not valid UTF-8.", path.display()))
}

/// `value` as the files hold it: two-space indented JSON and a final newline.
fn pretty(value: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(value).expect("a JSON value serializes"))
}

/// Replace `path` with `value` as pretty JSON, private (0600), through a
/// per-writer temporary file and one rename, so a reader never sees a torn
/// file and two concurrent writers never share a temporary name.
pub fn write_json_atomic(path: &Path, value: &Value) -> io::Result<()> {
    let rendered = pretty(value);
    if rendered.len() as u64 > MAX_PRIVATE_FILE_BYTES {
        return Err(io::Error::other(format!("{} would exceed the 1 MiB private-file limit.", path.display())));
    }
    write_text_atomic(path, &rendered)
}

/// Replace `path` with `text`, private (0600), through a temporary file and one rename.
pub fn write_text_atomic(path: &Path, text: &str) -> io::Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.{}.tmp", std::process::id(), crate::random::uuid()));
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .and_then(|()| std::fs::rename(&temporary, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}
