//! The real `ghostd` binary, started and stopped as systemd would, against a
//! scratch home: nothing here reads the owner's ghosts, config, or token, and
//! the daemon binds whatever port is free.
use ghostd::http::{ClientRequest, send};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

const GHOSTD: &str = env!("CARGO_BIN_EXE_ghostd");
/// Far longer than a start or a stop takes, so that only a hang reaches it.
const PATIENCE: Duration = Duration::from_secs(60);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ghostd-main-{}", ghostd::random::uuid()));
        // An empty directory to be the whole PATH: the daemon finds no `tailscale`, `git`, or agent to run.
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        Self(dir)
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).display().to_string()
    }

    /// `ghostd` with nothing of the owner's in its environment.
    fn ghostd(&self, args: &[&str]) -> Command {
        let mut command = Command::new(GHOSTD);
        command.args(args).env_clear().current_dir(&self.0).stdin(Stdio::null());
        for (name, value) in [
            ("HOME", self.path("home")),
            ("PATH", self.path("bin")),
            ("GHOSTS_ROOT", self.path("ghosts")),
            ("GHOSTD_CONFIG", self.path("config/config.json")),
            ("GHOSTD_HOOKS", self.path("config/hooks.json")),
            ("GHOSTD_API_TOKEN_FILE", self.path("state/api-token")),
            ("XDG_CONFIG_HOME", self.path("config")),
            ("XDG_STATE_HOME", self.path("state")),
            ("XDG_CACHE_HOME", self.path("cache")),
            ("XDG_DATA_HOME", self.path("data")),
        ] {
            command.env(name, value);
        }
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.ghostd(args).output().unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A running daemon. Dropped while still running (a failed assertion), it is
/// killed: by the handle of the child this test spawned, and nothing else.
struct Daemon {
    child: Child,
    lines: Receiver<String>,
    seen: Vec<String>,
}

impl Daemon {
    fn spawn(mut command: Command) -> Self {
        let mut child = command.stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (sender, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Self { child, lines, seen: Vec::new() }
    }

    /// The fields of the next log line saying `message`; every line read on the way is kept.
    fn wait_for(&mut self, message: &str) -> Value {
        let marker = format!(" ghostd: {message}");
        loop {
            let line = self.lines.recv_timeout(PATIENCE).unwrap_or_else(|_| panic!("no {message:?} line; ghostd said:\n{}", self.seen.join("\n")));
            self.seen.push(line.clone());
            if let Some((_, rest)) = line.split_once(&marker) {
                return if rest.is_empty() { Value::Null } else { serde_json::from_str(rest).unwrap() };
            }
        }
    }

    /// Read stderr to its end, which is the process's own, and return the exit code.
    fn exit_code(&mut self) -> Option<i32> {
        loop {
            match self.lines.recv_timeout(PATIENCE) {
                Ok(line) => self.seen.push(line),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(_) => panic!("ghostd did not exit; it said:\n{}", self.seen.join("\n")),
            }
        }
        self.child.wait().unwrap().code()
    }

    fn signal(&self, signal: i32) {
        // SAFETY: a plain syscall on the pid of the child this test spawned and has not reaped.
        assert_eq!(unsafe { libc::kill(self.child.id() as i32, signal) }, 0);
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn get(port: u16, target: &str, token: Option<&str>) -> (u16, Value) {
    let authorization = token.map(|token| format!("Bearer {token}"));
    let headers: Vec<(&str, &str)> = authorization.iter().map(|value| ("authorization", value.as_str())).collect();
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let request = ClientRequest { address, method: "GET", target, headers: &headers, body: None, timeout: Some(PATIENCE), abort: None };
    let mut response = send(request).unwrap();
    let body = response.text(1 << 20).unwrap();
    (response.status, serde_json::from_str(&body).unwrap_or(Value::Null))
}

#[test]
fn starts_serves_the_ghost_and_stops_cleanly_on_sigterm() {
    let scratch = Scratch::new();
    let mut daemon = Daemon::spawn(scratch.ghostd(&["--port", "0"]));
    let listening = daemon.wait_for("listening");
    let url = listening["url"].as_str().unwrap();
    let port: u16 = url.strip_prefix("http://127.0.0.1:").unwrap().parse().unwrap();
    assert!(port != 0 && port != 7717);
    // A first start makes the ghost home, and the summary says what was resolved, the environment's paths included.
    assert_eq!(
        (&listening["ghost"], &listening["ghostsRoot"], &listening["config"], &listening["hooks"], &listening["version"]),
        (
            &json!("ghost"),
            &json!(scratch.path("ghosts")),
            &json!(scratch.path("config/config.json")),
            &json!(scratch.path("config/hooks.json")),
            &json!(ghostd::VERSION)
        )
    );
    assert!(Path::new(&scratch.path("ghosts/ghost/character.md")).is_file());
    // Outside systemd, a line carries its own time and level.
    let line = daemon.seen.last().unwrap();
    let (time, rest) = line.split_once(' ').unwrap();
    assert!(time.len() == 24 && time.ends_with('Z') && rest.starts_with("info  ghostd: listening {"), "{line}");

    // The token it minted, into the file it was pointed at, is what the API asks for.
    let token = ghostd::token::read_api_token(Path::new(&scratch.path("state/api-token"))).unwrap().expect("a minted token");
    assert_eq!(get(port, "/api/ghost", Some(&token)), (200, json!({ "name": "ghost" })));
    let (status, refusal) = get(port, "/api/ghost", None);
    assert_eq!((status, refusal["error"]["code"].is_string()), (401, true));
    assert_eq!(get(port, "/api/ghost", Some(&"0".repeat(64))).0, 401);

    daemon.signal(libc::SIGTERM);
    assert_eq!(daemon.exit_code(), Some(0), "{}", daemon.seen.join("\n"));
    let said = |message: &str| daemon.seen.iter().position(|line| line.contains(&format!(" ghostd: {message}")));
    let (down, stopped) = (said("shutting down {\"signal\":\"SIGTERM\"}").expect("shutting down"), said("stopped").expect("stopped"));
    assert!(down < stopped && stopped == daemon.seen.len() - 1, "{}", daemon.seen.join("\n"));
    // Nothing answers on the port any more.
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    assert!(std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5)).is_err());
}

#[test]
fn stops_on_sigint_too_and_serves_the_ghost_home_it_is_pointed_at() {
    let scratch = Scratch::new();
    let home = scratch.0.join("elsewhere").join("casper");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("character.md"), "# casper\n\nYou are casper, a letterpress printer.\n").unwrap();
    let root = scratch.path("elsewhere");
    // Flags beat the environment the daemon was started in, and reach what it starts in turn.
    let mut daemon = Daemon::spawn(scratch.ghostd(&["--ghosts-root", &root, "-p", "0", "--log-level", "info"]));
    let listening = daemon.wait_for("listening");
    assert_eq!((&listening["ghost"], &listening["ghostsRoot"]), (&json!("casper"), &json!(root)));
    assert!(!Path::new(&scratch.path("ghosts")).exists());
    daemon.signal(libc::SIGINT);
    assert_eq!(daemon.exit_code(), Some(0), "{}", daemon.seen.join("\n"));
    assert!(daemon.seen.iter().any(|line| line.contains("shutting down {\"signal\":\"SIGINT\"}")));
    assert!(daemon.seen.last().unwrap().ends_with(" ghostd: stopped"));
}

#[test]
fn help_and_version_print_and_exit_without_starting_anything() {
    let scratch = Scratch::new();
    for flag in ["--help", "-h"] {
        let help = scratch.run(&[flag]);
        assert_eq!((help.status.code(), text(&help.stderr).as_str()), (Some(0), ""));
        assert_eq!(text(&help.stdout), ghostd::daemon::USAGE);
    }
    // Every subcommand is advertised.
    for command in ["api-token", "hook-complete"] {
        assert!(ghostd::daemon::USAGE.contains(&format!("ghostd {command}")));
    }
    for flag in ["--version", "-v"] {
        let version = scratch.run(&[flag]);
        assert_eq!((version.status.code(), text(&version.stdout)), (Some(0), format!("{}\n", ghostd::VERSION)));
    }
    // Neither made a ghost home, a token, or anything else.
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 1);
}

#[test]
fn refuses_arguments_and_configuration_it_cannot_read_and_says_why() {
    let scratch = Scratch::new();
    let wat = scratch.run(&["--wat"]);
    assert_eq!((wat.status.code(), text(&wat.stdout).as_str()), (Some(2), ""));
    assert_eq!(text(&wat.stderr), format!("Unknown option '--wat'\n\n{}", ghostd::daemon::USAGE));
    assert_eq!(scratch.run(&["--port", "70000"]).status.code(), Some(2));

    // A malformed config file is refused rather than silently defaulted.
    std::fs::create_dir_all(scratch.0.join("config")).unwrap();
    std::fs::write(scratch.path("config/config.json"), "{ not json").unwrap();
    let invalid = scratch.run(&["--port", "0"]);
    assert_eq!(invalid.status.code(), Some(1));
    assert!(text(&invalid.stderr).contains("error ghostd: configuration is invalid {\"error\":\""), "{}", text(&invalid.stderr));
    assert!(text(&invalid.stderr).contains("is not valid JSON"));

    // So is a hooks.json that names an event Ghost does not have; warnings are quieter than `--log-level error`.
    std::fs::write(scratch.path("config/config.json"), "{}").unwrap();
    std::fs::write(scratch.path("config/hooks.json"), json!({ "hooks": { "conversation_idle": [] } }).to_string()).unwrap();
    let hooks = scratch.run(&["--port", "0", "--log-level", "error"]);
    assert_eq!(hooks.status.code(), Some(1));
    let said = text(&hooks.stderr);
    assert_eq!(said.lines().count(), 1, "{said}");
    assert!(said.contains("ghostd: hook configuration is invalid") && said.contains("unsupported hook event"), "{said}");
    // None of them got as far as a ghost home or a token.
    assert!(!Path::new(&scratch.path("ghosts")).exists() && !Path::new(&scratch.path("state")).exists());
}

#[test]
fn gives_every_process_that_mints_at_once_the_one_winning_token() {
    let scratch = Scratch::new();
    let minting: Vec<Child> =
        (0..12).map(|_| scratch.ghostd(&["api-token", "--quiet"]).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap()).collect();
    let printed: Vec<String> = minting
        .into_iter()
        .map(|child| {
            let output = child.wait_with_output().unwrap();
            assert_eq!((output.status.code(), text(&output.stderr).as_str()), (Some(0), ""));
            text(&output.stdout)
        })
        .collect();
    let winner = ghostd::token::read_api_token(Path::new(&scratch.path("state/api-token"))).unwrap().expect("a minted token");
    assert!(printed.iter().all(|token| *token == format!("{winner}\n")), "{printed:?}");
    assert_eq!(std::fs::read_dir(scratch.0.join("state")).unwrap().count(), 1);
    // Without --quiet it also says where the token lives; an unknown option is refused.
    let explained = scratch.run(&["api-token"]);
    assert!(text(&explained.stdout).starts_with(&format!("{winner}\n\n")) && text(&explained.stdout).contains(&scratch.path("state/api-token")));
    let rotate = scratch.run(&["api-token", "--rotate"]);
    assert_eq!((rotate.status.code(), text(&rotate.stderr).as_str()), (Some(2), "api-token: unknown option --rotate\n"));
}
