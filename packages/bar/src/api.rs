//! ghostd's HTTP API, as the CLI reaches it: 127.0.0.1 on `$GHOSTD_PORT`, else `port` in
//! `~/.config/ghost/config.json`, else 7717, with the machine-local bearer token from `$GHOSTD_API_TOKEN_FILE`,
//! else `$XDG_STATE_HOME/ghost/api-token`. Each request runs on its own thread and answers on an async channel the
//! GTK main loop awaits, as lastbook-for-omarchy's engine does; a turn's server-sent events arrive one by one.

use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde_json::Value;

#[derive(Clone, Debug)]
pub struct ApiError {
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// One frame of a streamed turn.
pub enum Frame {
    Event(Value),
    Failed(ApiError),
    End,
}

/// Dropping or calling `stop` ends the stream's reading; the turn itself is stopped through the API.
#[derive(Clone)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn stop(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

#[derive(Clone)]
pub struct Api {
    base: String,
    token: String,
    agent: ureq::Agent,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn xdg(variable: &str, default: &str) -> PathBuf {
    match std::env::var_os(variable) {
        Some(value) if PathBuf::from(&value).is_absolute() => PathBuf::from(value),
        _ => home().join(default),
    }
}

pub fn config_dir() -> PathBuf {
    xdg("XDG_CONFIG_HOME", ".config").join("ghost")
}

fn port() -> u16 {
    if let Some(port) = std::env::var("GHOSTD_PORT").ok().and_then(|value| value.trim().parse().ok()) {
        return port;
    }
    std::fs::read_to_string(config_dir().join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|config| config.get("port").and_then(Value::as_u64))
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(7717)
}

fn token_path() -> PathBuf {
    match std::env::var("GHOSTD_API_TOKEN_FILE") {
        Ok(path) if !path.trim().is_empty() => PathBuf::from(path.trim()),
        _ => xdg("XDG_STATE_HOME", ".local/state").join("ghost").join("api-token"),
    }
}

/// The error body ghostd answers with, `{ error: { code, message } }`, or the transport's failure.
fn error_of(error: ureq::Error) -> ApiError {
    match error {
        ureq::Error::Status(_, response) => {
            let body: Value = response.into_json().unwrap_or(Value::Null);
            ApiError { message: body["error"]["message"].as_str().unwrap_or("ghostd refused the request.").to_string() }
        }
        ureq::Error::Transport(transport) => ApiError { message: format!("ghostd is not answering ({transport}). Is ghostd.service running?") },
    }
}

/// A path segment, percent-encoded so an id holding `/` or `:` stays one segment.
pub fn segment(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

impl Api {
    pub fn connect() -> Result<Api, String> {
        let path = token_path();
        let token = std::fs::read_to_string(&path)
            .map_err(|error| format!("Cannot read ghostd's token at {} ({error}). Is Ghost installed?", path.display()))?
            .trim()
            .to_string();
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).build();
        Ok(Api { base: format!("http://127.0.0.1:{}", port()), token, agent })
    }

    fn request(&self, method: &str, path: &str) -> ureq::Request {
        self.agent.request(method, &format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token))
    }

    /// One JSON request, run off the main loop.
    pub async fn call(&self, method: &'static str, path: String, body: Option<Value>) -> Result<Value, ApiError> {
        let (tx, rx) = async_channel::bounded(1);
        let request = self.request(method, &path).timeout(Duration::from_secs(120));
        std::thread::spawn(move || {
            let result = match body {
                Some(body) => request.send_json(body),
                None => request.call(),
            };
            let value =
                result.map_err(error_of).and_then(|response| response.into_json::<Value>().map_err(|error| ApiError { message: error.to_string() }));
            let _ = tx.send_blocking(value);
        });
        rx.recv().await.unwrap_or_else(|_| Err(ApiError { message: "The request was lost.".into() }))
    }

    pub async fn get(&self, path: String) -> Result<Value, ApiError> {
        self.call("GET", path, None).await
    }

    /// A turn's server-sent events (CONTRACTS.md "Turn wire"), one `Frame` each, then `End`.
    pub fn stream(&self, path: String, body: Option<Value>) -> (async_channel::Receiver<Frame>, Cancel) {
        let (tx, rx) = async_channel::unbounded();
        let cancel = Cancel(Arc::new(AtomicBool::new(false)));
        let stopped = cancel.0.clone();
        let request = self.request(if body.is_some() { "POST" } else { "GET" }, &path);
        std::thread::spawn(move || {
            let response = match body {
                Some(body) => request.send_json(body),
                None => request.call(),
            };
            match response {
                Err(error) => {
                    let _ = tx.send_blocking(Frame::Failed(error_of(error)));
                }
                Ok(response) => {
                    let mut data = String::new();
                    for line in BufReader::new(response.into_reader()).lines() {
                        if stopped.load(Ordering::Relaxed) {
                            break;
                        }
                        let Ok(line) = line else { break };
                        if let Some(rest) = line.strip_prefix("data:") {
                            data.push_str(rest.trim_start());
                        } else if line.is_empty() && !data.is_empty() {
                            if let Ok(event) = serde_json::from_str::<Value>(&data)
                                && tx.send_blocking(Frame::Event(event)).is_err()
                            {
                                break;
                            }
                            data.clear();
                        }
                    }
                }
            }
            let _ = tx.send_blocking(Frame::End);
        });
        (rx, cancel)
    }
}
