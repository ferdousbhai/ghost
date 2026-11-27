//! The local model ghostd runs itself (CONTRACTS.md "Local model"): one
//! llama-server child on a loopback port chosen at spawn, with a fresh API key,
//! started by the first local turn and stopped after it has gone unused.
//! ghostd kills only the process it spawned.
//!
//! What the server has read is kept across a stop: before stopping it, ghostd
//! saves its one slot to disk, and after the next start restores it, so the
//! conversation it was in is not read again (68 s for 5,700 tokens, against
//! 0.2 s to restore). One file, private, replaced at each stop only by a
//! save that finished.
use crate::config::LocalModelConfig;
use crate::env::Env;
use crate::http::{ClientRequest, send};
use crate::log::Logger;
use serde_json::{Value, json};
use std::io::Read;
use std::net::{SocketAddr, TcpListener};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

/// A 26B model from a cold disk takes about a minute; this bounds a hung load.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const STDERR_TAIL: usize = 4_096;
/// How long the server gets to exit after SIGTERM before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// Ports handed to llama-server, which binds one later. Drawn at random from
/// below the ephemeral range (Linux: 32768+), so a port-0 listener elsewhere
/// cannot be given the same number between our probe and its bind.
const PORT_RANGE: std::ops::RangeInclusive<u16> = 20_000..=29_999;

#[derive(Clone, Debug, PartialEq)]
pub struct Endpoint {
    pub address: SocketAddr,
    pub key: String,
}

/// A loopback port that was bindable a moment ago.
fn free_port() -> Result<u16, String> {
    let span = u32::from(PORT_RANGE.end() - PORT_RANGE.start()) + 1;
    for _ in 0..32 {
        let draw = u32::from_le_bytes(crate::random::bytes::<4>()) % span;
        let port = PORT_RANGE.start() + draw as u16;
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(_) => return Ok(port),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!("no free loopback port found in {}-{}", PORT_RANGE.start(), PORT_RANGE.end()))
}

/// The slot's saved state, and what it was saved from, in `$XDG_CACHE_HOME/ghost/slot`.
const SLOT_FILE: &str = "slot.bin";
const SLOT_FROM: &str = "slot.json";
/// What the server writes a save to: it becomes `SLOT_FILE` only once it is whole.
const SLOT_SAVING: &str = "slot.saving";
/// Saving or restoring a full context's state (about 5 GB) takes seconds, not
/// minutes. The unit's `TimeoutStopSec` is longer than this and `STOP_GRACE`
/// together (a test below holds it to that), so a stop never kills a save.
const SLOT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
struct State {
    child: Option<Child>,
    endpoint: Option<Endpoint>,
    loading: bool,
    /// A stop is saving the slot and ending the server; a turn that arrives meanwhile waits to start the next.
    stopping: bool,
    users: u32,
    /// Bumped whenever the idle clock restarts, so a superseded timer does nothing.
    idle_generation: u64,
}

struct Inner {
    config: LocalModelConfig,
    logger: Logger,
    env: Env,
    /// Where the slot is saved: private to the owner, since it holds the conversation.
    slot_dir: std::path::PathBuf,
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Clone)]
pub struct LocalModel {
    inner: Arc<Inner>,
}

impl LocalModel {
    pub fn new(config: LocalModelConfig, logger: Logger, env: Env) -> Self {
        let home = std::path::PathBuf::from(crate::env::var(&env, "HOME").unwrap_or("/"));
        let slot_dir = crate::xdg::base_dir(&env, crate::xdg::Base::Cache, &home).join("ghost").join("slot");
        Self { inner: Arc::new(Inner { config, logger, env, slot_dir, state: Mutex::new(State::default()), changed: Condvar::new() }) }
    }

    /// What a saved slot must have been saved from to be restored: this model, at this context.
    fn slot_origin(&self) -> Value {
        json!({ "model": self.inner.config.model.to_string_lossy(), "contextSize": self.inner.config.context_size })
    }

    /// Ask the server to save its slot to `file` in the slot directory, or restore it from there; false when it did not.
    fn slot(&self, endpoint: &Endpoint, action: &str, file: &str) -> bool {
        let authorization = format!("Bearer {}", endpoint.key);
        let body = json!({ "filename": file }).to_string();
        let target = format!("/slots/0?action={action}");
        let answered = send(ClientRequest {
            address: endpoint.address,
            method: "POST",
            target: &target,
            headers: &[("content-type", "application/json"), ("authorization", &authorization)],
            body: Some(body.as_bytes()),
            timeout: Some(SLOT_TIMEOUT),
            abort: None,
        });
        answered.is_ok_and(|response| response.status == 200)
    }

    /// Save the slot before a stop, and say what it was saved from. The
    /// server writes the file itself, to another name: it is the slot's only
    /// once the save is whole, and the record is written last. Whatever fails
    /// or interrupts a save, no record names a file that is not a whole one.
    fn save_slot(&self, endpoint: &Endpoint) {
        use std::os::unix::fs::PermissionsExt;
        let dir = &self.inner.slot_dir;
        let (saving, saved, from) = (dir.join(SLOT_SAVING), dir.join(SLOT_FILE), dir.join(SLOT_FROM));
        let _ = std::fs::remove_file(&from);
        let whole = self.slot(endpoint, "save", SLOT_SAVING)
            // llama-server writes it world-readable; it holds the conversation.
            && std::fs::set_permissions(&saving, std::fs::Permissions::from_mode(0o600)).is_ok()
            && std::fs::rename(&saving, &saved).is_ok()
            && crate::private_file::write_json_atomic(&from, &self.slot_origin()).is_ok();
        if whole {
            self.inner.logger.info("local model state saved", json!({}));
        } else {
            // What is left is of no use without its record: the next turn reads the conversation again.
            let _ = std::fs::remove_file(&saving);
            let _ = std::fs::remove_file(&saved);
            self.inner.logger.warn("local model state was not saved", json!({}));
        }
    }

    /// Restore what the server had read before its last stop, when it was this model at this context.
    fn restore_slot(&self, endpoint: &Endpoint) {
        let dir = &self.inner.slot_dir;
        let saved = crate::private_file::read_text(&dir.join(SLOT_FROM)).ok().flatten();
        let from: Value = saved.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
        if from == self.slot_origin() && self.slot(endpoint, "restore", SLOT_FILE) {
            self.inner.logger.info("local model state restored", json!({}));
        }
    }

    /// Test seam: a model whose server already answers at `endpoint`. Nothing
    /// is spawned for it and nothing is killed; it stays loaded until `stop`.
    #[cfg(test)]
    pub fn with_endpoint(config: LocalModelConfig, logger: Logger, env: Env, endpoint: Endpoint) -> Self {
        let model = Self::new(config, logger, env);
        model.inner.state.lock().unwrap().endpoint = Some(endpoint);
        model
    }

    pub fn config(&self) -> &LocalModelConfig {
        &self.inner.config
    }

    /// The context the server is started with, in tokens.
    pub fn context_size(&self) -> u64 {
        self.inner.config.context_size
    }

    /// The model's name as requests name it: its file name without `.gguf`.
    pub fn name(&self) -> String {
        let file = self.inner.config.model.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        match file.len().checked_sub(5) {
            Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".gguf") => file[..cut].to_string(),
            _ => file,
        }
    }

    /// Hold the server for one turn, starting it if needed; `on_loading` is
    /// told when the caller has to wait for a load. `release` must follow a
    /// success; the idle clock starts when the last holder lets go.
    pub fn acquire(&self, on_loading: Option<&dyn Fn()>) -> Result<Endpoint, String> {
        let inner = &self.inner;
        let mut state = inner.state.lock().unwrap();
        state.users += 1;
        state.idle_generation += 1;
        state = inner.changed.wait_while(state, |state| state.stopping).unwrap();
        // A server that died since its last turn is started again.
        if state.child.as_mut().is_some_and(|child| !matches!(child.try_wait(), Ok(None))) {
            state.child = None;
            state.endpoint = None;
        }
        if let Some(endpoint) = &state.endpoint {
            return Ok(endpoint.clone());
        }
        if let Some(notify) = on_loading {
            notify();
        }
        if state.loading {
            // Another turn is loading it: wait for that load's outcome.
            state = inner.changed.wait_while(state, |state| state.loading).unwrap();
            return match state.endpoint.clone() {
                Some(endpoint) => Ok(endpoint),
                None => {
                    drop(state);
                    self.release();
                    Err("The local model could not start.".to_string())
                }
            };
        }
        state.loading = true;
        drop(state);
        let started = self.start();
        let mut state = inner.state.lock().unwrap();
        state.loading = false;
        if let Ok(endpoint) = &started {
            state.endpoint = Some(endpoint.clone());
        }
        drop(state);
        inner.changed.notify_all();
        if started.is_err() {
            self.release();
        }
        started
    }

    pub fn release(&self) {
        let mut state = self.inner.state.lock().unwrap();
        state.users = state.users.saturating_sub(1);
        if state.users > 0 || state.child.is_none() {
            return;
        }
        state.idle_generation += 1;
        let (generation, model, idle) = (state.idle_generation, self.clone(), Duration::from_millis(self.inner.config.idle_ms));
        std::thread::spawn(move || {
            std::thread::sleep(idle);
            let unused = {
                let state = model.inner.state.lock().unwrap();
                state.idle_generation == generation && state.users == 0
            };
            if unused {
                model.stop("idle");
            }
        });
    }

    fn start(&self) -> Result<Endpoint, String> {
        let inner = &self.inner;
        let port = free_port()?;
        let key = crate::random::hex(&crate::random::bytes::<32>());
        let endpoint = Endpoint { address: SocketAddr::from(([127, 0, 0, 1], port)), key: key.clone() };
        {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&inner.slot_dir)
                .map_err(|error| format!("The local model could not start: {error}"))?;
            let _ = std::fs::set_permissions(&inner.slot_dir, std::fs::Permissions::from_mode(0o700));
            // A save that a kill interrupted left this behind; no record names it.
            let _ = std::fs::remove_file(inner.slot_dir.join(SLOT_SAVING));
        }
        let mut child = Command::new(&inner.config.server)
            .args([
                "--model",
                &inner.config.model.to_string_lossy(),
                "--alias",
                &self.name(),
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--api-key",
                &key,
            ])
            // One slot: one request at a time, with the whole context and everything the slot has read.
            // It is why a turn waits for a handoff note being written (CONTRACTS.md "Local model").
            .args(["--n-gpu-layers", "99", "--ctx-size", &inner.config.context_size.to_string(), "--parallel", "1"])
            .args(["--batch-size", "2048", "--ubatch-size", "2048", "--jinja", "--no-webui"])
            .arg("--slot-save-path")
            .arg(format!("{}/", inner.slot_dir.display()))
            .env_clear()
            .envs(&inner.env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("The local model could not start: {error}"))?;
        let pid = child.id();
        let tail = Arc::new(Mutex::new(String::new()));
        // Closed when stderr has been read to its end.
        let (drained, stderr_end) = mpsc::channel::<()>();
        if let Some(mut stderr) = child.stderr.take() {
            let tail = tail.clone();
            std::thread::spawn(move || {
                let _drained = drained;
                let mut buffer = [0u8; 4096];
                while let Ok(read) = stderr.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    let mut kept = tail.lock().unwrap();
                    kept.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    let mut cut = kept.len().saturating_sub(STDERR_TAIL);
                    while !kept.is_char_boundary(cut) {
                        cut += 1;
                    }
                    kept.drain(..cut);
                }
            });
        }
        inner.state.lock().unwrap().child = Some(child);
        inner.logger.info("local model starting", json!({ "model": inner.config.model.to_string_lossy(), "pid": pid }));
        let started = Instant::now();
        while started.elapsed() < LOAD_TIMEOUT {
            let exited = {
                let mut state = inner.state.lock().unwrap();
                match state.child.as_mut().map(Child::try_wait) {
                    Some(Ok(None)) => None,
                    Some(Ok(Some(status))) => {
                        use std::os::unix::process::ExitStatusExt;
                        state.child = None;
                        Some(match (status.code(), status.signal()) {
                            (Some(code), _) => format!("exited with status {code}"),
                            (None, signal) => format!("exited with signal {}", crate::process::signal_name(signal.unwrap_or(0))),
                        })
                    }
                    // Stopped (daemon shutdown) while it loaded.
                    _ => Some("stopped".to_string()),
                }
            };
            if let Some(why) = exited {
                // Its last words may still be in the pipe; a descendant holding the pipe open is not waited for.
                let _ = stderr_end.recv_timeout(Duration::from_secs(1));
                let tail = tail.lock().unwrap();
                let lines: Vec<&str> = tail.trim().lines().collect();
                let last = lines[lines.len().saturating_sub(4)..].join("\n");
                return Err(format!("The local model could not start: {why}{}", if last.is_empty() { String::new() } else { format!("\n{last}") }));
            }
            let health = send(ClientRequest {
                address: endpoint.address,
                method: "GET",
                target: "/health",
                headers: &[],
                body: None,
                timeout: Some(Duration::from_secs(2)),
                abort: None,
            });
            if health.is_ok_and(|response| response.status == 200) {
                self.restore_slot(&endpoint);
                inner.logger.info("local model ready", json!({ "seconds": started.elapsed().as_secs() }));
                return Ok(endpoint);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        self.stop("load timed out");
        Err("The local model took too long to load.".to_string())
    }

    /// Stop the server now, saving its slot first; the next local turn starts it again and restores it.
    pub fn stop(&self, why: &str) {
        let endpoint = {
            let mut state = self.inner.state.lock().unwrap();
            state.idle_generation += 1;
            let endpoint = state.endpoint.take();
            // A server still loading has no endpoint, and its load is what this ends: nothing waits on that.
            state.stopping = endpoint.is_some();
            endpoint
        };
        if let Some(endpoint) = &endpoint {
            self.save_slot(endpoint);
        }
        self.end_server(why);
        self.inner.state.lock().unwrap().stopping = false;
        self.inner.changed.notify_all();
    }

    fn end_server(&self, why: &str) {
        let child = self.inner.state.lock().unwrap().child.take();
        let Some(mut child) = child else { return };
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        self.inner.logger.info("local model stopping", json!({ "why": why, "pid": child.id() }));
        // SAFETY: the pid of a child this process spawned and has not reaped.
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        let asked = Instant::now();
        while matches!(child.try_wait(), Ok(None)) {
            if asked.elapsed() >= STOP_GRACE {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ghost-local-model-{}", crate::random::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn model(directory: &Path, server: &str) -> LocalModel {
        let config = LocalModelConfig {
            model: directory.join("Gemma-Test.GGUF"),
            server: directory.join(server).to_string_lossy().into_owned(),
            context_size: 1024,
            idle_ms: 60_000,
            reasoning_effort: "low".to_string(),
        };
        LocalModel::new(config, Logger::silent(), crate::env::current())
    }

    #[test]
    fn fails_to_start_cleanly_when_llama_server_is_missing_and_stopping_still_returns() {
        let directory = scratch();
        let model = model(&directory, "no-such-llama-server");
        let told = std::cell::Cell::new(0);
        let error = model.acquire(Some(&|| told.set(told.get() + 1))).unwrap_err();
        assert!(error.starts_with("The local model could not start: "), "{error}");
        // The caller was told it would wait, and holds nothing after the failure.
        assert_eq!(told.get(), 1);
        assert_eq!(model.inner.state.lock().unwrap().users, 0);
        let started = Instant::now();
        model.stop("test");
        model.release();
        assert!(started.elapsed() < Duration::from_secs(3));
        // The next turn tries again, and fails the same way.
        assert!(model.acquire(None).unwrap_err().contains("could not start"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_server_that_exits_while_loading_is_reported_with_its_last_words() {
        let directory = scratch();
        let script = directory.join("llama-server");
        std::fs::write(
            &script,
            "#!/bin/sh\nfor line in one two three four; do echo \"$line\" >&2; done\necho 'error: cannot open the model' >&2\nexit 3\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let model = model(&directory, "llama-server");
        let error = model.acquire(None).unwrap_err();
        // The status, and the last four lines it wrote.
        assert_eq!(error, "The local model could not start: exited with status 3\ntwo\nthree\nfour\nerror: cannot open the model");
        let state = model.inner.state.lock().unwrap();
        assert!(state.child.is_none() && state.endpoint.is_none() && !state.loading && state.users == 0);
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn names_the_model_by_its_file_without_the_extension() {
        let directory = PathBuf::from("/nowhere");
        assert_eq!(model(&directory, "llama-server").name(), "Gemma-Test");
        let named = |file: &str| {
            let config = LocalModelConfig { model: PathBuf::from(file), ..model(&directory, "x").config().clone() };
            LocalModel::new(config, Logger::silent(), Env::new()).name()
        };
        assert_eq!(named("/models/gemma-3-27b.Q4_K_M.gguf"), "gemma-3-27b.Q4_K_M");
        assert_eq!(named("/models/plain"), "plain");
        assert_eq!(named("/models/é.gguf"), "é");
    }

    #[test]
    fn hands_out_ports_below_the_ephemeral_range() {
        for _ in 0..8 {
            assert!(PORT_RANGE.contains(&free_port().unwrap()));
        }
    }

    /// A stand-in llama-server for the slot calls: it keeps each one asked
    /// of it and, as the real one does, writes a save itself to the name it
    /// is given under the slot directory. `fail` makes it answer 500 after
    /// writing half a save.
    struct SlotServer {
        server: crate::http::Server,
        seen: Arc<Mutex<Vec<(String, String, String)>>>,
        fail: Arc<Mutex<bool>>,
    }

    impl SlotServer {
        fn start(slot_dir: PathBuf) -> Self {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let fail = Arc::new(Mutex::new(false));
            let (kept, failing) = (seen.clone(), fail.clone());
            let server = crate::http::Server::start("127.0.0.1:0".parse().unwrap(), move |mut request, responder| {
                let body = request.read_body(4096).unwrap_or_default();
                let action = request.query("action").unwrap_or("").to_string();
                let file = serde_json::from_slice::<Value>(&body).ok().and_then(|body| body["filename"].as_str().map(str::to_string));
                kept.lock().unwrap().push((request.path.clone(), action.clone(), file.clone().unwrap_or_default()));
                let fail = *failing.lock().unwrap();
                if let Some(file) = file.filter(|_| action == "save") {
                    std::fs::write(slot_dir.join(file), if fail { "half a sl" } else { "a whole slot" }).unwrap();
                }
                responder.json(if fail { 500 } else { 200 }, &json!({}));
            })
            .unwrap();
            Self { server, seen, fail }
        }

        fn endpoint(&self) -> Endpoint {
            Endpoint { address: self.server.address, key: "k".to_string() }
        }
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn saves_its_slot_before_a_stop_and_restores_it_only_for_the_same_model_and_context() {
        let directory = scratch();
        let env = Env::from([("HOME".to_string(), directory.display().to_string())]);
        let config = model(&directory, "llama-server").config().clone();
        let slot_dir = directory.join(".cache/ghost/slot");
        std::fs::create_dir_all(&slot_dir).unwrap();
        let server = SlotServer::start(slot_dir.clone());
        let endpoint = server.endpoint();
        let held = LocalModel::with_endpoint(config.clone(), Logger::silent(), env.clone(), endpoint.clone());
        assert_eq!(held.inner.slot_dir, slot_dir);
        held.stop("idle");
        // Saved under another name, and the slot's only once whole: private, with its record.
        assert_eq!(*server.seen.lock().unwrap(), [("/slots/0".to_string(), "save".to_string(), SLOT_SAVING.to_string())]);
        assert_eq!(files(&slot_dir), [SLOT_FILE, SLOT_FROM]);
        assert_eq!(std::fs::read_to_string(slot_dir.join(SLOT_FILE)).unwrap(), "a whole slot");
        let from = slot_dir.join(SLOT_FROM);
        assert_eq!(serde_json::from_str::<Value>(&std::fs::read_to_string(&from).unwrap()).unwrap(), held.slot_origin());
        for file in [SLOT_FILE, SLOT_FROM] {
            assert_eq!(std::fs::metadata(slot_dir.join(file)).unwrap().permissions().mode() & 0o777, 0o600, "{file}");
        }

        // The same model at the same context restores it; another context does not ask.
        held.restore_slot(&endpoint);
        assert_eq!(*server.seen.lock().unwrap().last().unwrap(), ("/slots/0".to_string(), "restore".to_string(), SLOT_FILE.to_string()));
        let other = LocalModel::with_endpoint(LocalModelConfig { context_size: 2048, ..config }, Logger::silent(), env, endpoint.clone());
        other.restore_slot(&endpoint);
        assert_eq!(server.seen.lock().unwrap().len(), 2);
        server.server.close();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_save_that_fails_or_is_interrupted_leaves_no_slot_to_restore() {
        let directory = scratch();
        let env = Env::from([("HOME".to_string(), directory.display().to_string())]);
        let config = model(&directory, "no-such-llama-server").config().clone();
        let slot_dir = directory.join(".cache/ghost/slot");
        std::fs::create_dir_all(&slot_dir).unwrap();
        let server = SlotServer::start(slot_dir.clone());
        let endpoint = server.endpoint();
        // A whole slot from an earlier stop, then a save the server fails half-way.
        LocalModel::with_endpoint(config.clone(), Logger::silent(), env.clone(), endpoint.clone()).stop("idle");
        assert_eq!(files(&slot_dir), [SLOT_FILE, SLOT_FROM]);
        *server.fail.lock().unwrap() = true;
        let failing = LocalModel::with_endpoint(config.clone(), Logger::silent(), env.clone(), endpoint.clone());
        failing.stop("idle");
        assert_eq!(files(&slot_dir), Vec::<String>::new());
        failing.restore_slot(&endpoint);
        assert!(server.seen.lock().unwrap().iter().all(|(_, action, _)| action == "save"));

        // Killed mid-save: half a file under the saving name, and the record already gone. The next start clears it.
        std::fs::write(slot_dir.join(SLOT_SAVING), "half a sl").unwrap();
        let next = LocalModel::new(config, Logger::silent(), env);
        assert!(next.acquire(None).unwrap_err().contains("could not start"));
        assert_eq!(files(&slot_dir), Vec::<String>::new());
        server.server.close();
        std::fs::remove_dir_all(directory).unwrap();
    }

    // The stop path: the slot's save, then the server's exit; a turn's command is ended beside them.
    #[test]
    fn the_units_stop_deadline_is_past_everything_a_stop_waits_for() {
        let unit = include_str!("../contrib/ghostd.service");
        let deadline = unit.lines().find_map(|line| line.strip_prefix("TimeoutStopSec=")?.strip_suffix('s')?.parse::<u64>().ok());
        let waits = SLOT_TIMEOUT + STOP_GRACE + crate::process::KILL_GRACE;
        assert!(deadline.expect("a TimeoutStopSec in seconds") >= waits.as_secs() + 20, "{deadline:?} against {waits:?}");
    }

    #[test]
    fn an_endpoint_already_running_is_held_and_released_without_a_process() {
        let endpoint = Endpoint { address: "127.0.0.1:9".parse().unwrap(), key: "k".to_string() };
        let held =
            LocalModel::with_endpoint(model(Path::new("/nowhere"), "llama-server").config().clone(), Logger::silent(), Env::new(), endpoint.clone());
        // Nobody waits for a load, so nobody is told of one.
        assert_eq!(held.acquire(Some(&|| panic!("told of a load"))), Ok(endpoint.clone()));
        assert_eq!(held.acquire(None), Ok(endpoint));
        held.release();
        held.release();
        let state = held.inner.state.lock().unwrap();
        assert!(state.users == 0 && state.child.is_none() && state.endpoint.is_some());
    }
}
