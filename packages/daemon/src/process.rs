//! Child processes: a command in its own process group whose output is handed
//! on as it arrives and whose whole group ends on abort (an owner's
//! `!command`, a hook, the model's `bash`), and a short-lived binary whose
//! output is collected (`tailscale`, a product's CLI). ghostd signals only a
//! group it spawned.
use crate::abort::Abort;
use crate::env::Env;
use std::io::{Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a command gets to exit after SIGTERM before the group is killed.
const KILL_GRACE: Duration = Duration::from_secs(3);
/// The stderr kept for an error message.
const STDERR_TAIL_BYTES: usize = 8_192;
/// How long output may keep arriving after the process itself exits.
const PIPE_DRAIN: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProcessExit {
    pub code: Option<i32>,
    /// The signal that ended it, by number.
    pub signal: Option<i32>,
    /// The last bytes of stderr; empty when stderr was merged into stdout.
    pub stderr: String,
    /// The process could not start (not installed, not executable).
    pub spawn_error: Option<String>,
}

pub struct ProcessOptions<'a> {
    pub argv: &'a [&'a str],
    pub cwd: &'a Path,
    pub env: &'a Env,
    pub abort: &'a Abort,
    /// Written to the process's stdin, which is then closed; None, stdin is /dev/null.
    pub stdin: Option<&'a str>,
    /// Hand stderr to `on_output` too, in arrival order with stdout.
    pub merge_stderr: bool,
    /// Also call `on_output` with an empty chunk about every 50 ms while the
    /// process is quiet, so a caller can act on time passing.
    pub tick: bool,
}

/// A signal's name as a shell user knows it.
pub fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGABRT => "SIGABRT".into(),
        other => format!("signal {other}"),
    }
}

fn signal_group(pid: u32, signal: i32) {
    // SAFETY: a plain syscall on a group ghostd spawned; a group already gone is ESRCH.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

fn pump(mut source: impl Read + Send + 'static, tag: bool, sender: mpsc::Sender<(bool, Vec<u8>)>) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        while let Ok(read) = source.read(&mut buffer) {
            if read == 0 || sender.send((tag, buffer[..read].to_vec())).is_err() {
                break;
            }
        }
    });
}

/// Decodes a byte stream as UTF-8, holding back a character split across chunks.
#[derive(Default)]
struct Utf8Stream(Vec<u8>);

impl Utf8Stream {
    fn push(&mut self, chunk: &[u8]) -> String {
        self.0.extend_from_slice(chunk);
        let valid = match std::str::from_utf8(&self.0) {
            Ok(_) => self.0.len(),
            // An incomplete character at the end waits for its rest; anything else is replaced.
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => self.0.len(),
        };
        let text = String::from_utf8_lossy(&self.0[..valid]).into_owned();
        self.0.drain(..valid);
        text
    }
}

/// Run `argv` in its own process group until it exits or `abort` ends the
/// group (SIGTERM, then SIGKILL). `on_output` gets stdout as it arrives. A
/// detached descendant that keeps the pipes open does not hold the call: it
/// ends with the command, not with its grandchildren.
pub fn run_process(options: ProcessOptions<'_>, mut on_output: impl FnMut(&str)) -> ProcessExit {
    let Some((command, args)) = options.argv.split_first() else {
        return ProcessExit { spawn_error: Some("empty command".into()), ..Default::default() };
    };
    let mut child = match Command::new(command)
        .args(args)
        .current_dir(options.cwd)
        .env_clear()
        .envs(options.env)
        .stdin(if options.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return ProcessExit { spawn_error: Some(error.to_string()), ..Default::default() },
    };
    let pid = child.id();
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), options.stdin) {
        let input = input.to_string();
        // A process may exit without reading its stdin; its exit still decides.
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    let (sender, receiver) = mpsc::channel();
    pump(child.stdout.take().expect("piped stdout"), false, sender.clone());
    pump(child.stderr.take().expect("piped stderr"), true, sender);
    let _terminate = options.abort.on_abort(move || signal_group(pid, libc::SIGTERM));

    let (mut out, mut err) = (Utf8Stream::default(), Utf8Stream::default());
    let mut stderr = String::new();
    let mut take = |(from_stderr, chunk): (bool, Vec<u8>), on_output: &mut dyn FnMut(&str)| {
        if from_stderr && !options.merge_stderr {
            stderr.push_str(&err.push(&chunk));
            if stderr.len() > STDERR_TAIL_BYTES {
                let mut cut = stderr.len() - STDERR_TAIL_BYTES;
                while !stderr.is_char_boundary(cut) {
                    cut += 1;
                }
                stderr.drain(..cut);
            }
        } else {
            let text = if from_stderr { err.push(&chunk) } else { out.push(&chunk) };
            if !text.is_empty() {
                on_output(&text);
            }
        }
    };
    let mut killed_at: Option<Instant> = None;
    let mut exited: Option<(std::process::ExitStatus, Instant)> = None;
    let mut pipes_open = true;
    let status = loop {
        if exited.is_none()
            && let Ok(Some(status)) = child.try_wait()
        {
            exited = Some((status, Instant::now()));
        }
        if let Some((status, at)) = exited {
            if !pipes_open || at.elapsed() >= PIPE_DRAIN || options.abort.is_aborted() {
                break status;
            }
        } else if options.abort.is_aborted() {
            match killed_at {
                None => killed_at = Some(Instant::now() + KILL_GRACE),
                Some(deadline) if Instant::now() >= deadline => signal_group(pid, libc::SIGKILL),
                Some(_) => {}
            }
        }
        match receiver.recv_timeout(Duration::from_millis(if exited.is_some() { 10 } else { 50 })) {
            Ok(chunk) => take(chunk, &mut on_output),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                pipes_open = false;
                if exited.is_none() {
                    // Both pipes closed; only the exit is left to wait for.
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if options.tick {
                    on_output("");
                }
            }
        }
    };
    // Cancellation kills surviving members of the group even after its leader exits.
    if options.abort.is_aborted() {
        signal_group(pid, libc::SIGKILL);
    } else {
        while let Ok(chunk) = receiver.try_recv() {
            take(chunk, &mut on_output);
        }
    }
    ProcessExit { code: status.code(), signal: status.signal(), stderr, spawn_error: None }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Why a short-lived binary gave no result.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandFailure {
    /// The binary is not installed.
    Missing,
    Other(String),
}

impl std::fmt::Display for CommandFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => f.write_str("the command is not installed"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

/// Run one binary to its end and collect its output, bounded by `timeout`
/// and `abort`. A non-zero exit is a result; a missing binary is `Missing`.
pub fn run_command(
    binary: &str,
    args: &[&str],
    env: &Env,
    stdin: Option<&str>,
    timeout: Duration,
    abort: &Abort,
) -> Result<CommandResult, CommandFailure> {
    if !binary.contains('/') && crate::env::which(binary, env).is_none() {
        return Err(CommandFailure::Missing);
    }
    let (own, _link) = abort.child();
    let timer = own.clone();
    let (done, finished) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        if finished.recv_timeout(timeout).is_err() {
            timer.abort();
        }
    });
    let mut argv = vec![binary];
    argv.extend_from_slice(args);
    let mut stdout = String::new();
    let exit = run_process(
        ProcessOptions { argv: &argv, cwd: Path::new("/"), env, abort: &own, stdin: Some(stdin.unwrap_or("")), merge_stderr: false, tick: false },
        |chunk| stdout.push_str(chunk),
    );
    let _ = done.send(());
    if let Some(error) = exit.spawn_error {
        return Err(CommandFailure::Other(error));
    }
    if own.is_aborted() && exit.code.is_none() {
        return Err(CommandFailure::Other(if abort.is_aborted() {
            "stopped".into()
        } else {
            format!("{binary} did not answer in {} s", timeout.as_secs())
        }));
    }
    Ok(CommandResult { stdout, stderr: exit.stderr, code: exit.code.unwrap_or(1) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        crate::env::current()
    }

    fn bash(script: &str, abort: &Abort, stdin: Option<&str>, merge: bool) -> (ProcessExit, String) {
        let mut out = String::new();
        let exit = run_process(
            ProcessOptions { argv: &["bash", "-c", script], cwd: Path::new("/"), env: &env(), abort, stdin, merge_stderr: merge, tick: false },
            |chunk| out.push_str(chunk),
        );
        (exit, out)
    }

    #[test]
    fn collects_stdout_stderr_and_the_exit_code() {
        let (exit, out) = bash("echo out; echo err >&2; exit 3", &Abort::new(), None, false);
        assert_eq!((exit.code, exit.stderr.as_str(), out.as_str()), (Some(3), "err\n", "out\n"));
        let (exit, out) = bash("cat", &Abort::new(), Some("héllo"), false);
        assert_eq!((exit.code, out.as_str()), (Some(0), "héllo"));
        let (exit, out) = bash("echo a; echo b >&2", &Abort::new(), None, true);
        assert_eq!(exit.stderr, "");
        assert!(out.contains('a') && out.contains('b'));
    }

    #[test]
    fn a_missing_command_is_a_spawn_error() {
        let exit = run_process(
            ProcessOptions {
                argv: &["/nonexistent/ghost-test"],
                cwd: Path::new("/"),
                env: &env(),
                abort: &Abort::new(),
                stdin: None,
                merge_stderr: false,
                tick: false,
            },
            |_| {},
        );
        assert!(exit.spawn_error.is_some());
        assert_eq!(run_command("ghost-no-such-binary", &[], &env(), None, Duration::from_secs(1), &Abort::new()), Err(CommandFailure::Missing));
    }

    #[test]
    fn abort_ends_the_whole_group() {
        let abort = Abort::new();
        let stopper = abort.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            stopper.abort();
        });
        let started = Instant::now();
        let (exit, out) = bash("echo started; sleep 30 & wait", &abort, None, false);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(out, "started\n");
        assert_eq!(exit.code, None);
    }

    #[test]
    fn a_detached_grandchild_does_not_hold_the_call() {
        let started = Instant::now();
        let (exit, out) = bash("(sleep 20 &) ; echo done", &Abort::new(), None, false);
        assert_eq!((exit.code, out.as_str()), (Some(0), "done\n"));
        assert!(started.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn run_command_times_out() {
        let failure = run_command("sleep", &["30"], &env(), None, Duration::from_millis(200), &Abort::new()).unwrap_err();
        assert!(matches!(failure, CommandFailure::Other(message) if message.contains("did not answer")));
        let ok = run_command("bash", &["-c", "echo hi; exit 2"], &env(), None, Duration::from_secs(5), &Abort::new()).unwrap();
        assert_eq!((ok.stdout.as_str(), ok.code), ("hi\n", 2));
    }

    // ── process.test.ts ─────────────────────────────────────────────────

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("ghost-process-{}", crate::random::uuid()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).display().to_string()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The pid a test's own child wrote, once it is there whole. An empty or
    /// half-written file is no pid, never pid 0.
    fn read_pid(path: &str) -> Option<i32> {
        std::fs::read_to_string(path).ok()?.trim().parse().ok().filter(|pid| *pid > 0)
    }

    /// SIGKILL to a process this test's own command started; one already gone is fine.
    fn kill_captured(path: &str) {
        if let Some(pid) = read_pid(path) {
            // SAFETY: a plain syscall on a pid this test's child recorded; ESRCH is success.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }

    /// A zombie has exited and holds nothing: only a process that can still run is alive.
    fn alive(pid: i32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .is_ok_and(|stat| stat.rfind(')').and_then(|end| stat[end + 1..].split_whitespace().next()).is_some_and(|state| state != "Z"))
    }

    /// Poll for what has no signal to wait on: another process's files and exit.
    fn wait_for<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(found) = check() {
                return found;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn closes_inherited_pipes_and_takes_no_descendant_output_after_settlement() {
        let scratch = Scratch::new();
        let (gate, pid_file, outcome) = (scratch.path("write-late"), scratch.path("descendant.pid"), scratch.path("outcome"));
        // A detached descendant keeps the command's stdout and writes to it once
        // the gate opens, until a write fails: the reader letting go of the pipe.
        let descendant = format!(
            "trap '' PIPE; while [ ! -e '{gate}' ]; do sleep 0.01; done; deadline=$((SECONDS + 5)); \
             while echo late 2>/dev/null; do if [ \"$SECONDS\" -ge \"$deadline\" ]; then echo open > '{outcome}.tmp'; mv '{outcome}.tmp' '{outcome}'; exit; fi; sleep 0.02; done; \
             echo closed > '{outcome}.tmp'; mv '{outcome}.tmp' '{outcome}'"
        );
        let script = format!("setsid bash -c \"$DESCENDANT\" < /dev/null & echo $! > '{pid_file}.tmp'; mv '{pid_file}.tmp' '{pid_file}'; echo early");
        let mut env = env();
        env.insert("DESCENDANT".into(), descendant);
        let mut output = String::new();
        let started = Instant::now();
        let exit = run_process(
            ProcessOptions {
                argv: &["bash", "-c", &script],
                cwd: &scratch.0,
                env: &env,
                abort: &Abort::new(),
                stdin: None,
                merge_stderr: false,
                tick: false,
            },
            |chunk| output.push_str(chunk),
        );
        let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // It ends with the command, after the drain it allows and no longer.
            assert_eq!((exit.code, output.as_str()), (Some(0), "early\n"));
            assert!(started.elapsed() >= PIPE_DRAIN && started.elapsed() < PIPE_DRAIN + Duration::from_secs(10));
            std::fs::write(&gate, "ready").unwrap();
            wait_for("the pipe's outcome", || std::path::Path::new(&outcome).exists().then_some(()));
            assert_eq!(std::fs::read_to_string(&outcome).unwrap().trim(), "closed");
        }));
        kill_captured(&pid_file);
        if let Err(panic) = checked {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    fn kills_the_stopped_leaders_surviving_process_group_with_inherited_and_ignored_pipes() {
        for redirect in ["", "< /dev/null > /dev/null 2>&1"] {
            let scratch = Scratch::new();
            let (ready, pid_file) = (scratch.path("ready"), scratch.path("descendant.pid"));
            // The descendant is deaf to SIGTERM; the leader, which is not, says ready once the descendant is.
            let descendant = format!("trap '' TERM; echo ready > '{ready}'; while :; do sleep 1; done");
            let script = format!(
                "bash -c \"$DESCENDANT\" {redirect} & echo $! > '{pid_file}.tmp'; mv '{pid_file}.tmp' '{pid_file}'; \
                 while [ ! -e '{ready}' ]; do sleep 0.01; done; echo ready; while :; do sleep 1; done"
            );
            let mut env = env();
            env.insert("DESCENDANT".into(), descendant);
            let abort = Abort::new();
            let stopper = abort.clone();
            let exit = run_process(
                ProcessOptions {
                    argv: &["bash", "-c", &script],
                    cwd: &scratch.0,
                    env: &env,
                    abort: &abort,
                    stdin: None,
                    merge_stderr: false,
                    tick: false,
                },
                |_| stopper.abort(),
            );
            let pid = read_pid(&pid_file);
            let checked = std::panic::catch_unwind(|| {
                assert_eq!((exit.code, exit.signal), (None, Some(libc::SIGTERM)), "{redirect}");
                let pid = pid.expect("the descendant's pid");
                wait_for("the descendant to end", || (!alive(pid)).then_some(()));
            });
            kill_captured(&pid_file);
            if let Err(panic) = checked {
                std::panic::resume_unwind(panic);
            }
        }
    }

    #[test]
    fn delivers_newline_free_stdout_while_the_child_is_still_running() {
        let scratch = Scratch::new();
        let gate = scratch.path("received");
        // It finishes only once its first, unterminated, output has been handed on.
        let script = format!("printf 'start🐈'; while [ ! -e '{gate}' ]; do sleep 0.005; done; printf finish");
        let mut output = String::new();
        let exit = run_process(
            ProcessOptions {
                argv: &["bash", "-c", &script],
                cwd: &scratch.0,
                env: &env(),
                abort: &Abort::new(),
                stdin: None,
                merge_stderr: false,
                tick: false,
            },
            |chunk| {
                output.push_str(chunk);
                if output.contains("start🐈") {
                    std::fs::write(&gate, "ready").unwrap();
                }
            },
        );
        assert_eq!((exit.code, output.as_str()), (Some(0), "start🐈finish"));
    }

    #[test]
    fn a_character_split_across_chunks_arrives_whole() {
        let mut stream = Utf8Stream::default();
        let cat = "🐈".as_bytes();
        assert_eq!(stream.push(&[b'a', cat[0], cat[1]]), "a");
        assert_eq!(stream.push(&cat[2..3]), "");
        assert_eq!(stream.push(&[cat[3], b'b']), "🐈b");
        // Bytes that are no character at all are replaced, not held for ever.
        assert_eq!(stream.push(&[0xff, b'c']), "\u{fffd}c");
    }

    #[test]
    fn an_empty_command_and_the_stderr_tail() {
        let exit = run_process(
            ProcessOptions { argv: &[], cwd: Path::new("/"), env: &env(), abort: &Abort::new(), stdin: None, merge_stderr: false, tick: false },
            |_| {},
        );
        assert_eq!(exit, ProcessExit { spawn_error: Some("empty command".into()), ..Default::default() });
        // Only the last of a long stderr is kept, for an error message.
        let (exit, out) = bash("head -c 20000 /dev/zero | tr '\\0' e >&2; echo END >&2", &Abort::new(), None, false);
        assert_eq!((exit.stderr.len(), out.as_str()), (STDERR_TAIL_BYTES, ""));
        assert!(exit.stderr.ends_with("eEND\n"));
        // A command that never reads its stdin still ends by its exit.
        let (exit, _) = bash("exit 5", &Abort::new(), Some(&"x".repeat(1 << 20)), false);
        assert_eq!(exit.code, Some(5));
        assert_eq!((signal_name(libc::SIGTERM), signal_name(64)), ("SIGTERM".to_string(), "signal 64".to_string()));
    }
}
