use ghostd::cli::{CliRuntime, Stdin, hook_complete_command};
use std::io::IsTerminal;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env = ghostd::env::current();
    let home = ghostd::env::home(&env);
    // Subcommands own their narrower lifecycle: the token command touches only XDG state.
    let code = match args.first().map(String::as_str) {
        Some("api-token") => {
            let path = ghostd::token::api_token_path(&env, &home);
            ghostd::token::api_token_command(&args[1..], &path, &mut std::io::stdout(), &mut std::io::stderr())
        }
        Some("hook-complete") => {
            let stdin = std::io::stdin();
            let is_tty = stdin.is_terminal();
            hook_complete_command(
                &args[1..],
                CliRuntime {
                    env: &env,
                    home: &home,
                    stdout: &mut std::io::stdout(),
                    stderr: &mut std::io::stderr(),
                    stdin: Stdin { reader: Box::new(stdin), is_tty },
                    stdout_is_tty: std::io::stdout().is_terminal(),
                },
            )
        }
        _ => ghostd::daemon::main(&args, env.clone(), &home),
    };
    std::process::exit(code);
}
