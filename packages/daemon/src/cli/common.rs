//! What several verbs share: reading stdin and files named on the command line.
use super::{CliError, Stdin};
use serde_json::Value;
use std::io::{self, Read};

/// All of stdin as text.
pub fn stdin_text(stdin: &mut Stdin) -> Result<String, CliError> {
    match stdin {
        Stdin::Text(text) => Ok(text.clone()),
        Stdin::Stream { reader, .. } => {
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).map_err(|error| CliError::failure(error.to_string()))?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

pub fn stdin_is_tty(stdin: &Stdin) -> bool {
    matches!(stdin, Stdin::Stream { is_tty: true, .. })
}

/// A file named on the command line, read before ghostd is asked: one that
/// cannot be read is a usage error, worded as it always was (`ENOENT: …`).
pub fn read_argument_file(path: &str) -> Result<String, CliError> {
    std::fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).map_err(|error| {
        CliError::usage(match error.kind() {
            io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{path}'"),
            io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{path}'"),
            io::ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory, read".to_string(),
            _ => format!("{error}, open '{path}'"),
        })
    })
}

pub fn read_argument_json(path: &str) -> Result<Value, CliError> {
    serde_json::from_str(&read_argument_file(path)?).map_err(|_| CliError::usage(format!("{path} is not valid JSON")))
}
