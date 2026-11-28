//! Every verb but `say`: each asks the daemon one thing and prints the answer
//! as a table, a transcript, or one acknowledging sentence.
use super::common::{read_argument_file, read_argument_json};
use super::output::{Rendered, primary, relative_time, table, truncate};
use super::{CliError, Context, EXIT_SUCCESS};
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
                    let failed = if part["failed"] == true { " ✗" } else { "" };
                    format!("```\n$ {command}{failed}{output}\n```")
                }
                (Some("toolCall"), name, _) => {
                    let arguments = part.get("arguments").filter(|arguments| !arguments.is_null()).map_or_else(|| "{}".to_string(), Value::to_string);
                    format!("> ⚙ {}({})", name.unwrap_or("tool"), truncate(&arguments, 120))
                }
                _ => text.to_string(),
            }
        };
        let lines: Vec<String> = items(message, "content").iter().map(line).filter(|line| !line.is_empty()).collect();
        format!("**{heading}:**\n\n{}", lines.join("\n"))
    };
    items(body, "messages").iter().map(message).collect::<Vec<_>>().join("\n\n")
}

/// `ghost show`: the conversation as Markdown. Without --offset, the newest
/// page: the daemon pages from the oldest, so a conversation longer than one
/// page is fetched again from its last page.
pub fn show_command(ctx: &mut Context) -> Result<i32, CliError> {
    let (limit, offset) = (ctx.parsed.number("limit")?, ctx.parsed.number("offset")?);
    let page = |ctx: &mut Context, from: Option<u64>| {
        let pairs: Vec<String> =
            [("limit", limit), ("offset", from)].iter().filter_map(|(key, value)| Some(format!("{key}={}", (*value)?))).collect();
        let query = if pairs.is_empty() { String::new() } else { format!("?{}", pairs.join("&")) };
        ctx.request("GET", &format!("/api/conversation/transcript{query}"), None)
    };
    let count = |body: &Value| items(body, "messages").len() as u64;
    let total = |body: &Value| body["total"].as_u64().unwrap_or(0);
    let mut response = page(ctx, offset)?;
    // The first message shown, counted from zero.
    let mut first = offset.unwrap_or(0);
    if offset.is_none() && response["truncated"] == true {
        first = total(&response).saturating_sub(count(&response));
        response = page(ctx, Some(first))?;
    }
    ctx.emit(&response, || {
        let (total, count) = (total(&response), count(&response));
        if total == 0 {
            return Rendered::Both { human: "No messages.\n".to_string(), quiet: String::new() };
        }
        if count == 0 {
            return Rendered::Both { human: format!("(no messages from {}; {total} in all)\n", first + 1), quiet: String::new() };
        }
        let quiet = format!("{}\n", transcript_markdown(&response));
        let human = if response["truncated"] == true {
            format!("{quiet}\n(messages {}–{} of {total}; --offset/--limit for others)\n", first + 1, first + count)
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
    let there = ctx.elsewhere()?;
    ctx.emit(&response, || Rendered::Secondary(format!("Started over; the conversation so far is in Trash{there}.\n")));
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
/// runs, whether the code on disk has changed under it, where the ghost's
/// topic documents are and how many, and what the conversation is doing.
/// Of a ghost on another machine it leads with the address, and every line
/// about that machine says so.
pub fn status_command(ctx: &mut Context) -> Result<i32, CliError> {
    let about = ctx.request("GET", "/api/ghost", None)?;
    let (ghost, topics) = (about.get("name").cloned(), about.get("topics").cloned());
    let remote = ctx.request("GET", "/api/remote", None)?;
    let daemon = ctx.request("GET", "/api/status", None)?;
    let conversation = ctx.request("GET", "/api/conversation", None)?;
    let now = crate::clock::now_ms();
    let client = ctx.client()?;
    let (base_url, token_file) = (client.base_url(), client.token_path().map(|path| path.display().to_string()));
    let machine = client.machine().map(str::to_string);
    let version = crate::VERSION;
    let mut result = Map::new();
    let fields = [
        ("daemon", Some(json!(base_url))),
        ("machine", machine.as_ref().map(|machine| json!(machine))),
        ("tokenFile", token_file.as_ref().map(|file| json!(file))),
        ("ghost", ghost.clone()),
        ("topics", topics.clone()),
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
        // What the daemon left out or sent as null is a dash.
        let text = |value: &Value| value.as_str().unwrap_or("—").to_string();
        let topics = topics.as_ref().and_then(|topics| Some(format!("{} in {}", topics["count"].as_u64()?, topics["path"].as_str()?)));
        // Where a line is about the ghost's machine and that is not this one, it says which.
        let there = machine.as_ref().map_or_else(String::new, |machine| format!(" (on {machine})"));
        let mut lines = match &token_file {
            Some(token_file) => vec![format!("daemon         {base_url}"), format!("token file     {token_file}")],
            None => vec![format!("ghost at       {base_url}")],
        };
        lines.extend([
            format!("ghost          {}", ghost.as_ref().map_or_else(|| "—".to_string(), text)),
            // The ghost's topic documents: plain files, the owner's to read, edit and delete.
            format!("topics         {}{there}", topics.unwrap_or_else(|| "—".to_string())),
            format!("version        {version}{}", if machine.is_some() { " (this machine)" } else { "" }),
            format!("daemon version {}{there}", text(&daemon["version"])),
            format!("daemon commit  {}{there}", daemon["source"]["commit"].as_str().unwrap_or("unknown")),
            format!("daemon source  {}{there}", daemon["source"]["root"].as_str().unwrap_or("packaged install")),
            format!("daemon started {}{there}", text(&daemon["startedAt"])),
        ]);
        // The code changed under a running daemon: what is on disk is not what answers.
        if daemon["restartNeeded"] == true {
            lines.push(format!("restart needed code on disk is newer than this daemon (ghost help self){there}"));
        }
        // Remote access is Tailscale Serve, the owner's to turn on: off names the command, on the app's link to this machine.
        let state = text(&remote["state"]);
        let mut line = format!("remote         {state}");
        if let Some(hostname) = remote["hostname"].as_str().filter(|_| state == "on") {
            line.push_str(&format!(" {hostname}"));
        }
        match (remote["problem"]["message"].as_str(), remote["command"].as_str()) {
            (Some(problem), _) => line.push_str(&format!(" ({problem})")),
            (None, Some(command)) if state == "off" => {
                let place = machine.as_ref().map_or_else(String::new, |machine| format!("on {machine}, "));
                line.push_str(&format!("; {place}turn on: {command}"));
            }
            _ => {}
        }
        lines.push(line);
        if let Some(url) = remote["app"]["url"].as_str().filter(|_| state == "on") {
            lines.push(format!("app            {url}"));
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
        let states = [
            (conversation["running"] == true, "running"),
            (!conversation["question"].is_null(), "asking"),
            (conversation["unread"] == true, "unread"),
        ];
        said.extend(states.iter().filter(|(holds, _)| *holds).map(|(_, word)| word.to_string()));
        lines.push(format!("conversation   {}", said.join(", ")));
        Rendered::Both { human: format!("{}\n", lines.join("\n")), quiet: "ok\n".to_string() }
    });
    Ok(EXIT_SUCCESS)
}

// ── Hooks ───────────────────────────────────────────────────────────────

/// The `(event, name, description)` of every hook in a `hooks.json` document,
/// admitted by the daemon's own rules and refusals, so `ghost hooks` never
/// lists what ghostd would not run.
fn hook_rows(document: &Value, path: &str) -> Result<Vec<Vec<String>>, CliError> {
    let hooks = crate::hooks::parse_hooks_document(document, path).map_err(CliError::failure)?;
    Ok(hooks.into_iter().map(|hook| vec![crate::hooks::SESSION_STOP.to_string(), hook.name, hook.description]).collect())
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
    let there = ctx.elsewhere()?;
    let rendered = if ctx.parsed.boolean("json") {
        // --json prints the API body as it came, unexamined.
        Rendered::Secondary(String::new())
    } else if action == "show" {
        primary(format!("{}\n", serde_json::to_string_pretty(&body).unwrap_or_default()))
    } else {
        let path = body["path"].as_str().unwrap_or("hooks.json");
        let rows = hook_rows(&body["document"], path)?;
        if action == "set" {
            Rendered::Secondary(format!("Replaced {path}{there} ({} {}).\n", rows.len(), if rows.len() == 1 { "hook" } else { "hooks" }))
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
