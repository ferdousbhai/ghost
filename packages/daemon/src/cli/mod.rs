//! The `ghost` command line, a client of the daemon's HTTP API, and
//! `ghostd hook-complete`. CONTRACTS.md ("`ghost` CLI") is the contract; the
//! verbs, flags, sentences and exit codes here are text a ghost's prompt and
//! the owner's scripts rely on. Nothing in this tree reads the process's
//! environment, home or streams: they come in through [`CliRuntime`].
mod args;
mod client;
mod commands;
mod common;
mod hook_complete;
mod output;
mod say;
#[cfg(test)]
mod tests;

use crate::env::Env;
use crate::help_topics::{HELP_TOPICS, render_help_topic};
use args::{ArgsSpec, ParsedArgs, parse_args};
use client::{DaemonClient, EXIT_CODES, EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE};
pub use hook_complete::{hook_complete_command, parse_hook_complete_input};
use output::{CommandDocumentation, Rendered, render_command_help, render_exit_codes, render_usage};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::Path;

/// Where a command's piped input comes from.
pub enum Stdin<'a> {
    /// The whole input, already read (tests, and callers that hold it).
    Text(String),
    /// A stream to read to its end, and whether it is a terminal: a command
    /// never waits on a terminal for text nobody was asked to type.
    Stream { reader: Box<dyn Read + 'a>, is_tty: bool },
}

/// Everything a command may touch of the process it runs in.
pub struct CliRuntime<'a> {
    pub env: &'a Env,
    pub home: &'a Path,
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
    pub stdin: Stdin<'a>,
    /// Tool activity is dimmed only when stdout is a terminal.
    pub stdout_is_tty: bool,
}

/// A failure with the exit code it ends the command with. `code` is the
/// daemon's error code when the failure was an HTTP error body.
#[derive(Debug, Clone)]
pub(crate) struct CliError {
    pub exit_code: i32,
    pub message: String,
    pub code: Option<String>,
}

impl CliError {
    pub fn new(exit_code: i32, message: impl Into<String>) -> Self {
        Self { exit_code, message: message.into(), code: None }
    }
    /// A command line that cannot be run as written (exit 2).
    pub fn usage(message: impl Into<String>) -> Self {
        Self::new(EXIT_USAGE, message)
    }
    /// Anything else that went wrong (exit 1).
    pub fn failure(message: impl Into<String>) -> Self {
        Self::new(EXIT_FAILURE, message)
    }
}

/// One command's run: its arguments, the runtime, and the daemon client,
/// which is made on first use so a verb that needs no daemon never looks for one.
pub(crate) struct Context<'r, 'a> {
    pub parsed: ParsedArgs,
    pub runtime: &'r mut CliRuntime<'a>,
    pub version: String,
    client: Option<DaemonClient>,
}

impl Context<'_, '_> {
    pub fn client(&mut self) -> Result<&mut DaemonClient, CliError> {
        if self.client.is_none() {
            self.client = Some(DaemonClient::new(self.runtime.env, self.runtime.home)?);
        }
        Ok(self.client.as_mut().expect("just set"))
    }

    /// A control request to the daemon.
    pub fn request(&mut self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, CliError> {
        self.client()?.request(method, path, body)
    }

    pub fn out(&mut self, text: &str) {
        output::write(self.runtime.stdout, text);
    }

    pub fn err(&mut self, text: &str) {
        output::write(self.runtime.stderr, text);
    }

    /// Print a result: the API body under `--json`, else what `render` makes
    /// of it, of which `-q` keeps only the primary part.
    pub fn emit(&mut self, body: &Value, render: impl FnOnce() -> Rendered) {
        if self.parsed.boolean("json") {
            output::write_json(self.runtime.stdout, body);
            return;
        }
        let quiet = self.parsed.boolean("quiet");
        let text = match render() {
            Rendered::Secondary(_) if quiet => String::new(),
            Rendered::Secondary(text) => text,
            Rendered::Both { human, quiet: kept } => {
                if quiet {
                    kept
                } else {
                    human
                }
            }
        };
        if !text.is_empty() {
            self.out(&text);
        }
    }
}

type Run = fn(&mut Context) -> Result<i32, CliError>;

struct Command {
    doc: CommandDocumentation,
    /// The fewest and the most positionals after the verb.
    positionals: (usize, usize),
    /// Flags this verb alone accepts, on top of the common ones and the `-s` its usage lists.
    boolean: &'static [&'static str],
    value: &'static [&'static str],
    run: Run,
}

impl Command {
    /// The common flags plus this verb's own; `-s` only where its usage lists
    /// it, so a stray one is the unknown option it is, not silently ignored.
    fn args(&self) -> ArgsSpec {
        let mut spec = ArgsSpec { boolean: vec!["version"], value: Vec::new() };
        spec.boolean.extend(self.boolean);
        if self.doc.usage.contains("-s <id>") {
            spec.value.push("session");
        }
        spec.value.extend(self.value);
        spec
    }
}

/// The command catalog, in the order the usage screen lists it.
fn commands() -> Vec<Command> {
    let command = |verb, usage: &str, summary, example, positionals, boolean, value, run| Command {
        doc: CommandDocumentation { verb, usage: usage.to_string(), summary, example },
        positionals,
        boolean,
        value,
        run,
    };
    let none: &[&str] = &[];
    vec![
        command(
            "say",
            "say [text] [--new|--follow-up] [-s <id>] [--json] [-q]",
            "Send a turn, or follow up on one.",
            "ghost say --new \"Start fresh\"",
            (0, usize::MAX),
            &["new", "follow-up"],
            none,
            say::say_command as Run,
        ),
        command(
            "stop",
            "stop [-s <id>] [--json] [-q]",
            "Stop a conversation's running turn.",
            "ghost stop -s cli-abc",
            (0, 0),
            none,
            none,
            commands::stop_command,
        ),
        command(
            "rm",
            "rm -s <id> --yes [--json] [-q]",
            "Move a conversation to recoverable Trash.",
            "ghost rm -s cli-abc --yes",
            (0, 0),
            &["yes"],
            none,
            commands::remove_command,
        ),
        command("sessions", "sessions [--json] [-q]", "List conversations.", "ghost sessions --json", (0, 0), none, none, commands::sessions_command),
        command(
            "show",
            "show [-s <id>] [--limit <n>] [--offset <n>] [--json] [-q]",
            "Print a conversation transcript as Markdown: its newest page, or the page from --offset (counted from the oldest).",
            "ghost show -s cli-abc",
            (0, 0),
            none,
            &["limit", "offset"],
            commands::show_command,
        ),
        command(
            "title",
            "title <text> [-s <id>] [--json] [-q]",
            "Rename a conversation.",
            "ghost title \"Release notes\" -s cli-abc",
            (1, 1),
            none,
            none,
            commands::title_command,
        ),
        command("pin", "pin [-s <id>] [--json] [-q]", "Pin a conversation.", "ghost pin -s cli-abc", (0, 0), none, none, commands::pin_command),
        command(
            "unpin",
            "unpin [-s <id>] [--json] [-q]",
            "Unpin a conversation.",
            "ghost unpin -s cli-abc",
            (0, 0),
            none,
            none,
            commands::unpin_command,
        ),
        command(
            "hooks",
            "hooks [status|show|set <hooks.json>] [--json] [-q]",
            "Show or replace the owner's hooks.json.",
            "ghost hooks show",
            (0, 2),
            none,
            none,
            commands::hooks_command,
        ),
        command(
            "character",
            "character [show|set <file>] [--json] [-q]",
            "Print or replace the persona file.",
            "ghost character set ./casper.md",
            (0, 2),
            none,
            none,
            commands::character_command,
        ),
        command(
            "read",
            "read [-s <id>] [--json] [-q]",
            "Mark a conversation read.",
            "ghost read -s cli-abc",
            (0, 0),
            none,
            none,
            commands::read_command,
        ),
        command(
            "status",
            "status [--json] [-q]",
            "Check daemon connectivity and authentication.",
            "ghost status --json",
            (0, 0),
            none,
            none,
            commands::status_command,
        ),
        command(
            "help",
            &format!("help [command|exit-codes|{}]", HELP_TOPICS.join("|")),
            "Show command help, the exit-code table, or one recipe the ghost's prompt points at.",
            "ghost help memory",
            (0, 1),
            none,
            none,
            help_command,
        ),
    ]
}

fn usage_text(commands: &[Command]) -> String {
    render_usage(&commands.iter().map(|command| &command.doc).collect::<Vec<_>>())
}

/// `ghost help [command|exit-codes|<topic>]`; none of it needs the daemon.
fn help_command(ctx: &mut Context) -> Result<i32, CliError> {
    let commands = commands();
    let text = match ctx.parsed.positionals.first().map(String::as_str) {
        None => usage_text(&commands),
        Some(topic) => match render_help_topic(topic) {
            Some(recipe) => recipe,
            None if topic == "exit-codes" => render_exit_codes(EXIT_CODES),
            None => {
                let command = commands
                    .iter()
                    .find(|candidate| candidate.doc.verb == topic)
                    .ok_or_else(|| CliError::usage(format!("Unknown help topic: {topic}")))?;
                render_command_help(&command.doc)
            }
        },
    };
    ctx.out(&text);
    Ok(EXIT_SUCCESS)
}

/// `$GHOSTD_VERSION` from the runtime's environment when set (the test seam), else this build's.
fn version(env: &Env) -> String {
    crate::env::var(env, "GHOSTD_VERSION").unwrap_or(crate::VERSION).to_string()
}

fn dispatch(argv: &[String], runtime: &mut CliRuntime) -> Result<i32, CliError> {
    let commands = commands();
    // Two passes: the first knows every verb's flags and is trusted only for the
    // verb, the second holds that verb to its own, so another verb's flag is
    // the unknown option it is.
    let mut every = ArgsSpec::default();
    for spec in commands.iter().map(Command::args) {
        every.boolean.extend(spec.boolean);
        every.value.extend(spec.value);
    }
    let scouted = parse_args(argv, &every)?;
    if scouted.boolean("version") {
        output::write(runtime.stdout, &format!("{}\n", version(runtime.env)));
        return Ok(EXIT_SUCCESS);
    }
    let Some(verb) = scouted.positionals.first() else {
        output::write(runtime.stdout, &usage_text(&commands));
        return Ok(EXIT_SUCCESS);
    };
    let command = commands.iter().find(|candidate| candidate.doc.verb == verb).ok_or_else(|| CliError::usage(format!("Unknown command: {verb}")))?;
    let mut parsed = parse_args(argv, &command.args())?;
    parsed.positionals.remove(0);
    if parsed.boolean("help") {
        output::write(runtime.stdout, &render_command_help(&command.doc));
        return Ok(EXIT_SUCCESS);
    }
    let (minimum, maximum) = command.positionals;
    if parsed.positionals.len() < minimum || parsed.positionals.len() > maximum {
        return Err(CliError::usage(format!("Usage: ghost {}", command.doc.usage)));
    }
    let version = version(runtime.env);
    (command.run)(&mut Context { parsed, runtime, version, client: None })
}

/// The whole `ghost` command: run `args` (without the program name) and
/// return the exit code. A failure is one `ghost: <why>` line on stderr.
pub fn ghost_cli(args: &[String], mut runtime: CliRuntime) -> i32 {
    match dispatch(args, &mut runtime) {
        Ok(code) => code,
        Err(error) => {
            output::write(runtime.stderr, &format!("ghost: {}\n", error.message));
            error.exit_code
        }
    }
}
