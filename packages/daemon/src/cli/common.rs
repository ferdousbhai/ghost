//! What several verbs share: reading stdin and files named on the command line.
use super::{CliError, Stdin};
use serde_json::Value;
use std::io::Read;

/// All of stdin as text; with `cap`, more bytes than that is an error.
pub(crate) fn stdin_text(stdin: &mut Stdin, cap: Option<u64>) -> Result<String, String> {
    let mut bytes = Vec::new();
    // One byte past the cap tells an input at the cap from one over it.
    (&mut stdin.reader).take(cap.map_or(u64::MAX, |cap| cap + 1)).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    match cap {
        Some(cap) if bytes.len() as u64 > cap => Err(format!("stdin exceeds {cap} bytes.")),
        _ => Ok(String::from_utf8_lossy(&bytes).into_owned()),
    }
}

/// A file named on the command line, read before ghostd is asked: one that
/// cannot be read is a usage error.
pub(crate) fn read_argument_file(path: &str) -> Result<String, CliError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) => Err(CliError::usage(format!("Cannot read {path}: {error}"))),
    }
}

pub(crate) fn read_argument_json(path: &str) -> Result<Value, CliError> {
    serde_json::from_str(&read_argument_file(path)?).map_err(|_| CliError::usage(format!("{path} is not valid JSON")))
}
