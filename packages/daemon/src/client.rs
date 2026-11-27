//! A client of ghostd's HTTP API, for the `ghost` command and the bar: where
//! the daemon listens, the bearer token, JSON round-trips and event streams.
//! The daemon is found the way it finds itself (its config and environment,
//! and the token file), and found again once when it stops answering there.
use crate::abort::Abort;
use crate::config::{Overrides, load_config};
use crate::env::Env;
use crate::http::{ClientRequest, ClientResponse, EventReader, send};
use crate::token::{api_token_path, read_api_token};
use serde_json::Value;
use std::fmt;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A control request is a small JSON round-trip the daemon answers immediately,
/// so a short cap catches a daemon that is gone rather than one that is busy.
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
/// An accepted event stream sends its head at once. Allow one keepalive
/// interval for admission and that opening; after it, reads wait for ever, so
/// this never caps working time.
const STREAM_OPEN_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// Nothing answered at the daemon's address, or the answer was cut off: why.
    Unreachable(String),
    /// The daemon refused the token in `token_path` (or there is none).
    Unauthorized { token_path: PathBuf },
    /// Any other refusal, with ghostd's `{ error: { code, message } }` when it sent one.
    Status { status: u16, code: Option<String>, message: String },
    /// The daemon's config, `$GHOSTD_PORT` or the token file cannot be used as it is.
    Configuration(String),
    /// The daemon answered with something that is not its API.
    Protocol(String),
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(why) => write!(f, "cannot reach ghostd: {why}"),
            Self::Unauthorized { token_path } => {
                write!(f, "unauthorized; run `ghostd api-token` as the machine owner (token file: {})", token_path.display())
            }
            Self::Status { message, .. } | Self::Configuration(message) | Self::Protocol(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ClientError {}

fn unreachable(error: &io::Error) -> ClientError {
    // A deadline that passed reads as the kernel's "resource temporarily unavailable"; say what happened instead.
    ClientError::Unreachable(match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => "the request timed out".to_string(),
        _ => error.to_string(),
    })
}

/// A response body: null when empty, JSON when it parses, else its text.
fn body_of(response: &mut ClientResponse) -> Result<Value, ClientError> {
    let text = response.text(u64::MAX).map_err(|error| unreachable(&error))?;
    if text.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

#[derive(Clone)]
pub struct Client {
    env: Env,
    home: PathBuf,
    address: SocketAddr,
    token_path: PathBuf,
    token: Option<String>,
}

impl Client {
    /// Find the daemon: `env` is the caller's environment and `home` the owner's home directory.
    pub fn discover(env: &Env, home: &Path) -> Result<Self, ClientError> {
        let config = load_config(&Overrides::default(), env, home)
            .map_err(|error| ClientError::Configuration(format!("invalid daemon configuration: {error}")))?;
        let token_path = api_token_path(env, home);
        let token = read_api_token(&token_path).map_err(ClientError::Configuration)?;
        Ok(Self { env: env.clone(), home: home.to_path_buf(), address: SocketAddr::from((Ipv4Addr::LOCALHOST, config.port)), token_path, token })
    }

    /// `http://127.0.0.1:<port>`.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub fn token_path(&self) -> &Path {
        &self.token_path
    }

    /// One request and its response head. A 401 is asked again once with the
    /// daemon found afresh, since the token may have been replaced; so is a
    /// request that reached nothing, when the daemon has moved to another port.
    fn open(
        &mut self,
        method: &str,
        target: &str,
        body: Option<&Value>,
        accept: &str,
        timeout: Option<Duration>,
        abort: Option<&Abort>,
    ) -> Result<ClientResponse, ClientError> {
        let body = body.map(|body| body.to_string().into_bytes());
        let mut found_again = false;
        loop {
            let bearer = self.token.as_ref().map(|token| format!("Bearer {token}"));
            let mut headers = vec![("accept", accept)];
            if body.is_some() {
                headers.push(("content-type", "application/json"));
            }
            if let Some(bearer) = &bearer {
                headers.push(("authorization", bearer));
            }
            let result = send(ClientRequest { address: self.address, method, target, headers: &headers, body: body.as_deref(), timeout, abort });
            // A request that timed out may have been taken; only one that never connected is sent again.
            let refused = match &result {
                Ok(response) => response.status == 401,
                Err(error) => error.kind() == io::ErrorKind::ConnectionRefused,
            };
            if refused && !found_again {
                found_again = true;
                let found = Self::discover(&self.env, &self.home)?;
                if result.is_ok() || found.address != self.address {
                    *self = found;
                    continue;
                }
            }
            let mut response = result.map_err(|error| unreachable(&error))?;
            return match response.status {
                200..300 => Ok(response),
                401 => Err(ClientError::Unauthorized { token_path: self.token_path.clone() }),
                status => {
                    let error = &body_of(&mut response)?["error"];
                    let message = error["message"].as_str().filter(|message| !message.trim().is_empty());
                    Err(ClientError::Status {
                        status,
                        code: error["code"].as_str().map(str::to_string),
                        message: message.map_or_else(|| format!("daemon returned HTTP {status}"), str::to_string),
                    })
                }
            };
        }
    }

    /// A JSON round-trip. `timeout` bounds connecting and the wait for the
    /// answer ([`CONTROL_TIMEOUT`] for anything the daemon answers at once);
    /// None waits for ever, the caller bounding the call.
    pub fn request(&mut self, method: &str, path: &str, body: Option<&Value>, timeout: Option<Duration>) -> Result<Value, ClientError> {
        body_of(&mut self.open(method, path, body, "application/json", timeout, None)?)
    }

    /// Open an event stream (a POST when there is a body) and hand each
    /// event's JSON to `on_event` until the daemon ends the stream, or `abort`
    /// is aborted from another thread, which closes the connection and
    /// returns Ok. A turn is not stopped by leaving its stream.
    pub fn stream(&mut self, path: &str, body: Option<&Value>, abort: Option<&Abort>, on_event: &mut dyn FnMut(&Value)) -> Result<(), ClientError> {
        let aborted = || abort.is_some_and(Abort::is_aborted);
        let method = if body.is_some() { "POST" } else { "GET" };
        let response = match self.open(method, path, body, "text/event-stream", Some(STREAM_OPEN_TIMEOUT), abort) {
            Err(ClientError::Unreachable(_)) if aborted() => return Ok(()),
            opened => opened?,
        };
        // The head is in: from here a silent stream is a turn at work, not a dead daemon.
        response.set_read_timeout(None).map_err(|error| unreachable(&error))?;
        let mut events = EventReader::new(response.body);
        loop {
            match events.next_event() {
                _ if aborted() => return Ok(()),
                Ok(Some(data)) if data.trim().is_empty() => {}
                Ok(Some(data)) => {
                    on_event(&serde_json::from_str(&data).map_err(|_| ClientError::Protocol("daemon sent invalid SSE JSON".to_string()))?)
                }
                Ok(None) => return Ok(()),
                Err(error) => return Err(unreachable(&error)),
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::http::Server;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};

    const WAIT: Duration = Duration::from_secs(20);

    fn token(letter: char) -> String {
        letter.to_string().repeat(64)
    }

    /// A scratch home whose config names the daemon's port and whose token file holds `letter`.
    struct Scratch {
        dir: PathBuf,
        env: Env,
    }

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("ghost-client-{}", crate::random::uuid()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = |name: &str| dir.join(name).display().to_string();
            let env = Env::from([("GHOSTD_CONFIG".to_string(), path("config.json")), ("GHOSTD_API_TOKEN_FILE".to_string(), path("api-token"))]);
            Self { dir, env }
        }

        fn point_at(&self, port: u16, letter: char) {
            std::fs::write(self.dir.join("config.json"), json!({ "port": port }).to_string()).unwrap();
            let file = self.dir.join("api-token");
            std::fs::write(&file, format!("{}\n", token(letter))).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        fn client(&self) -> Client {
            Client::discover(&self.env, &self.dir).unwrap()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A loopback port that refuses every connection for as long as this is held:
    /// bound, so no other test is given it, and never listening.
    pub(crate) struct Refusing {
        _socket: std::os::fd::OwnedFd,
        pub port: u16,
    }

    pub(crate) fn refusing() -> Refusing {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        // SAFETY: a new socket, owned from here on; the address is plain data of the size passed.
        unsafe {
            let socket = OwnedFd::from_raw_fd(libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0));
            let mut address: libc::sockaddr_in = std::mem::zeroed();
            address.sin_family = libc::AF_INET as libc::sa_family_t;
            address.sin_addr.s_addr = u32::from(std::net::Ipv4Addr::LOCALHOST).to_be();
            let mut size = size_of::<libc::sockaddr_in>() as libc::socklen_t;
            assert_eq!(libc::bind(socket.as_raw_fd(), (&raw const address).cast(), size), 0);
            assert_eq!(libc::getsockname(socket.as_raw_fd(), (&raw mut address).cast(), &mut size), 0);
            Refusing { _socket: socket, port: u16::from_be(address.sin_port) }
        }
    }

    /// A daemon that answers `{ "ok": true }` to the token `a` and 401 to any other, counting what it is asked.
    fn guarded() -> (Server, Arc<Mutex<usize>>) {
        let asked = Arc::new(Mutex::new(0));
        let count = asked.clone();
        let server = Server::start("127.0.0.1:0".parse().unwrap(), move |request, responder| {
            *count.lock().unwrap() += 1;
            if request.header("authorization") == Some(&format!("Bearer {}", token('a'))) {
                responder.json(200, &json!({ "ok": true }));
            } else {
                responder.json(401, &json!({ "error": { "code": "unauthorized", "message": "Unauthorized." } }));
            }
        })
        .unwrap();
        (server, asked)
    }

    // The bar outlives a restart of ghostd on another port with another token: one client keeps working.
    #[test]
    fn finds_the_daemon_again_once_when_it_moved_or_its_token_was_replaced() {
        let scratch = Scratch::new();
        let (old, asked_old) = guarded();
        scratch.point_at(old.address.port(), 'a');
        let mut client = scratch.client();
        assert_eq!(client.request("GET", "/api/status", None, Some(WAIT)), Ok(json!({ "ok": true })));
        assert_eq!((client.base_url(), client.token_path()), (format!("http://{}", old.address), scratch.dir.join("api-token").as_path()));

        // Its token replaced under the client: the 401 is asked again with the new one.
        let mut stale = scratch.client();
        stale.token = Some(token('b'));
        assert_eq!(stale.request("GET", "/api/status", None, Some(WAIT)), Ok(json!({ "ok": true })));
        assert_eq!(*asked_old.lock().unwrap(), 3);
        old.close();

        // The daemon restarted on another port, which the config now names: nothing answers where the client last found it.
        let nobody = refusing();
        scratch.point_at(nobody.port, 'a');
        let mut moved = scratch.client();
        assert!(matches!(moved.request("GET", "/api/status", None, Some(WAIT)), Err(ClientError::Unreachable(_))));
        let (new, asked_new) = guarded();
        scratch.point_at(new.address.port(), 'a');
        assert_eq!(moved.request("GET", "/api/status", None, Some(WAIT)), Ok(json!({ "ok": true })));
        assert_eq!((moved.base_url(), *asked_new.lock().unwrap()), (format!("http://{}", new.address), 1));

        // A token the daemon still refuses is asked twice and no more; a refusal says which file.
        scratch.point_at(new.address.port(), 'b');
        assert_eq!(
            scratch.client().request("GET", "/api/status", None, Some(WAIT)),
            Err(ClientError::Unauthorized { token_path: scratch.dir.join("api-token") })
        );
        assert_eq!(*asked_new.lock().unwrap(), 3);
        new.close();
    }

    #[test]
    fn a_port_or_config_it_cannot_use_is_an_error_and_never_the_default_port() {
        let scratch = Scratch::new();
        let refused = |env: &Env| Client::discover(env, &scratch.dir).err().map(|error| error.to_string()).unwrap_or_default();
        let mut env = scratch.env.clone();
        env.insert("GHOSTD_PORT".into(), "70000".into());
        assert_eq!(refused(&env), "invalid daemon configuration: Invalid port from GHOSTD_PORT: \"70000\"");
        std::fs::write(scratch.dir.join("config.json"), "{ not json").unwrap();
        assert!(refused(&scratch.env).starts_with("invalid daemon configuration: "), "{}", refused(&scratch.env));
        std::fs::write(scratch.dir.join("config.json"), "{}").unwrap();
        std::fs::write(scratch.dir.join("api-token"), "short\n").unwrap();
        std::fs::set_permissions(scratch.dir.join("api-token"), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(Client::discover(&scratch.env, &scratch.dir), Err(ClientError::Configuration(message)) if message.contains("is malformed")));
    }

    #[test]
    fn a_stream_hands_over_each_event_and_is_stopped_from_another_thread() {
        let scratch = Scratch::new();
        let released = Abort::new();
        let hold = released.clone();
        let server = Server::start("127.0.0.1:0".parse().unwrap(), move |request, responder| {
            let mut stream = responder.event_stream().unwrap();
            stream.write(&format!("data: {}\n\n", json!({ "type": "start", "path": request.path }))).unwrap();
            // The turn goes on: nothing more is sent, and the stream stays open.
            hold.wait(WAIT);
        })
        .unwrap();
        scratch.point_at(server.address.port(), 'a');
        let mut client = scratch.client();
        let (abort, mut seen) = (Abort::new(), Vec::new());
        let result = client.stream("/api/messages", Some(&json!({ "prompt": "hi" })), Some(&abort), &mut |event| {
            seen.push(event.clone());
            // Any thread may stop it; here the one that is reading does.
            let stop = abort.clone();
            std::thread::spawn(move || stop.abort());
        });
        assert_eq!((result, seen), (Ok(()), vec![json!({ "type": "start", "path": "/api/messages" })]));
        released.abort();
        server.close();
    }
}
