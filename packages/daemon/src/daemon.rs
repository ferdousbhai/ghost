//! `ghostd` itself: its arguments, start-up, and the stop on SIGINT or SIGTERM.
use crate::config::{DaemonConfig, Overrides, load_config};
use crate::env::Env;
use crate::ghosts::the_ghost;
use crate::hooks::HookRunner;
use crate::local_model::LocalModel;
use crate::log::{Level, Logger, stderr_is_journal};
use crate::remote::{RemoteAccess, RemoteServe, tailscale_runner};
use crate::running_source::{resolve_running_source, running_executable};
use crate::server::{ApiToken, ServerOptions, start_daemon_server};
use crate::session_host::{SessionHost, SessionHostOptions};
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI32, Ordering};

pub const USAGE: &str = "ghostd — your ghost, on your machine

Usage:
  ghostd [options]
  ghostd api-token [--quiet]
  ghostd hook-complete

Subcommands:
  api-token                Print the bearer token local API clients present
                           (minting one on first run). The window and CLI read
                           the file themselves; this is for curl, scripts, and
                           diagnosing a 401. To replace it, delete the file and
                           restart.
  hook-complete            Command-hook bridge. Reads a prompt as JSON on
                           stdin, asks the running daemon, and writes one
                           completion as JSON on stdout, from the local model.

Options:
  -p, --port <port>        TCP port to bind on 127.0.0.1 (default 7717)
      --home <dir>         The ghost home (default ~/.local/share/ghost)
      --config <file>      Config file (default ~/.config/ghost/config.json)
      --log-level <level>  info | warn | error (default info)
  -h, --help               Show this message
  -v, --version            Show the version

Environment:
  GHOSTD_PORT, GHOST_HOME, GHOSTD_CONFIG, GHOSTD_HOOKS,
  GHOSTD_API_TOKEN_FILE, XDG_CONFIG_HOME, XDG_STATE_HOME,
  XDG_CACHE_HOME, XDG_DOCUMENTS_DIR
";

#[derive(Debug)]
pub struct ParsedArgs {
    pub overrides: Overrides,
    pub log_level: Level,
    pub help: bool,
    pub version: bool,
}

/// The daemon's own flags; anything else is refused by name.
pub fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut parsed = ParsedArgs { overrides: Overrides::default(), log_level: Level::Info, help: false, version: false };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let mut value =
            |name: &str| inline.clone().or_else(|| rest.next().cloned()).ok_or_else(|| format!("Option '{name} <value>' argument missing"));
        match name {
            "-h" | "--help" => parsed.help = true,
            "-v" | "--version" => parsed.version = true,
            "-p" | "--port" => {
                let raw = value(name)?;
                parsed.overrides.port = Some(raw.parse::<u16>().map_err(|_| format!("Invalid port: {raw}"))?);
            }
            "--home" => parsed.overrides.home = Some(value(name)?),
            "--config" => parsed.overrides.config_path = Some(PathBuf::from(value(name)?)),
            "--log-level" => {
                let raw = value(name)?;
                parsed.log_level = Level::parse(&raw).ok_or_else(|| format!("Invalid log level: {raw}"))?;
            }
            other => return Err(format!("Unknown option '{other}'")),
        }
    }
    Ok(parsed)
}

/// Point every child — a turn's commands, a hook, `ghostd hook-complete`,
/// `ghost` — at this daemon: a `--port`, `--config`, or `--home` flag is
/// otherwise invisible to them, and they would address the default daemon.
pub fn daemon_env(config: &DaemonConfig, port: u16, mut env: Env) -> Env {
    env.insert("GHOSTD_PORT".into(), port.to_string());
    env.insert("GHOSTD_CONFIG".into(), config.config_path.to_string_lossy().into_owned());
    env.insert("GHOST_HOME".into(), config.home.to_string_lossy().into_owned());
    env.insert("GHOSTD_HOOKS".into(), config.hooks_path.to_string_lossy().into_owned());
    env
}

static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(signal: libc::c_int) {
    // Async-signal-safe: one write, and the default action back so a second signal ends the process outright.
    let byte = signal as u8;
    // SAFETY: `write` and `signal` are async-signal-safe; the descriptor is the pipe made before the handler was installed.
    unsafe {
        libc::write(SIGNAL_PIPE.load(Ordering::Relaxed), (&raw const byte).cast(), 1);
        libc::signal(signal, libc::SIG_DFL);
    }
}

/// SIGINT and SIGTERM, caught from `install` on: one that arrives before
/// `wait` is still the stop it asks for, not the end of a half-started daemon.
struct ShutdownSignal {
    /// The read end of the handler's pipe; None when the pipe could not be made.
    pipe: Option<libc::c_int>,
}

impl ShutdownSignal {
    fn install() -> Self {
        let mut ends = [0 as libc::c_int; 2];
        // SAFETY: plain syscalls on descriptors this function makes; the handler only writes to the pipe.
        unsafe {
            if libc::pipe(ends.as_mut_ptr()) != 0 {
                return Self { pipe: None };
            }
            SIGNAL_PIPE.store(ends[1], Ordering::Relaxed);
            libc::signal(libc::SIGINT, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
            libc::signal(libc::SIGTERM, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        }
        Self { pipe: Some(ends[0]) }
    }

    /// Block until one has arrived; returns its name.
    fn wait(&self) -> &'static str {
        let Some(pipe) = self.pipe else { return "none" };
        let mut byte = 0u8;
        loop {
            // SAFETY: a read into one byte this function owns, from the pipe `install` made.
            let read = unsafe { libc::read(pipe, (&raw mut byte).cast(), 1) };
            if read == 1 {
                break;
            }
            if read < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return "none";
        }
        if i32::from(byte) == libc::SIGINT { "SIGINT" } else { "SIGTERM" }
    }
}

/// Run the daemon until it is told to stop; returns the exit code.
pub fn main(args: &[String], process_env: Env, home: &Path) -> i32 {
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprint!("{message}\n\n{USAGE}");
            return 2;
        }
    };
    if parsed.help {
        print!("{USAGE}");
        return 0;
    }
    if parsed.version {
        println!("{}", crate::VERSION);
        return 0;
    }
    let logger = Logger::stderr(parsed.log_level, stderr_is_journal(process_env.get("JOURNAL_STREAM").map(String::as_str)));
    let mut config = match load_config(&parsed.overrides, &process_env, home) {
        Ok(config) => config,
        Err(error) => {
            logger.error("configuration is invalid", json!({ "error": error }));
            return 1;
        }
    };
    if config.port == 0 {
        // Any free port: chosen here, so the children's environment can name it.
        match std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|listener| listener.local_addr()) {
            Ok(address) => config.port = address.port(),
            Err(error) => {
                logger.error("could not bind", json!({ "port": 0, "error": error.to_string() }));
                return 1;
            }
        }
    }
    let env = daemon_env(&config, config.port, process_env);
    let hooks = match HookRunner::from_config(&config.hooks_path, logger.clone(), env.clone()) {
        Ok(hooks) => Arc::new(hooks),
        Err(error) => {
            logger.error("hook configuration is invalid", json!({ "path": config.hooks_path.to_string_lossy(), "error": error }));
            return 1;
        }
    };
    // What is running: the source checkout behind this process, if it has one.
    let running_source = resolve_running_source(crate::VERSION, &running_executable(), &env);
    let ghost = match the_ghost(&config.home) {
        Ok(ghost) => ghost,
        Err(error) => {
            logger.error("no ghost home", json!({ "error": error.message }));
            return 1;
        }
    };
    let tailscale = tailscale_runner(env.clone());
    let remote_serve = Arc::new(RemoteServe::new(config.port, &config.remote, tailscale.clone()));
    let links = remote_serve.clone();
    let local_model = config.local.clone().map(|local| LocalModel::new(local, logger.child(json!({ "part": "local-model" })), env.clone()));
    let host = SessionHost::new(SessionHostOptions {
        ghost: ghost.clone(),
        owner_home: home.to_path_buf(),
        logger: logger.clone(),
        hooks: hooks.clone(),
        conversation_url: Some(Box::new(move |id| links.conversation_url(id))),
        local_model,
        answerer: None,
        coding_agent: None,
        env: env.clone(),
        push: Some(crate::push::Push::new(crate::push::Push::default_path(&env, home), logger.child(json!({ "part": "push" })), env.clone())),
    });
    let summary = json!({
        "url": format!("http://127.0.0.1:{}", config.port),
        "home": config.home.to_string_lossy(),
        "ghost": ghost.name(),
        "version": running_source.version,
        "commit": running_source.commit,
        "source": running_source.root.as_ref().map(|root| root.to_string_lossy()),
        "config": config.config_path.to_string_lossy(),
        "hooks": config.hooks_path.to_string_lossy(),
    });
    let listening = start_daemon_server(ServerOptions {
        ghost,
        host: host.clone(),
        running_source,
        hooks,
        logger: logger.clone(),
        max_body_bytes: None,
        api_token: ApiToken::File,
        remote: Some(Arc::new(RemoteAccess::new(&config.remote, tailscale))),
        remote_apps: config.remote.apps.clone(),
        remote_serve,
        stream_cut_bytes: None,
        port: config.port,
        env,
        home: home.to_path_buf(),
    });
    let listening = match listening {
        Ok(listening) => listening,
        Err(error) => {
            logger.error("could not bind", json!({ "port": config.port, "error": error }));
            host.dispose_all();
            return 1;
        }
    };
    // Caught before the daemon says it is up, so a stop sent the moment it does is a clean one.
    let shutdown = ShutdownSignal::install();
    logger.info("listening", summary);
    // Stop accepting work, abort running turns, and close everything. A second
    // signal ends the process outright; systemd's `TimeoutStopSec` bounds the whole stop.
    let signal = shutdown.wait();
    logger.info("shutting down", json!({ "signal": signal }));
    host.dispose_all();
    listening.close();
    logger.info("stopped", serde_json::Value::Null);
    let _ = std::io::stderr().flush();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn flags_are_read_in_both_spellings() {
        let parsed = parse_args(&args(&["-p", "7001", "--home=/g", "--config", "/c.json", "--log-level", "warn"])).unwrap();
        assert_eq!(parsed.overrides.port, Some(7001));
        assert_eq!(parsed.overrides.home.as_deref(), Some("/g"));
        assert_eq!(parsed.overrides.config_path.as_deref(), Some(Path::new("/c.json")));
        assert_eq!(parsed.log_level, Level::Warn);
        assert!(parse_args(&args(&["-h"])).unwrap().help && parse_args(&args(&["--version"])).unwrap().version);
    }

    #[test]
    fn bad_arguments_are_named() {
        assert_eq!(parse_args(&args(&["--port", "99999"])).unwrap_err(), "Invalid port: 99999");
        assert_eq!(parse_args(&args(&["--log-level", "loud"])).unwrap_err(), "Invalid log level: loud");
        assert_eq!(parse_args(&args(&["--nope"])).unwrap_err(), "Unknown option '--nope'");
        assert!(parse_args(&args(&["--port"])).unwrap_err().contains("argument missing"));
    }

    // ── Start-up ────────────────────────────────────────────────────────

    #[test]
    fn defaults_to_no_overrides() {
        let parsed = parse_args(&[]).unwrap();
        assert_eq!((parsed.overrides.port, parsed.overrides.home, parsed.overrides.config_path), (None, None, None));
        assert_eq!((parsed.log_level, parsed.help, parsed.version), (Level::Info, false, false));
    }

    #[test]
    fn parses_the_serve_options() {
        let parsed = parse_args(&args(&["--port", "7788", "--home", "/tmp/ghosts", "--config", "/tmp/config.json", "--log-level", "warn"])).unwrap();
        assert_eq!(
            (parsed.overrides.port, parsed.overrides.home.as_deref(), parsed.overrides.config_path.as_deref()),
            (Some(7788), Some("/tmp/ghosts"), Some(Path::new("/tmp/config.json")))
        );
        assert_eq!((parsed.log_level, parsed.help, parsed.version), (Level::Warn, false, false));
        // The short port flag, and port 0 for any free port.
        assert_eq!(parse_args(&args(&["-p", "9000"])).unwrap().overrides.port, Some(9000));
        assert_eq!(parse_args(&args(&["--port=0"])).unwrap().overrides.port, Some(0));
        assert_eq!(parse_args(&args(&["--log-level=error"])).unwrap().log_level, Level::Error);
    }

    #[test]
    fn recognises_help_and_version() {
        assert!(parse_args(&args(&["--help"])).unwrap().help && parse_args(&args(&["-h"])).unwrap().help);
        assert!(parse_args(&args(&["-v"])).unwrap().version && parse_args(&args(&["--version"])).unwrap().version);
    }

    #[test]
    fn rejects_nonsense_rather_than_guessing() {
        let refused = |list: &[&str]| parse_args(&args(list)).unwrap_err();
        assert!(refused(&["--port"]).contains("argument missing"));
        assert!(refused(&["--config"]).contains("argument missing"));
        assert_eq!(refused(&["--port", "70000"]), "Invalid port: 70000");
        for port in ["-1", "80.5", "http", ""] {
            assert_eq!(refused(&["--port", port]), format!("Invalid port: {port}"));
        }
        assert_eq!(refused(&["--log-level", "loud"]), "Invalid log level: loud");
        assert_eq!(refused(&["--wat"]), "Unknown option '--wat'");
        // A word that is no flag is not a ghost to serve or a command to run.
        assert_eq!(refused(&["serve"]), "Unknown option 'serve'");
    }

    #[test]
    fn help_advertises_every_subcommand_flag_and_variable() {
        for command in ["api-token", "hook-complete"] {
            assert!(USAGE.contains(&format!("ghostd {command}")), "{command}");
        }
        for flag in ["-p, --port <port>", "--home <dir>", "--config <file>", "--log-level <level>", "-h, --help", "-v, --version"] {
            assert!(USAGE.contains(flag), "{flag}");
        }
        for variable in ["GHOSTD_PORT", "GHOST_HOME", "GHOSTD_CONFIG", "GHOSTD_HOOKS", "GHOSTD_API_TOKEN_FILE", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] {
            assert!(USAGE.contains(variable), "{variable}");
        }
        assert!(USAGE.ends_with('\n'));
    }

    #[test]
    fn hands_a_daemons_flags_to_every_child_so_they_address_it_and_not_the_default_daemon() {
        let scratch = std::env::temp_dir().join(format!("ghostd-env-{}", crate::random::uuid()));
        std::fs::create_dir_all(&scratch).unwrap();
        let (config_file, root) = (scratch.join("config.json").display().to_string(), scratch.join("ghosts").display().to_string());
        let parsed = parse_args(&args(&["--port", "7788", "--config", &config_file, "--home", &root])).unwrap();
        let config = load_config(&parsed.overrides, &Env::new(), &scratch).unwrap();
        let inherited = Env::from([("HOME".to_string(), scratch.display().to_string()), ("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        let env = daemon_env(&config, 7788, inherited.clone());
        // What the daemon was started with stays; the four that name it are added.
        assert_eq!(env.len(), inherited.len() + 4);
        assert!(inherited.iter().all(|(name, value)| env.get(name) == Some(value)));
        // A hook's shell sees the flag's port…
        let print = "printf '%s %s %s %s' \"$GHOSTD_PORT\" \"$GHOSTD_CONFIG\" \"$GHOST_HOME\" \"$GHOSTD_HOOKS\"";
        let hook =
            crate::process::run_command("/bin/bash", &["-c", print], &env, None, std::time::Duration::from_secs(30), &crate::abort::Abort::new())
                .unwrap();
        assert_eq!(hook.stdout, format!("7788 {config_file} {root} {}", scratch.join("hooks.json").display()));
        // …and a child that loads the config from its environment resolves this daemon's.
        assert_eq!(load_config(&Overrides::default(), &env, &scratch).unwrap(), config);
        // The port is the one bound, whatever the configuration asked for.
        assert_eq!(daemon_env(&config, 4242, inherited)["GHOSTD_PORT"], "4242");
        std::fs::remove_dir_all(scratch).unwrap();
    }
}
