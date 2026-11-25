//! `ghostd hook-complete`: one completion for a trusted command hook (a
//! stop-hook reviewer, a classifier), asked of the daemon that owns the ghost
//! (`POST /api/complete`), so it completes on the daemon's own loaded copy of
//! the local model rather than a second one started here.
use super::client::{DaemonClient, EXIT_UNREACHABLE};
use super::output::write;
use super::{CliRuntime, Stdin};
use serde_json::{Map, Value, json};
use std::io::Read;

const HOOK_COMPLETE_MAX_STDIN_BYTES: u64 = 1024 * 1024;

fn read_stdin(stdin: &mut Stdin) -> Result<String, String> {
    match stdin {
        Stdin::Text(text) => Ok(text.clone()),
        Stdin::Stream { reader, .. } => {
            let mut bytes = Vec::new();
            reader.take(HOOK_COMPLETE_MAX_STDIN_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
            if bytes.len() as u64 > HOOK_COMPLETE_MAX_STDIN_BYTES {
                return Err(format!("stdin exceeds {HOOK_COMPLETE_MAX_STDIN_BYTES} bytes."));
            }
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

/// The `prompt` of a hook's JSON input; any other field is ignored.
pub fn parse_hook_complete_input(raw: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(raw).map_err(|error| format!("stdin is not valid JSON: {error}"))?;
    let Some(input) = value.as_object() else { return Err("stdin must contain a JSON object.".to_string()) };
    match input.get("prompt") {
        Some(Value::String(prompt)) => Ok(prompt.clone()),
        _ => Err("stdin must contain a string prompt field.".to_string()),
    }
}

fn complete(runtime: &mut CliRuntime) -> Result<String, String> {
    let prompt = parse_hook_complete_input(&read_stdin(&mut runtime.stdin)?)?;
    if prompt.trim().is_empty() {
        return Err("prompt must be a non-empty string.".to_string());
    }
    let mut client = DaemonClient::new(runtime.env, runtime.home).map_err(|error| error.message)?;
    // No deadline of its own: the hook's `timeout` kills this process group,
    // which closes the request and stops the completion.
    let answer = client.request_within("POST", "/api/complete", Some(&json!({ "prompt": prompt })), None).map_err(|error| {
        if error.exit_code == EXIT_UNREACHABLE {
            format!("{} at {}; is it running? (systemctl --user status ghostd)", error.message, client.base_url)
        } else {
            error.message
        }
    })?;
    let mut reply = Map::new();
    if let Some(text) = answer.get("text") {
        reply.insert("text".to_string(), text.clone());
    }
    Ok(format!("{}\n", Value::Object(reply)))
}

/// Read `{ "prompt": … }` on stdin, print `{ "text": … }`. Exit 0, 1 with the
/// reason on stderr, or 2 when given arguments.
pub fn hook_complete_command(args: &[String], mut runtime: CliRuntime) -> i32 {
    if !args.is_empty() {
        write(runtime.stderr, "hook-complete accepts JSON on stdin and no arguments.\n");
        return 2;
    }
    match complete(&mut runtime) {
        Ok(line) => {
            write(runtime.stdout, &line);
            0
        }
        Err(message) => {
            write(runtime.stderr, &format!("{message}\n"));
            1
        }
    }
}
