//! Every verb but `say`: each asks the daemon one thing and prints the answer
//! as a table, a transcript, or one acknowledging sentence.
use super::client::{EXIT_FAILURE, EXIT_SUCCESS};
use super::common::{id_of, list_sessions, read_argument_file, read_argument_json, resolve_target};
use super::output::{Rendered, present, primary, relative_time, table, text_of, truncate, truthy, write_json};
use super::{CliError, Context};
use serde_json::{Map, Value, json};

// ── Conversations ───────────────────────────────────────────────────────

/// `ghost sessions`: every conversation; `-q` prints the ids alone.
pub fn sessions_command(ctx: &mut Context) -> Result<i32, CliError> {
    let sessions = list_sessions(ctx.client()?)?;
    let now = crate::clock::now_ms();
    ctx.emit(&json!({ "sessions": sessions }), || {
        let rows: Vec<Vec<String>> = sessions
            .iter()
            .map(|session| {
                let label = present(session, "title").or_else(|| present(session, "preview"));
                let states = [("question", "asking"), ("running", "running"), ("unread", "unread"), ("pinned", "pinned")];
                vec![
                    id_of(session).to_string(),
                    truncate(&label.map_or_else(|| "—".to_string(), |label| text_of(Some(label))), 42),
                    relative_time(session.get("updatedAt").and_then(Value::as_str).unwrap_or(""), now),
                    text_of(session.get("messageCount")),
                    states.iter().filter(|(key, _)| truthy(session.get(*key))).map(|(_, word)| *word).collect::<Vec<_>>().join(","),
                ]
            })
            .collect();
        Rendered::Both {
            human: if rows.is_empty() {
                "No conversations.\n".to_string()
            } else {
                format!("{}\n", table(&rows, Some(&["ID", "TITLE", "UPDATED", "MESSAGES", "STATE"])))
            },
            quiet: sessions.iter().map(|session| format!("{}\n", id_of(session))).collect(),
        }
    });
    Ok(EXIT_SUCCESS)
}

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
        let line = |part: &Value| {
            if part.get("type").and_then(Value::as_str) == Some("toolCall") && part.get("name").and_then(Value::as_str) == Some("ask") {
                // The question and its answers are the text that follows.
                "> ⚙ ask".to_string()
            } else if part.get("type").and_then(Value::as_str) == Some("toolCall") {
                let arguments = present(part, "arguments").map_or_else(|| "{}".to_string(), Value::to_string);
                format!("> ⚙ {}({})", text_of(part.get("name")), truncate(&arguments, 120))
            } else {
                part.get("text").and_then(Value::as_str).unwrap_or("").to_string()
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

/// `ghost show`: a transcript as Markdown. Without --offset, the newest page:
/// the daemon pages from the oldest, so a conversation longer than one page
/// is fetched again from its last page.
pub fn show_command(ctx: &mut Context) -> Result<i32, CliError> {
    let (_, path) = resolve_target(ctx)?;
    let limit = ctx.parsed.text("limit").map(str::to_string);
    let offset = ctx.parsed.text("offset").map(str::to_string);
    let page = |ctx: &mut Context, from: Option<&str>| {
        let pairs: Vec<String> = [("limit", limit.as_deref()), ("offset", from)]
            .iter()
            .filter_map(|(key, value)| Some(format!("{key}={}", form_encode((*value)?))))
            .collect();
        let query = if pairs.is_empty() { String::new() } else { format!("?{}", pairs.join("&")) };
        ctx.request("GET", &format!("{path}/transcript{query}"), None)
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

/// One request about the addressed conversation, acknowledged in one sentence.
fn session_action(
    ctx: &mut Context,
    method: &str,
    suffix: &str,
    body: Option<Value>,
    sentence: impl FnOnce(&str, &Value) -> String,
) -> Result<i32, CliError> {
    let (id, path) = resolve_target(ctx)?;
    let response = ctx.request(method, &format!("{path}{suffix}"), body.as_ref())?;
    ctx.emit(&response, || Rendered::Secondary(sentence(&id, &response)));
    Ok(EXIT_SUCCESS)
}

/// `ghost stop`: stop a conversation's running turn, whichever client started it.
pub fn stop_command(ctx: &mut Context) -> Result<i32, CliError> {
    session_action(ctx, "POST", "/stop", Some(json!({})), |id, _| format!("Stopped {id}.\n"))
}

/// `ghost read`: mark a conversation read.
pub fn read_command(ctx: &mut Context) -> Result<i32, CliError> {
    session_action(ctx, "PUT", "/read", Some(json!({})), |id, _| format!("Marked {id} read.\n"))
}

/// `ghost title <text>`: rename a conversation; the sentence quotes the title the daemon kept.
pub fn title_command(ctx: &mut Context) -> Result<i32, CliError> {
    let asked = Value::String(ctx.parsed.positionals[0].clone());
    session_action(ctx, "PUT", "/title", Some(json!({ "title": asked })), |id, body| {
        format!("Conversation {id} is now titled {}.\n", present(body, "title").unwrap_or(&asked))
    })
}

pub fn pin_command(ctx: &mut Context) -> Result<i32, CliError> {
    session_action(ctx, "PUT", "/pin", Some(json!({ "pinned": true })), |id, _| format!("Pinned {id}.\n"))
}

pub fn unpin_command(ctx: &mut Context) -> Result<i32, CliError> {
    session_action(ctx, "PUT", "/pin", Some(json!({ "pinned": false })), |id, _| format!("Unpinned {id}.\n"))
}

/// `ghost ask`: ask the owner something in a conversation and wait for their
/// next message there: the question, then up to six suggested answers.
/// `--clear` withdraws an open question unanswered. In a ghost's own shell
/// `$GHOST_SESSION` names the conversation.
pub fn ask_command(ctx: &mut Context) -> Result<i32, CliError> {
    let clear = ctx.parsed.boolean("clear");
    let question = ctx.parsed.positionals.first().cloned();
    match (clear, question) {
        (true, Some(_)) => Err(CliError::usage("ask --clear takes no question.")),
        (false, None) => Err(CliError::usage("ask needs a question.")),
        (true, None) => session_action(ctx, "DELETE", "/question", None, |id, _| format!("Cleared the question in {id}.\n")),
        (false, Some(text)) => {
            let body = json!({ "text": text, "options": ctx.parsed.positionals[1..] });
            session_action(ctx, "PUT", "/question", Some(body), |id, _| format!("Asked in {id}; the owner's next message there is the answer.\n"))
        }
    }
}

/// `ghost rm -s <id> --yes`: move one conversation to recoverable Trash.
pub fn remove_command(ctx: &mut Context) -> Result<i32, CliError> {
    if !ctx.parsed.boolean("yes") {
        return Err(CliError::usage("ghost rm requires --yes"));
    }
    if ctx.parsed.text("session").is_none() {
        return Err(CliError::usage("ghost rm needs -s <id>"));
    }
    session_action(ctx, "DELETE", "", None, |id, _| format!("Trashed {id}.\n"))
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

/// `ghost remote [status|on|off]`: a change that leaves the state other than asked exits 1, saying why.
pub fn remote_command(ctx: &mut Context) -> Result<i32, CliError> {
    let action = ctx.parsed.positionals.first().cloned().unwrap_or_else(|| "status".to_string());
    if !["status", "on", "off"].contains(&action.as_str()) {
        return Err(CliError::usage(format!("ghost remote does not know \"{action}\"; use status, on, or off.")));
    }
    let status = if action == "status" {
        ctx.request("GET", "/api/remote", None)?
    } else {
        ctx.request("POST", "/api/remote", Some(&json!({ "enabled": action == "on" })))?
    };
    let state = text_of(status.get("state"));
    let hostname = text_of(status.get("hostname"));
    let problem = present(&status, "problem");
    let problem_message = problem.map(|problem| text_of(problem.get("message")));
    let app_lines = match (state == "on", present(&status, "app")) {
        (false, _) => String::new(),
        (true, None) => "no app: remote.apps is empty, so nothing can reach Ghost remotely\n".to_string(),
        (true, Some(app)) if truthy(app.get("url")) => format!("app {}\n", text_of(app.get("url"))),
        (true, Some(_)) => String::new(),
    };
    if action == "status" {
        ctx.emit(&status, || {
            let shown = if state == "on" { format!("on {hostname}") } else { state.clone() };
            let why = problem_message.map_or_else(String::new, |message| format!(" ({message})"));
            Rendered::Both { human: format!("{shown}{why}\n{app_lines}"), quiet: format!("{state}\n") }
        });
        return Ok(EXIT_SUCCESS);
    }
    if problem.is_some() || state != action {
        if ctx.parsed.boolean("json") {
            write_json(ctx.runtime.stdout, &status);
        }
        let why = match (problem, problem_message) {
            (Some(problem), Some(message)) if truthy(problem.get("action")) => format!("{message} ({})", text_of(problem.get("action"))),
            (_, Some(message)) => message,
            _ => format!("ghostd did not turn it {action}"),
        };
        ctx.err(&format!("ghost: remote access is {state}: {why}\n"));
        return Ok(EXIT_FAILURE);
    }
    ctx.emit(&status, || {
        let now = if action == "on" { format!("on at {hostname}") } else { "off".to_string() };
        Rendered::Secondary(format!("Remote access is {now}.\n{app_lines}"))
    });
    Ok(EXIT_SUCCESS)
}

/// `ghost status`: that the daemon answers and accepts the token, what it
/// runs, and whether the code on disk has changed under it.
pub fn status_command(ctx: &mut Context) -> Result<i32, CliError> {
    let ghost = ctx.request("GET", "/api/ghost", None)?.get("name").cloned();
    let remote = ctx.request("GET", "/api/remote", None)?;
    let daemon = ctx.request("GET", "/api/status", None)?;
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
        let state = text_of(remote.get("state"));
        let url = if state == "on" && truthy(remote.get("hostname")) { format!(" {}", text_of(remote.get("hostname"))) } else { String::new() };
        let problem = present(&remote, "problem").map_or_else(String::new, |problem| format!(" ({})", text_of(problem.get("message"))));
        lines.push(format!("remote         {state}{url}{problem}"));
        Rendered::Both { human: format!("{}\n", lines.join("\n")), quiet: "ok\n".to_string() }
    });
    Ok(EXIT_SUCCESS)
}

// ── Hooks ───────────────────────────────────────────────────────────────

/// A handler's default name and description, per event, in the order hooks are loaded.
const HOOK_EVENTS: &[(&str, &str, &str)] = &[
    ("session_stop", "Session-stop command hook", "Runs after the assistant pass and may continue it."),
    ("turn_end", "Turn-end command hook", "Observes final turn success or failure without continuing it."),
];

fn display_text(value: Option<&Value>, fallback: &str, label: &str, maximum: usize) -> Result<String, CliError> {
    match value {
        None => Ok(fallback.to_string()),
        Some(Value::String(text)) if !text.trim().is_empty() && text.trim().encode_utf16().count() <= maximum => Ok(text.trim().to_string()),
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
