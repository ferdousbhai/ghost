//! `ghostd hook-complete`: one completion for a trusted command hook (a
//! stop-hook reviewer, a classifier), asked of the daemon that owns the ghost
//! (`POST /api/complete`), so it completes on the daemon's own loaded copy of
//! the local model rather than a second one started here.
use super::CliRuntime;
use super::common::stdin_text;
use super::output::write;
use crate::client::{Client, ClientError};
use serde_json::{Map, Value, json};

const MAX_STDIN_BYTES: u64 = 1024 * 1024;

/// The `prompt` of a hook's JSON input; any other field is ignored.
fn parse_hook_complete_input(raw: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(raw).map_err(|error| format!("stdin is not valid JSON: {error}"))?;
    let Some(input) = value.as_object() else { return Err("stdin must contain a JSON object.".to_string()) };
    match input.get("prompt") {
        Some(Value::String(prompt)) => Ok(prompt.clone()),
        _ => Err("stdin must contain a string prompt field.".to_string()),
    }
}

fn complete(runtime: &mut CliRuntime) -> Result<String, String> {
    let prompt = parse_hook_complete_input(&stdin_text(&mut runtime.stdin, Some(MAX_STDIN_BYTES))?)?;
    if prompt.trim().is_empty() {
        return Err("prompt must be a non-empty string.".to_string());
    }
    let mut client = Client::discover(runtime.env, runtime.home).map_err(|error| error.to_string())?;
    // No deadline of its own: the hook's `timeout` kills this process group,
    // which closes the request and stops the completion.
    let answer = client.request("POST", "/api/complete", Some(&json!({ "prompt": prompt })), None).map_err(|error| match error {
        ClientError::Unreachable(_) => format!("{error} at {}; is it running? (systemctl --user status ghostd)", client.base_url()),
        _ => error.to_string(),
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

#[cfg(test)]
mod tests {
    use super::parse_hook_complete_input;

    #[test]
    fn takes_a_string_prompt_from_a_json_object_and_refuses_anything_else() {
        assert_eq!(parse_hook_complete_input("{\"ghost_home\":\"/g/casper\",\"prompt\":\"hi\",\"extra\":1}"), Ok("hi".to_string()));
        assert!(parse_hook_complete_input("not json").unwrap_err().starts_with("stdin is not valid JSON: "));
        assert_eq!(parse_hook_complete_input("[]").unwrap_err(), "stdin must contain a JSON object.");
        assert_eq!(parse_hook_complete_input("{\"ghost_home\":\"/g\",\"prompt\":7}").unwrap_err(), "stdin must contain a string prompt field.");
    }
}
