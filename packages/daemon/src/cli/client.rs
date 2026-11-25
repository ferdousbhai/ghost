//! The CLI's side of the daemon's HTTP API: where ghostd listens, the bearer
//! token, JSON round-trips, event streams, and how each failure becomes an
//! exit code and a sentence.
use super::CliError;
use crate::config::{Overrides, load_config};
use crate::env::Env;
use crate::http::{ClientRequest, ClientResponse, EventReader, send};
use crate::token::{api_token_path, read_api_token};
use serde_json::Value;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A control request is a small JSON round-trip the daemon answers immediately,
/// so a short cap catches a daemon that is gone rather than one that is busy.
pub const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_millis(5_000);
/// An accepted event stream sends its head at once. Allow one keepalive
/// interval for admission and that opening; after it, reads wait for ever, so
/// this never caps working time.
const STREAM_OPEN_TIMEOUT: Duration = Duration::from_millis(15_000);

pub const EXIT_SUCCESS: i32 = 0;
pub const EXIT_FAILURE: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_UNREACHABLE: i32 = 3;
pub const EXIT_UNAUTHORIZED: i32 = 4;
pub const EXIT_NOT_FOUND: i32 = 5;
pub const EXIT_CONFLICT: i32 = 6;
pub const EXIT_INTERRUPTED: i32 = 130;

/// Every exit code and what it means, as `ghost help exit-codes` prints them.
pub const EXIT_CODES: &[(i32, &str)] = &[
    (EXIT_SUCCESS, "success"),
    (EXIT_FAILURE, "turn or action failed"),
    (EXIT_USAGE, "usage error"),
    (EXIT_UNREACHABLE, "daemon unreachable"),
    (EXIT_UNAUTHORIZED, "unauthorized"),
    (EXIT_NOT_FOUND, "not found"),
    (EXIT_CONFLICT, "busy or conflict"),
    (EXIT_INTERRUPTED, "interrupted at the terminal (Ctrl-C)"),
];

pub fn not_found(what: &str) -> CliError {
    CliError::new(EXIT_NOT_FOUND, format!("{what} was not found"))
}

fn network_error(error: &io::Error) -> CliError {
    // A deadline that passed reads as the kernel's "resource temporarily unavailable"; say what happened instead.
    let why = match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => "the request timed out".to_string(),
        _ => error.to_string(),
    };
    CliError::new(EXIT_UNREACHABLE, format!("cannot reach ghostd: {why}"))
}

/// An HTTP refusal as an exit code, with ghostd's `{ error: { message, code } }` when it sent one.
fn status_error(status: u16, body: &Value, token_path: &Path) -> CliError {
    if status == 401 {
        return CliError::new(
            EXIT_UNAUTHORIZED,
            format!("unauthorized; run `ghostd api-token` as the machine owner (token file: {})", token_path.display()),
        );
    }
    let error = body.get("error");
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .map_or_else(|| format!("daemon returned HTTP {status}"), str::to_string);
    let exit_code = match status {
        403 => EXIT_UNAUTHORIZED,
        404 => EXIT_NOT_FOUND,
        409 => EXIT_CONFLICT,
        _ => EXIT_FAILURE,
    };
    CliError { exit_code, message, code: error.and_then(|error| error.get("code")).and_then(Value::as_str).map(str::to_string) }
}

/// A response body: null when empty, JSON when it parses, else its text.
fn response_body(response: &mut ClientResponse) -> Result<Value, CliError> {
    let text = response.text(u64::MAX).map_err(|error| network_error(&error))?;
    if text.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

fn ok(status: u16) -> bool {
    (200..300).contains(&status)
}

#[derive(Clone)]
pub struct DaemonClient {
    /// `http://127.0.0.1:<port>`, as `ghost status` prints it.
    pub base_url: String,
    pub token_path: PathBuf,
    address: SocketAddr,
    token: Option<String>,
}

impl DaemonClient {
    /// Find the daemon the way the daemon finds itself: its config and environment, and the token file.
    pub fn new(env: &Env, home: &Path) -> Result<Self, CliError> {
        let config =
            load_config(&Overrides::default(), env, home).map_err(|error| CliError::usage(format!("invalid daemon configuration: {error}")))?;
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, config.port));
        let token_path = api_token_path(env, home);
        let token = read_api_token(&token_path).map_err(CliError::failure)?;
        Ok(Self { base_url: format!("http://{address}"), token_path, address, token })
    }

    /// One request, sent again once with the token re-read when the daemon
    /// answers 401: the owner may have replaced the token since it was read.
    fn fetch(
        &mut self,
        method: &str,
        target: &str,
        body: Option<&[u8]>,
        accept: &str,
        timeout: Option<Duration>,
    ) -> Result<ClientResponse, CliError> {
        for retry in [true, false] {
            let bearer = self.token.as_ref().map(|token| format!("Bearer {token}"));
            let mut headers = vec![("accept", accept)];
            if body.is_some() {
                headers.push(("content-type", "application/json"));
            }
            if let Some(bearer) = &bearer {
                headers.push(("authorization", bearer));
            }
            let request = ClientRequest { address: self.address, method, target, headers: &headers, body, timeout, abort: None };
            let response = send(request).map_err(|error| network_error(&error))?;
            if response.status != 401 || !retry {
                return Ok(response);
            }
            self.token = read_api_token(&self.token_path).map_err(CliError::failure)?;
        }
        unreachable!("the second attempt always returns")
    }

    /// A JSON round-trip under the control deadline.
    pub fn request(&mut self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, CliError> {
        self.request_within(method, path, body, Some(CONTROL_REQUEST_TIMEOUT))
    }

    /// A JSON round-trip; `timeout` None waits for ever, the caller bounding the call.
    pub fn request_within(&mut self, method: &str, path: &str, body: Option<&Value>, timeout: Option<Duration>) -> Result<Value, CliError> {
        let bytes = body.map(|body| body.to_string().into_bytes());
        let mut response = self.fetch(method, path, bytes.as_deref(), "application/json", timeout)?;
        let parsed = response_body(&mut response)?;
        if !ok(response.status) {
            return Err(status_error(response.status, &parsed, &self.token_path));
        }
        Ok(parsed)
    }

    /// Open an event stream (a POST when there is a body) and hand each
    /// event's JSON to `on_event` until the daemon ends the stream.
    pub fn stream(&mut self, path: &str, body: Option<&Value>, on_event: &mut dyn FnMut(&Value)) -> Result<(), CliError> {
        let bytes = body.map(|body| body.to_string().into_bytes());
        let method = if body.is_some() { "POST" } else { "GET" };
        let mut response = self.fetch(method, path, bytes.as_deref(), "text/event-stream", Some(STREAM_OPEN_TIMEOUT))?;
        if !ok(response.status) {
            let parsed = response_body(&mut response)?;
            return Err(status_error(response.status, &parsed, &self.token_path));
        }
        // The head is in: from here a silent stream is a turn at work, not a dead daemon.
        response.set_read_timeout(None).map_err(|error| network_error(&error))?;
        let mut events = EventReader::new(response.body);
        loop {
            match events.next_event() {
                Ok(Some(data)) if data.trim().is_empty() => {}
                Ok(Some(data)) => {
                    let event: Value = serde_json::from_str(&data).map_err(|_| CliError::failure("daemon sent invalid SSE JSON"))?;
                    on_event(&event);
                }
                Ok(None) => return Ok(()),
                Err(error) => return Err(network_error(&error)),
            }
        }
    }
}
