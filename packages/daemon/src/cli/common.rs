//! What several verbs share: reading stdin and files named on the command
//! line, and finding the conversation a command addresses.
use super::client::{DaemonClient, not_found};
use super::{CliError, Context, Stdin};
use crate::http::percent_encode;
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

pub fn id_of(session: &Value) -> &str {
    session.get("id").and_then(Value::as_str).unwrap_or("")
}

fn quoted(text: &str) -> String {
    Value::String(text.to_string()).to_string()
}

pub fn list_sessions(client: &mut DaemonClient) -> Result<Vec<Value>, CliError> {
    match client.request("GET", "/api/sessions", None)?.get_mut("sessions").map(Value::take) {
        Some(Value::Array(sessions)) => Ok(sessions),
        _ => Err(CliError::failure("ghostd sent no conversation list")),
    }
}

/// The one conversation `requested` names: its exact id, else the only id it
/// begins. None found is exit 5; several is a usage error naming them.
pub fn resolve_session_prefix(rows: &[Value], requested: &str) -> Result<Value, CliError> {
    let exact: Vec<&Value> = rows.iter().filter(|row| id_of(row) == requested).collect();
    if let [only] = exact[..] {
        return Ok(only.clone());
    }
    let matches: Vec<&Value> = rows.iter().filter(|row| id_of(row).starts_with(requested)).collect();
    match matches[..] {
        [only] => Ok(only.clone()),
        [] => Err(not_found(&format!("session {}", quoted(requested)))),
        _ => Err(CliError::usage(format!(
            "Session prefix {} is ambiguous: {}",
            quoted(requested),
            matches.iter().map(|row| id_of(row)).collect::<Vec<_>>().join(", ")
        ))),
    }
}

/// `requested` as an id or unique prefix of a listed conversation, else as
/// given: one no message has landed in yet is not listed, and a turn
/// may still address it.
pub fn conversation_id(client: &mut DaemonClient, requested: &str) -> Result<String, CliError> {
    let sessions = list_sessions(client)?;
    if sessions.iter().any(|row| id_of(row).starts_with(requested)) {
        return Ok(id_of(&resolve_session_prefix(&sessions, requested)?).to_string());
    }
    Ok(requested.to_string())
}

/// The conversation updated last; the earlier of two that tie.
pub fn latest_session(rows: &[Value]) -> Option<&Value> {
    let updated = |row: &Value| row.get("updatedAt").and_then(Value::as_str).and_then(crate::clock::parse_iso);
    rows.iter().fold(None, |latest: Option<&Value>, row| match latest {
        Some(held) if !matches!((updated(row), updated(held)), (Some(new), Some(old)) if new > old) => Some(held),
        _ => Some(row),
    })
}

/// `-s`, then `$GHOST_SESSION` (set in a ghost's own shell); None when neither names one.
pub fn preferred_session_id(ctx: &Context) -> Option<String> {
    let flag = ctx.parsed.text("session").map(str::trim).filter(|id| !id.is_empty());
    flag.or_else(|| crate::env::var(ctx.runtime.env, "GHOST_SESSION")).map(str::to_string)
}

/// `requested` (an id or unique prefix) among the ghost's sessions, else its latest.
pub fn resolve_session(client: &mut DaemonClient, requested: Option<&str>) -> Result<Value, CliError> {
    let sessions = list_sessions(client)?;
    match requested {
        Some(requested) => resolve_session_prefix(&sessions, requested),
        None => latest_session(&sessions).cloned().ok_or_else(|| not_found("a conversation")),
    }
}

/// The conversation this command addresses, as `(id, API path)`.
pub fn resolve_target(ctx: &mut Context) -> Result<(String, String), CliError> {
    let requested = preferred_session_id(ctx);
    let session = resolve_session(ctx.client()?, requested.as_deref())?;
    let id = id_of(&session).to_string();
    let path = session_path(&id, "");
    Ok((id, path))
}

pub fn session_path(id: &str, suffix: &str) -> String {
    format!("/api/sessions/{}{suffix}", percent_encode(id))
}
