//! Every verb but `say`: each asks the daemon one thing and prints the answer
//! as a table, a transcript, or one acknowledging sentence.
use super::client::EXIT_SUCCESS;
use super::common::{read_argument_file, read_argument_json};
use super::output::{Rendered, present, primary, relative_time, table, text_of, truncate, truthy};
use super::{CliError, Context};
use serde_json::{Map, Value, json};

// ── The conversation ────────────────────────────────────────────────────

fn items<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn transcript_markdown(body: &Value) -> String {
    let message = |message: &Value| {
        let heading = match message.get("role").and_then(Value::as_str) {
            Some("user") => "you",
            Some("hook") => "Stop hook",
            _ => "ghost",
        };
        // Everything the turn held, in order: reasoning quoted, a command with what it printed, then what was said.
        let line = |part: &Value| {
            let kind = part.get("type").and_then(Value::as_str);
            let text = part.get("text").and_then(Value::as_str).unwrap_or("");
            let name = part.get("name").and_then(Value::as_str);
            let command = part.get("arguments").and_then(|arguments| arguments.get("command")).and_then(Value::as_str);
            match (kind, name, command) {
                (Some("thinking"), _, _) => text.trim().lines().map(|line| format!("> {line}")).collect::<Vec<_>>().join("\n"),
                // The note that stands for the conversation before it, in later turns.
                (Some("handoff"), _, _) => {
                    format!("> Handoff note\n>\n{}", text.trim().lines().map(|line| format!("> {line}")).collect::<Vec<_>>().join("\n"))
                }
                // The question and its answers are the text that follows.
                (Some("toolCall"), Some("ask"), _) => "> ⚙ ask".to_string(),
                (Some("toolCall"), Some("bash"), Some(command)) => {
                    let output = part.get("output").and_then(Value::as_str).map_or_else(String::new, |output| format!("\n{}", output.trim_end()));
                    let failed = if truthy(part.get("failed")) { " ✗" } else { "" };
                    format!("```\n$ {command}{failed}{output}\n```")
                }
                (Some("toolCall"), _, _) => {
                    let arguments = present(part, "arguments").map_or_else(|| "{}".to_string(), Value::to_string);
                    format!("> ⚙ {}({})", text_of(part.get("name")), truncate(&arguments, 120))
                }
                _ => text.to_string(),
            }
        };
        let lines: Vec<String> = items(message, "content").iter().map(line).filter(|line| !line.is_empty()).collect();
        format!("**{heading}:**\n\n{}", lines.join("\n"))
    };
    items(body, "messages").iter().map(message).collect::<Vec<_>>().join("\n\n")
}

/// A query value as a form writes it: letters, digits and `*-._` bare, a space as `+`.
fn form_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b' ' => out.push('+'),
            byte if byte.is_ascii_alphanumeric() || b"*-._".contains(&byte) => out.push(byte as char),
            byte => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `ghost show`: the conversation as Markdown. Without --offset, the newest
/// page: the daemon pages from the oldest, so a conversation longer than one
/// page is fetched again from its last page.
pub fn show_command(ctx: &mut Context) -> Result<i32, CliError> {
    let limit = ctx.parsed.text("limit").map(str::to_string);
    let offset = ctx.parsed.text("offset").map(str::to_string);
    let page = |ctx: &mut Context, from: Option<&str>| {
        let pairs: Vec<String> = [("limit", limit.as_deref()), ("offset", from)]
            .iter()
            .filter_map(|(key, value)| Some(format!("{key}={}", form_encode((*value)?))))
            .collect();
        let query = if pairs.is_empty() { String::new() } else { format!("?{}", pairs.join("&")) };
        ctx.request("GET", &format!("/api/conversation/transcript{query}"), None)
    };
    let count = |body: &Value| items(body, "messages").len() as i64;
    let total = |body: &Value| body.get("total").and_then(Value::as_i64).unwrap_or(0);
    let mut response = page(ctx, offset.as_deref())?;
    // The first message shown, counted from zero; None when --offset was not a number.
    let mut first = match &offset {
        Some(offset) => offset.trim().parse::<i64>().ok(),
        None => Some(0),
    };
    if offset.is_none() && truthy(response.get("truncated")) {
        let from = (total(&response) - count(&response)).max(0);
        first = Some(from);
        response = page(ctx, Some(&from.to_string()))?;
    }
    let number = |add: i64| first.map_or_else(|| "NaN".to_string(), |first| (first + add).to_string());
    ctx.emit(&response, || {
        let (total, count) = (total(&response), count(&response));
        if total == 0 {
            return Rendered::Both { human: "No messages.\n".to_string(), quiet: String::new() };
        }
        if count == 0 {
            return Rendered::Both { human: format!("(no messages from {}; {total} in all)\n", number(1)), quiet: String::new() };
        }
        let quiet = format!("{}\n", transcript_markdown(&response));
        let human = if truthy(response.get("truncated")) {
            format!("{quiet}\n(messages {}–{} of {total}; --offset/--limit for others)\n", number(1), number(count))
        } else {
            quiet.clone()
        };
        Rendered::Both { human, quiet }
    });
    Ok(EXIT_SUCCESS)
}

/// `ghost stop`: stop the running turn, whichever client started it.
pub fn stop_command(ctx: &mut Context) -> Result<i32, CliError> {
    let response = ctx.request("POST", "/api/conversation/stop", Some(&json!({})))?;
    ctx.emit(&response, || Rendered::Secondary("Stopped.\n".to_string()));
    Ok(EXIT_SUCCESS)
}

/// `ghost new --yes`: start over, the conversation so far moved to recoverable Trash.
pub fn new_command(ctx: &mut Context) -> Result<i32, CliError> {
    if !ctx.parsed.boolean("yes") {
        return Err(CliError::usage("ghost new requires --yes"));
    }
    let response = ctx.request("DELETE", "/api/conversation", None)?;
    ctx.emit(&response, || Rendered::Secondary("Started over; the conversation so far is in Trash.\n".to_string()));
    Ok(EXIT_SUCCESS)
}

// ── The persona, remote access, status ──────────────────────────────────

/// A verb's optional action and the argument after it; an empty argument counts as none.
fn action_and_file(ctx: &Context, default: &str) -> (String, Option<String>) {
    let action = ctx.parsed.positionals.first().cloned().unwrap_or_else(|| default.to_string());
    (action, ctx.parsed.positionals.get(1).filter(|file| !file.is_empty()).cloned())
}

/// `ghost character [set <file>]`: print or replace `character.md` through the daemon's validating writer.
pub fn character_command(ctx: &mut Context) -> Result<i32, CliError> {
    match action_and_file(ctx, "show") {
        (action, Some(_)) if action == "show" => Err(CliError::usage("ghost character show takes no further arguments")),
        (action, None) if action == "show" => {
            let body = ctx.request("GET", "/api/character", None)?;
            ctx.emit(&body, || primary(body.get("body").and_then(Value::as_str).unwrap_or("").to_string()));
            Ok(EXIT_SUCCESS)
        }
        (action, Some(file)) if action == "set" => {
            let text = read_argument_file(&file)?;
            let body = ctx.request("PUT", "/api/character", Some(&json!({ "body": text })))?;
            ctx.emit(&body, || Rendered::Secondary("Character replaced.\n".to_string()));
            Ok(EXIT_SUCCESS)
        }
        _ => Err(CliError::usage("ghost character takes `show` or `set <file>`")),
    }
}

/// `ghost status`: that the daemon answers and accepts the token, what it
/// runs, whether the code on disk has changed under it, and what the
/// conversation is doing.
pub fn status_command(ctx: &mut Context) -> Result<i32, CliError> {
    let ghost = ctx.request("GET", "/api/ghost", None)?.get("name").cloned();
    let remote = ctx.request("GET", "/api/remote", None)?;
    let daemon = ctx.request("GET", "/api/status", None)?;
    let conversation = ctx.request("GET", "/api/conversation", None)?;
    let now = crate::clock::now_ms();
    let client = ctx.client()?;
    let (base_url, token_file) = (client.base_url.clone(), client.token_path.display().to_string());
    let version = ctx.version.clone();
    let mut result = Map::new();
    let fields = [
        ("daemon", Some(json!(base_url))),
        ("tokenFile", Some(json!(token_file))),
        ("ghost", ghost.clone()),
        ("version", Some(json!(version))),
        ("daemonVersion", daemon.get("version").cloned()),
        ("source", daemon.get("source").cloned()),
        ("daemonStartedAt", daemon.get("startedAt").cloned()),
        ("restartNeeded", daemon.get("restartNeeded").cloned()),
        ("remote", Some(remote.clone())),
        ("conversation", Some(conversation.clone())),
    ];
    for (key, value) in fields {
        if let Some(value) = value {
            result.insert(key.to_string(), value);
        }
    }
    ctx.emit(&Value::Object(result), || {
        let source = |key: &str, fallback: &str| {
            daemon.get("source").and_then(|source| present(source, key)).map_or_else(|| fallback.to_string(), |found| text_of(Some(found)))
        };
        let mut lines = vec![
            format!("daemon         {base_url}"),
            format!("token file     {token_file}"),
            format!("ghost          {}", ghost.as_ref().filter(|name| !name.is_null()).map_or_else(|| "—".to_string(), |name| text_of(Some(name)))),
            format!("version        {version}"),
            format!("daemon version {}", text_of(daemon.get("version"))),
            format!("daemon commit  {}", source("commit", "unknown")),
            format!("daemon source  {}", source("root", "packaged install")),
            format!("daemon started {}", text_of(daemon.get("startedAt"))),
        ];
        // The code changed under a running daemon: what is on disk is not what answers.
        if truthy(daemon.get("restartNeeded")) {
            lines.push("restart needed code on disk is newer than this daemon (ghost help self)".to_string());
        }
        // Remote access is Tailscale Serve, the owner's to turn on: off names the command, on the app's link to this machine.
        let state = text_of(remote.get("state"));
        let url = if state == "on" && truthy(remote.get("hostname")) { format!(" {}", text_of(remote.get("hostname"))) } else { String::new() };
        let problem = present(&remote, "problem").map_or_else(String::new, |problem| format!(" ({})", text_of(problem.get("message"))));
        let turn_on = if state == "off" && problem.is_empty() { format!("; turn on: {}", text_of(remote.get("command"))) } else { String::new() };
        lines.push(format!("remote         {state}{url}{problem}{turn_on}"));
        if state == "on"
            && let Some(app) = present(&remote, "app").filter(|app| truthy(app.get("url")))
        {
            lines.push(format!("app            {}", text_of(app.get("url"))));
        }
        // The conversation: how long it is, when it last moved, and what it waits on.
        let mut said = match conversation.get("messageCount").and_then(Value::as_u64).unwrap_or(0) {
            0 => vec!["empty".to_string()],
            1 => vec!["1 message".to_string()],
            count => vec![format!("{count} messages")],
        };
        if let Some(updated) = conversation.get("updatedAt").and_then(Value::as_str) {
            said.push(format!("updated {}", relative_time(updated, now)));
        }
        let states = [("running", "running"), ("question", "asking"), ("unread", "unread")];
        said.extend(states.iter().filter(|(key, _)| truthy(conversation.get(*key))).map(|(_, word)| word.to_string()));
        lines.push(format!("conversation   {}", said.join(", ")));
        Rendered::Both { human: format!("{}\n", lines.join("\n")), quiet: "ok\n".to_string() }
    });
    Ok(EXIT_SUCCESS)
}

// ── Hooks ───────────────────────────────────────────────────────────────

/// A handler's default name and description, per event, in the order hooks are loaded.
const HOOK_EVENTS: &[(&str, &str, &str)] = &[("session_stop", "Session-stop command hook", "Runs after the assistant pass and may continue it.")];

fn display_text(value: Option<&Value>, fallback: &str, label: &str, maximum: usize) -> Result<String, CliError> {
    match value {
        None => Ok(fallback.to_string()),
        Some(Value::String(text)) if !text.trim().is_empty() && text.trim().chars().count() <= maximum => Ok(text.trim().to_string()),
        Some(_) => Err(CliError::failure(format!("{label} must be a non-empty string of at most {maximum} characters."))),
    }
}

/// The `(event, name, description)` of every hook in a `hooks.json` document,
/// admitted by the daemon's own rules and refusals, so `ghost hooks` never
/// lists what ghostd would not run.
fn hook_rows(document: &Value, path: &str) -> Result<Vec<Vec<String>>, CliError> {
    let fail = |message: String| Err(CliError::failure(message));
    let Some(top) = document.as_object() else { return fail(format!("{path} must contain a JSON object.")) };
    let stray: Vec<String> = top.keys().filter(|key| *key != "hooks").map(|key| Value::String(key.clone()).to_string()).collect();
    if !stray.is_empty() {
        return fail(format!("{path} has no top-level {}; send the document itself.", stray.join(", ")));
    }
    let Some(hooks) = top.get("hooks") else { return Ok(Vec::new()) };
    let Some(hooks) = hooks.as_object() else { return fail(format!("{path}: \"hooks\" must be an object.")) };
    if let Some(unknown) = hooks.keys().find(|key| !HOOK_EVENTS.iter().any(|(event, _, _)| event == key)) {
        return fail(format!("{path}: unsupported hook event {}.", Value::String(unknown.clone())));
    }
    let mut rows = Vec::new();
    for (event, default_name, default_description) in HOOK_EVENTS {
        let Some(groups) = hooks.get(*event) else { continue };
        let Some(groups) = groups.as_array() else { return fail(format!("{path}: \"hooks.{event}\" must be an array.")) };
        for (group_index, group) in groups.iter().enumerate() {
            let Some(handlers) = group.as_object().and_then(|group| group.get("hooks")).and_then(Value::as_array) else {
                return fail(format!("{path}: hooks.{event}[{group_index}].hooks must be an array."));
            };
            for (handler_index, raw) in handlers.iter().enumerate() {
                let label = format!("hooks.{event}[{group_index}].hooks[{handler_index}]");
                let command =
                    raw.as_object().filter(|raw| raw.get("type").and_then(Value::as_str) == Some("command")).and_then(|raw| raw.get("command"));
                if !command.and_then(Value::as_str).is_some_and(|command| !command.trim().is_empty() && !command.contains('\0')) {
                    return fail(format!("{path}: {label} must be a command hook with a non-empty NUL-free command."));
                }
                let timeout_ok = match raw.get("timeout") {
                    None => true,
                    Some(timeout) => timeout.as_f64().is_some_and(|seconds| seconds > 0.0 && seconds <= 600.0),
                };
                if !timeout_ok {
                    return fail(format!("{path}: {label}.timeout must be a number in (0, 600]."));
                }
                let name = display_text(raw.get("name"), default_name, &format!("{path}: {label}.name"), 80)?;
                let description = display_text(raw.get("description"), default_description, &format!("{path}: {label}.description"), 240)?;
                rows.push(vec![event.to_string(), name, description]);
            }
        }
    }
    Ok(rows)
}

/// `ghost hooks [status|show|set <file>]` over the daemon's `hooks.json`.
pub fn hooks_command(ctx: &mut Context) -> Result<i32, CliError> {
    let (action, file) = action_and_file(ctx, "status");
    let body = match (action.as_str(), file) {
        ("status" | "show", Some(_)) => return Err(CliError::usage(format!("ghost hooks {action} takes no further arguments"))),
        ("status" | "show", None) => ctx.request("GET", "/api/hooks/config", None)?,
        ("set", None) => return Err(CliError::usage("ghost hooks set needs a JSON file path")),
        ("set", Some(file)) => {
            let document = read_argument_json(&file)?;
            ctx.request("PUT", "/api/hooks/config", Some(&document))?
        }
        _ => return Err(CliError::usage(format!("ghost hooks does not know \"{action}\"; use status, show, or set."))),
    };
    let rendered = if ctx.parsed.boolean("json") {
        // --json prints the API body as it came, unexamined.
        Rendered::Secondary(String::new())
    } else if action == "show" {
        primary(format!("{}\n", serde_json::to_string_pretty(&body).unwrap_or_default()))
    } else {
        let path = text_of(body.get("path"));
        let rows = hook_rows(body.get("document").unwrap_or(&Value::Null), &path)?;
        if action == "set" {
            Rendered::Secondary(format!("Replaced {path} ({} {}).\n", rows.len(), if rows.len() == 1 { "hook" } else { "hooks" }))
        } else {
            Rendered::Both {
                human: if rows.is_empty() {
                    "No hooks configured.\n".to_string()
                } else {
                    format!("{}\n", table(&rows, Some(&["EVENT", "NAME", "DESCRIPTION"])))
                },
                quiet: rows.iter().map(|row| format!("{}\n", row[1])).collect(),
            }
        }
    };
    ctx.emit(&body, || rendered);
    Ok(EXIT_SUCCESS)
}
