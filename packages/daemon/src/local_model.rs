//! The local model ghostd runs itself (CONTRACTS.md "Local model"): one
//! llama-server child on a loopback port chosen at spawn, with a fresh API key,
//! started by the first local turn and stopped after it has gone unused.
//! ghostd kills only the process it spawned.
use crate::config::LocalModelConfig;
use crate::env::Env;
use crate::http::{ClientRequest, send};
use crate::log::Logger;
use serde_json::json;
use std::io::Read;
use std::net::{SocketAddr, TcpListener};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

/// A 26B model from a cold disk takes about a minute; this bounds a hung load.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const STDERR_TAIL: usize = 4_096;
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
pub fn free_port() -> Result<u16, String> {
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

#[derive(Default)]
struct State {
    child: Option<Child>,
    endpoint: Option<Endpoint>,
    loading: bool,
    users: u32,
    /// Bumped whenever the idle clock restarts, so a superseded timer does nothing.
    idle_generation: u64,
}

struct Inner {
    config: LocalModelConfig,
    logger: Logger,
    env: Env,
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Clone)]
pub struct LocalModel {
    inner: Arc<Inner>,
}

fn url_safe_key() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    crate::random::bytes::<32>().iter().map(|byte| ALPHABET[usize::from(byte % 64)] as char).collect()
}

impl LocalModel {
    pub fn new(config: LocalModelConfig, logger: Logger, env: Env) -> Self {
        Self { inner: Arc::new(Inner { config, logger, env, state: Mutex::new(State::default()), changed: Condvar::new() }) }
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
        let key = url_safe_key();
        let endpoint = Endpoint { address: SocketAddr::from(([127, 0, 0, 1], port)), key: key.clone() };
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
            .args(["--n-gpu-layers", "99", "--ctx-size", &inner.config.context_size.to_string(), "--parallel", "1"])
            .args(["--batch-size", "2048", "--ubatch-size", "2048", "--jinja", "--no-webui"])
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
                inner.logger.info("local model ready", json!({ "seconds": started.elapsed().as_secs() }));
                return Ok(endpoint);
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        self.stop("load timed out");
        Err("The local model took too long to load.".to_string())
    }

    /// Stop the server now; the next local turn starts it again.
    pub fn stop(&self, why: &str) {
        let child = {
            let mut state = self.inner.state.lock().unwrap();
            state.idle_generation += 1;
            state.endpoint = None;
            state.child.take()
        };
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
    fn hands_out_ports_below_the_ephemeral_range_and_fresh_keys() {
        for _ in 0..8 {
            assert!(PORT_RANGE.contains(&free_port().unwrap()));
        }
        let (first, second) = (url_safe_key(), url_safe_key());
        assert!(first != second && first.len() == 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
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
