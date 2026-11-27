//! The `ghost` command line, a client of the daemon's HTTP API, and
//! `ghostd hook-complete`. CONTRACTS.md ("`ghost` CLI") is the contract; the
//! verbs, flags, sentences and exit codes here are text a ghost's prompt and
//! the owner's scripts rely on. Nothing in this tree reads the process's
//! environment, home or streams: they come in through [`CliRuntime`].
mod args;
mod commands;
mod common;
mod hook_complete;
mod output;
mod say;
#[cfg(test)]
mod tests;

use crate::client::{CONTROL_TIMEOUT, Client, ClientError};
use crate::env::Env;
use crate::help_topics::{HELP_TOPICS, render_help_topic};
use args::{COMMON, ParsedArgs, parse_args};
pub use hook_complete::hook_complete_command;
use output::{CommandDocumentation, Rendered, render_command_help, render_exit_codes, render_usage};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

const EXIT_SUCCESS: i32 = 0;
const EXIT_FAILURE: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_UNREACHABLE: i32 = 3;
const EXIT_UNAUTHORIZED: i32 = 4;
const EXIT_NOT_FOUND: i32 = 5;
const EXIT_CONFLICT: i32 = 6;
const EXIT_INTERRUPTED: i32 = 130;

/// Every exit code and what it means, as `ghost help exit-codes` prints them.
const EXIT_CODES: &[(i32, &str)] = &[
    (EXIT_SUCCESS, "success"),
    (EXIT_FAILURE, "turn or action failed"),
    (EXIT_USAGE, "usage error"),
    (EXIT_UNREACHABLE, "daemon unreachable"),
    (EXIT_UNAUTHORIZED, "unauthorized"),
    (EXIT_NOT_FOUND, "not found"),
    (EXIT_CONFLICT, "busy or conflict"),
    (EXIT_INTERRUPTED, "interrupted at the terminal (Ctrl-C)"),
];

/// A command's piped input: a stream to read to its end, and whether it is a
/// terminal, since a command never waits on one for text nobody was asked to type.
pub struct Stdin<'a> {
    pub reader: Box<dyn Read + 'a>,
    pub is_tty: bool,
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

/// A failure with the exit code it ends the command with.
#[derive(Debug)]
pub(crate) struct CliError {
    pub exit_code: i32,
    pub message: String,
}

impl CliError {
    /// A command line that cannot be run as written (exit 2).
    pub fn usage(message: impl Into<String>) -> Self {
        Self { exit_code: EXIT_USAGE, message: message.into() }
    }
    /// Anything else that went wrong (exit 1).
    pub fn failure(message: impl Into<String>) -> Self {
        Self { exit_code: EXIT_FAILURE, message: message.into() }
    }
}

/// The client's failure as this command line's sentence and exit code.
impl From<ClientError> for CliError {
    fn from(error: ClientError) -> Self {
        let exit_code = match &error {
            ClientError::Unreachable(_) => EXIT_UNREACHABLE,
            ClientError::Unauthorized { .. } | ClientError::Status { status: 403, .. } => EXIT_UNAUTHORIZED,
            ClientError::Status { status: 404, .. } => EXIT_NOT_FOUND,
            ClientError::Status { status: 409, .. } => EXIT_CONFLICT,
            ClientError::Configuration(_) => EXIT_USAGE,
            ClientError::Status { .. } | ClientError::Protocol(_) => EXIT_FAILURE,
        };
        Self { exit_code, message: error.to_string() }
    }
}

/// One command's run: its arguments, the runtime, and the daemon client,
/// which is made on first use so a verb that needs no daemon never looks for one.
pub(crate) struct Context<'r, 'a> {
    pub parsed: ParsedArgs,
    pub runtime: &'r mut CliRuntime<'a>,
    /// How long a control request may take.
    pub timeout: Duration,
    client: Option<Client>,
}

impl Context<'_, '_> {
    pub fn client(&mut self) -> Result<&mut Client, CliError> {
        if self.client.is_none() {
            self.client = Some(Client::discover(self.runtime.env, self.runtime.home)?);
        }
        Ok(self.client.as_mut().expect("just set"))
    }

    /// A control request to the daemon.
    pub fn request(&mut self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, CliError> {
        let timeout = self.timeout;
        Ok(self.client()?.request(method, path, body, Some(timeout))?)
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
    /// Flags this verb alone accepts, on top of the common ones.
    boolean: &'static [&'static str],
    value: &'static [&'static str],
    run: Run,
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
            "say [text] [--follow-up] [--json] [-q]",
            "Send a turn, or follow up on the running one.",
            "ghost say \"What is on today?\"",
            (0, usize::MAX),
            &["follow-up"],
            none,
            say::say_command as Run,
        ),
        command("stop", "stop [--json] [-q]", "Stop the running turn.", "ghost stop", (0, 0), none, none, commands::stop_command),
        command(
            "show",
            "show [--limit <n>] [--offset <n>] [--json] [-q]",
            "Print the conversation as Markdown: its newest page, or the page from --offset (counted from the oldest).",
            "ghost show --limit 20",
            (0, 0),
            none,
            &["limit", "offset"],
            commands::show_command,
        ),
        command(
            "new",
            "new --yes [--json] [-q]",
            "Start over: move the conversation to recoverable Trash.",
            "ghost new --yes",
            (0, 0),
            &["yes"],
            none,
            commands::new_command,
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
            "status",
            "status [--json] [-q]",
            "Check the daemon, and say what the conversation is doing.",
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

fn dispatch(argv: &[String], runtime: &mut CliRuntime, timeout: Duration) -> Result<i32, CliError> {
    let commands = commands();
    // Every verb's flags are known while the verb is found; the verb is then
    // held to its own, so another verb's flag is the unknown option it is.
    let every =
        |flags: fn(&Command) -> &'static [&'static str]| commands.iter().flat_map(|command| flags(command).iter().copied()).collect::<Vec<_>>();
    let mut parsed = parse_args(argv, &every(|command| command.boolean), &every(|command| command.value))?;
    if parsed.boolean("version") {
        output::write(runtime.stdout, &format!("{}\n", crate::VERSION));
        return Ok(EXIT_SUCCESS);
    }
    if parsed.positionals.is_empty() {
        output::write(runtime.stdout, &usage_text(&commands));
        return Ok(EXIT_SUCCESS);
    }
    let verb = parsed.positionals.remove(0);
    let command = commands.iter().find(|candidate| candidate.doc.verb == verb).ok_or_else(|| CliError::usage(format!("Unknown command: {verb}")))?;
    let takes = |flag: &str| COMMON.contains(&flag) || command.boolean.contains(&flag) || command.value.contains(&flag);
    if let Some((flag, _)) = parsed.flags.iter().find(|(flag, _)| !takes(flag)) {
        return Err(CliError::usage(format!("Unknown option '--{flag}'.")));
    }
    if parsed.boolean("help") {
        output::write(runtime.stdout, &render_command_help(&command.doc));
        return Ok(EXIT_SUCCESS);
    }
    let (minimum, maximum) = command.positionals;
    if parsed.positionals.len() < minimum || parsed.positionals.len() > maximum {
        return Err(CliError::usage(format!("Usage: ghost {}", command.doc.usage)));
    }
    (command.run)(&mut Context { parsed, runtime, timeout, client: None })
}

/// `ghost_cli` with the bound on a control request given.
fn run(args: &[String], mut runtime: CliRuntime, timeout: Duration) -> i32 {
    match dispatch(args, &mut runtime, timeout) {
        Ok(code) => code,
        Err(error) => {
            output::write(runtime.stderr, &format!("ghost: {}\n", error.message));
            error.exit_code
        }
    }
}

/// The whole `ghost` command: run `args` (without the program name) and
/// return the exit code. A failure is one `ghost: <why>` line on stderr.
pub fn ghost_cli(args: &[String], runtime: CliRuntime) -> i32 {
    run(args, runtime, CONTROL_TIMEOUT)
}
