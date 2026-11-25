//! The `ghost` command: the CLI over this process's own arguments, environment and streams.
use ghostd::cli::{CliRuntime, Stdin, ghost_cli};
use std::io::IsTerminal;

fn main() {
    let args: Vec<String> = std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect();
    let env = ghostd::env::current();
    let home = ghostd::env::home(&env);
    let (stdin, mut stdout, mut stderr) = (std::io::stdin(), std::io::stdout(), std::io::stderr());
    let stdout_is_tty = stdout.is_terminal();
    let runtime = CliRuntime {
        env: &env,
        home: &home,
        stdin: Stdin::Stream { is_tty: stdin.is_terminal(), reader: Box::new(stdin) },
        stdout: &mut stdout,
        stderr: &mut stderr,
        stdout_is_tty,
    };
    std::process::exit(ghost_cli(&args, runtime));
}
