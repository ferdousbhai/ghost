//! The daemon's HTTP API (CONTRACTS.md "Daemon HTTP API"): the gate every
//! `/api` request passes, the routes, and the turn streams, which outlive the
//! response that started them so a cut or dropped client can resume.
use crate::abort::Abort;
use crate::attachments::MAX_ATTACHMENT_BYTES;
use crate::config::RemoteConfig;
use crate::conversation_log::require_conversation_id;
use crate::env::Env;
use crate::error::{GhostError, Result};
use crate::ghosts::Ghost;
use crate::home::{read_character, write_character};
use crate::hooks::HookRunner;
use crate::http::{Request, Responder, Server, percent_decode};
use crate::log::Logger;
use crate::persona::MAX_CHARACTER_BODY_LENGTH;
use crate::remote::{RemoteAccess, RemoteServe, Role, TailscaleIdentity};
use crate::running_source::{RunningSource, replaced_since_start};
use crate::session_host::{Emit, SessionHost};
use crate::token::{api_token_path, ensure_api_token, token_matches};
use crate::turn_buffer::{DEFAULT_MEMORY_LIMIT, TurnBuffer, spill_dir};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const DEFAULT_MAX_BODY_BYTES: usize = 1_048_576;
/// Where a turn response is cut, so no client holds one ever-growing body.
const DEFAULT_STREAM_CUT_BYTES: usize = 1_048_576;
/// How long an ended turn stays resumable, for a client cut just before the end.
const RESUME_GRACE: Duration = Duration::from_secs(60);
const SSE_KEEPALIVE_COMMENT: &str = ": keepalive\n\n";
pub const SSE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// The bearer token every private `/api` route requires.
pub enum ApiToken {
    /// Read from, and minted into, the XDG state token file: a client that
    /// reads that file is authenticated and a web page that cannot is not.
    File,
    /// Use this token, for tests that want to present one.
    Fixed(String),
    /// No authentication at all. **Test-only**, for tests whose subject is
    /// routing or streaming; nothing that ships may pass it.
    Off,
}

pub struct ServerOptions {
    /// The machine's one ghost.
    pub ghost: Ghost,
    pub host: SessionHost,
    /// What runs this daemon, as `GET /api/status` reports it.
    pub running_source: RunningSource,
    /// The owner's `hooks.json`, as `HookRunner::from_config` admitted it.
    pub hooks: Arc<HookRunner>,
    pub logger: Logger,
    pub max_body_bytes: Option<usize>,
    pub api_token: ApiToken,
    /// Callers reaching the daemon through `tailscale serve`; None admits none.
    pub remote: Option<Arc<RemoteAccess>>,
    /// Web app origins (`remote.apps`) admitted past the Origin check, with a
    /// tailnet identity only, never the bearer token.
    pub remote_apps: Vec<String>,
    /// Reads what Tailscale Serve exposes of this daemon.
    pub remote_serve: Arc<RemoteServe>,
    /// Response size for turn continuation and invalidation reconnects; about 1 MB by default.
    pub stream_cut_bytes: Option<usize>,
    pub port: u16,
    /// Where the token file and the turn spill directory are resolved from.
    pub env: Env,
    pub home: std::path::PathBuf,
}

impl ServerOptions {
    /// What a test needs: no authentication, no remote callers, any free port.
    pub fn for_test(ghost: Ghost, host: SessionHost, hooks: Arc<HookRunner>, env: Env, home: &Path) -> Self {
        let runner: crate::remote::TailscaleRunner = Arc::new(|_| Err(crate::process::CommandFailure::Missing));
        Self {
            ghost,
            host,
            running_source: RunningSource {
                version: crate::VERSION.to_string(),
                commit: None,
                root: None,
                entry: std::env::current_exe().unwrap_or_default(),
                started_at: crate::clock::now_ms(),
            },
            hooks,
            logger: Logger::silent(),
            max_body_bytes: None,
            api_token: ApiToken::Off,
            remote: None,
            remote_apps: Vec::new(),
            remote_serve: Arc::new(RemoteServe::new(0, &RemoteConfig::default(), runner)),
            stream_cut_bytes: None,
            port: 0,
            env,
            home: home.to_path_buf(),
        }
    }
}

struct TurnState {
    /// Each event SSE-encoded; once `ended`, the last is the terminal.
    frames: TurnBuffer,
    ended: bool,
    failure: Option<String>,
    followers: usize,
    /// Past its resume grace: disposed once the last follower leaves.
    expired: bool,
}

/// One turn's events, kept while it runs (and briefly after) so a cut response can resume.
struct TurnLog {
    id: String,
    conversation: String,
    state: Mutex<TurnState>,
    changed: Condvar,
}

fn encode_sse(event: &Value) -> String {
    format!("data: {event}\n\n")
}

struct Shared {
    options: ServerOptions,
    api_token: Option<String>,
    max_body_bytes: usize,
    stream_cut_bytes: usize,
    turn_logs: Mutex<HashMap<String, Arc<TurnLog>>>,
    /// Ends every open stream at shutdown.
    closing: Abort,
}

enum Reply {
    Json(u16, Value),
    Bytes {
        content_type: String,
        cache: &'static str,
        nosniff: bool,
        body: Vec<u8>,
    },
    /// The handler writes its own response (an event stream).
    Stream(Box<dyn FnOnce(Responder) + Send>),
}

fn ok(body: Value) -> Result<Reply> {
    Ok(Reply::Json(200, body))
}

#[derive(Clone, Copy, PartialEq)]
enum Route {
    Whoami,
    Machines,
    RemoteGet,
    HooksConfig,
    Status,
    GhostName,
    CharacterGet,
    CharacterPut,
    Complete,
    Messages,
    Events,
    Sessions,
    SessionDelete,
    Pin,
    PushPut,
    PushDelete,
    PushTest,
    Read,
    Title,
    AttachmentSave,
    AttachmentRead,
    Stream,
    Transcript,
    Stop,
    QueueGet,
    QueuePost,
}

/// `"GET PUT"`, `"api/sessions/:id/pin"`: a `:name` segment is a parameter.
const ROUTES: &[(&str, &str, Route)] = &[
    ("GET", "api/remote/whoami", Route::Whoami),
    ("GET", "api/remote/machines", Route::Machines),
    ("GET", "api/remote", Route::RemoteGet),
    ("GET PUT", "api/hooks/config", Route::HooksConfig),
    ("GET", "api/status", Route::Status),
    ("PUT", "api/push/subscription", Route::PushPut),
    ("DELETE", "api/push/subscription", Route::PushDelete),
    ("POST", "api/push/test", Route::PushTest),
    ("GET", "api/ghost", Route::GhostName),
    ("GET", "api/character", Route::CharacterGet),
    ("PUT", "api/character", Route::CharacterPut),
    ("POST", "api/complete", Route::Complete),
    ("POST", "api/messages", Route::Messages),
    ("GET", "api/events", Route::Events),
    ("GET", "api/sessions", Route::Sessions),
    ("DELETE", "api/sessions/:id", Route::SessionDelete),
    ("PUT", "api/sessions/:id/pin", Route::Pin),
    ("PUT", "api/sessions/:id/read", Route::Read),
    ("PUT", "api/sessions/:id/title", Route::Title),
    ("POST", "api/sessions/:id/attachments", Route::AttachmentSave),
    ("GET", "api/sessions/:id/attachments/:file", Route::AttachmentRead),
    ("GET", "api/sessions/:id/stream", Route::Stream),
    ("GET", "api/sessions/:id/transcript", Route::Transcript),
    ("POST", "api/sessions/:id/stop", Route::Stop),
    ("GET", "api/sessions/:id/queue", Route::QueueGet),
    ("POST", "api/sessions/:id/queue", Route::QueuePost),
];

enum Matched {
    Found(Route, HashMap<&'static str, String>),
    NotFound,
    MethodNotAllowed,
}

/// The route for this path and method; a path with no route for the method is a 405.
fn match_route(segments: &[&str], method: &str) -> Matched {
    let mut path_matched = false;
    for (methods, pattern, route) in ROUTES {
        let parts: Vec<&'static str> = pattern.split('/').collect();
        if parts.len() != segments.len() {
            continue;
        }
        let mut params = HashMap::new();
        let matches = parts.iter().zip(segments).all(|(part, segment)| match part.strip_prefix(':') {
            Some(name) => {
                params.insert(name, (*segment).to_string());
                true
            }
            None => part == segment,
        });
        if !matches {
            continue;
        }
        path_matched = true;
        if methods.split(' ').any(|allowed| allowed == method) {
            return Matched::Found(*route, params);
        }
    }
    if path_matched { Matched::MethodNotAllowed } else { Matched::NotFound }
}

fn bearer_token(header: Option<&str>) -> &str {
    let Some(header) = header else { return "" };
    let rest = header.trim_start_matches(' ');
    let Some(scheme) = rest.get(..6) else { return "" };
    if !scheme.eq_ignore_ascii_case("bearer") || !rest[6..].starts_with(' ') {
        return "";
    }
    let token = rest[6..].trim_matches(' ');
    if token.is_empty() || token.contains(char::is_whitespace) { "" } else { token }
}

/// A Content-Type header's media type, lowercased and without parameters.
fn media_type(header: Option<&str>) -> String {
    header.and_then(|header| header.split(';').next()).unwrap_or("").trim().to_ascii_lowercase()
}

/// `application/json`, or `image/*` for an attachment, parameters allowed
/// (`; charset=utf-8`). The point is to exclude the three types a form can post
/// without a preflight — `text/plain`, `application/x-www-form-urlencoded`,
/// `multipart/form-data` — so a mutating route cannot be reached by a simple
/// cross-site request.
fn is_preflighted_content_type(header: Option<&str>) -> bool {
    let kind = media_type(header);
    kind == "application/json" || kind.starts_with("image/")
}

/// A query parameter as a number, as JavaScript's `Number` reads it; None when absent.
fn number_param(request: &Request, key: &str) -> Result<Option<f64>> {
    let Some(raw) = request.query(key) else { return Ok(None) };
    let trimmed = raw.trim();
    let value = if trimmed.is_empty() { Some(0.0) } else { trimmed.parse::<f64>().ok().filter(|value| value.is_finite()) };
    value.map(Some).ok_or_else(|| GhostError::invalid(format!("\"{key}\" must be a number.")))
}

fn string_field<'a>(body: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    body.get(key).and_then(Value::as_str).ok_or_else(|| GhostError::invalid(format!("\"{key}\" must be a string.")))
}

fn boolean_field(body: &Map<String, Value>, key: &str) -> Result<bool> {
    body.get(key).and_then(Value::as_bool).ok_or_else(|| GhostError::invalid(format!("\"{key}\" must be a boolean.")))
}

struct Context<'a> {
    shared: &'a Arc<Shared>,
    request: Request,
    identity: Option<TailscaleIdentity>,
    params: HashMap<&'static str, String>,
    /// The route's `:id`, validated; empty where it has none.
    id: String,
}

impl Context<'_> {
    fn param(&self, name: &str) -> &str {
        self.params.get(name).map_or("", String::as_str)
    }

    fn json_body(&mut self) -> Result<Value> {
        let bytes = self.request.read_body(self.shared.max_body_bytes)?;
        serde_json::from_slice(&bytes).map_err(|_| GhostError::invalid("Request body must be JSON."))
    }

    /// The request's JSON object body, read within the size bound.
    fn body(&mut self) -> Result<Map<String, Value>> {
        match self.json_body()? {
            Value::Object(body) => Ok(body),
            _ => Err(GhostError::invalid("Request body must be a JSON object.")),
        }
    }

    /// A read a tailnet guest is refused: it shows file paths, hook commands,
    /// or the owner's own data. Every guest write is already refused
    /// `read_only` at the gate.
    fn owner_only(&self) -> Result<()> {
        if self.identity.as_ref().is_some_and(|identity| identity.role == Role::Guest) {
            return Err(GhostError::new("owner_only", "Only the owner may see this.", 403));
        }
        Ok(())
    }
}

impl Shared {
    fn host(&self) -> &SessionHost {
        &self.options.host
    }

    /// The gate every `/api` request passes before it is routed: the refusal,
    /// or who was admitted (a tailnet identity, or None for the bearer token
    /// and for paths outside `/api`, all 404).
    fn authenticate(&self, request: &Request, responder: &mut Responder) -> Result<Option<TailscaleIdentity>> {
        let Some(api_token) = &self.api_token else { return Ok(None) };
        if request.segments().first() != Some(&"api") {
            return Ok(None);
        }
        // A local UI sends no Origin; an app in `remote.apps` is admitted by
        // tailnet identity alone; anything else is a cross-site page.
        let origin = request.header("origin");
        let app = origin.is_some_and(|origin| self.options.remote_apps.iter().any(|allowed| allowed == origin));
        if origin.is_some() && !app {
            return Err(GhostError::new("forbidden_origin", "That origin may not call this daemon.", 403));
        }
        if app && request.header("authorization").is_some() {
            return Err(GhostError::new("app_token_refused", "A web app is admitted by its Tailscale identity, never the bearer token.", 403));
        }
        let presented = bearer_token(request.header("authorization"));
        let token_ok = !presented.is_empty() && token_matches(api_token, presented);
        let identity = if token_ok {
            None
        } else {
            self.options.remote.as_ref().and_then(|remote| remote.identify(request.header("tailscale-user-login"), request.peer.ip()))
        };
        if !token_ok && identity.is_none() {
            responder.set_header("www-authenticate", "Bearer");
            return Err(GhostError::new("unauthorized", "This API needs the machine-local bearer token. Run `ghostd api-token`.", 401));
        }
        if identity.as_ref().is_some_and(|identity| identity.role == Role::Guest) && request.method != "GET" {
            return Err(GhostError::new("read_only", "Tailnet guests can watch this ghost but not act for it.", 403));
        }
        if matches!(request.method.as_str(), "POST" | "PUT") && !is_preflighted_content_type(request.header("content-type")) {
            return Err(GhostError::new("unsupported_media_type", "Mutating requests must be application/json, or an image for an attachment.", 415));
        }
        Ok(identity)
    }

    /// The daemon serves no web page. Only a `remote.apps` origin is answered,
    /// so a page on any other origin cannot read a ghost's conversations
    /// through the owner's own browser. An app is identified by Tailscale,
    /// never by the token, so it is not offered `authorization`. Chrome's
    /// private-network preflight is answered for it: a public origin calling
    /// a tailnet address.
    fn apply_cors(&self, request: &Request, responder: &mut Responder) {
        let Some(origin) = request.header("origin").filter(|origin| self.options.remote_apps.iter().any(|allowed| allowed == origin)) else { return };
        responder.set_header("access-control-allow-origin", origin);
        responder.set_header("vary", "origin");
        responder.set_header("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
        responder.set_header("access-control-allow-headers", "content-type");
        if request.header("access-control-request-private-network") == Some("true") {
            responder.set_header("access-control-allow-private-network", "true");
        }
    }

    /// Run an admitted turn into a new log, which ends in exactly one terminal event.
    fn start_turn_log(self: &Arc<Self>, admission: crate::session_host::TurnAdmission) -> Arc<TurnLog> {
        let log = Arc::new(TurnLog {
            id: crate::random::uuid(),
            conversation: admission.session_id.clone(),
            state: Mutex::new(TurnState {
                frames: TurnBuffer::new(DEFAULT_MEMORY_LIMIT, spill_dir(&self.options.env)),
                ended: false,
                failure: None,
                followers: 0,
                expired: false,
            }),
            changed: Condvar::new(),
        });
        self.turn_logs.lock().unwrap().insert(log.id.clone(), log.clone());
        let (shared, appended) = (self.clone(), log.clone());
        let append = move |event: Value| {
            let stored_badly = {
                let mut state = appended.state.lock().unwrap();
                if state.ended {
                    return;
                }
                let stored = state.frames.push(&encode_sse(&event));
                match &stored {
                    Ok(()) => state.ended = matches!(event["type"].as_str(), Some("done" | "error")),
                    Err(_) => {
                        state.ended = true;
                        state.failure = Some(encode_sse(
                            &json!({ "type": "error", "reason": "error", "errorMessage": "Could not retain the turn stream; read the transcript." }),
                        ));
                    }
                }
                stored.err()
            };
            appended.changed.notify_all();
            if let Some(error) = stored_badly {
                shared.options.logger.error("turn replay storage failed", json!({ "error": error.to_string() }));
                // The turn may already have settled.
                let _ = shared.host().stop_turn(&appended.conversation);
            }
        };
        let emit: Emit = Arc::new(append);
        let (shared, running) = (self.clone(), log.clone());
        std::thread::spawn(move || {
            admission.run(emit.clone());
            // Keep the HTTP seam honest even if the host regresses: every client
            // gets a terminal; after the turn's own, this is a no-op.
            emit(json!({ "type": "error", "reason": "error", "errorMessage": "The turn ended without a terminal event." }));
            if shared.closing.wait(RESUME_GRACE) {
                return;
            }
            shared.turn_logs.lock().unwrap().remove(&running.id);
            let mut state = running.state.lock().unwrap();
            state.expired = true;
            if state.followers == 0 {
                state.frames.dispose();
            }
        });
        log
    }

    /// Stream `log` from event `from` until its terminal, or until about
    /// `stream_cut_bytes` have gone out, when a `resume` frame ends the
    /// response. A client that goes away stops listening, never the turn:
    /// `POST …/stop` is the only stop.
    fn follow_turn(&self, responder: Responder, log: &TurnLog, from: usize) {
        let Ok(mut stream) = responder.event_stream() else { return };
        log.state.lock().unwrap().followers += 1;
        let mut next = from;
        let mut written = 0usize;
        let mut pump = || -> std::io::Result<()> {
            stream.write(SSE_KEEPALIVE_COMMENT)?;
            loop {
                // Frames are copied out under the lock and written outside it,
                // so a slow client never holds the turn.
                let (frames, ended, failure, total) = {
                    let mut state = log.state.lock().unwrap();
                    if state.failure.is_none() && !state.ended && next >= state.frames.len() && !self.closing.is_aborted() {
                        // A turn can idle behind a slow model; a comment keeps the
                        // connection warm and costs a client nothing.
                        let (waited, timeout) = log.changed.wait_timeout(state, SSE_KEEPALIVE_INTERVAL).unwrap();
                        state = waited;
                        if timeout.timed_out() && next >= state.frames.len() && !state.ended {
                            drop(state);
                            stream.write(SSE_KEEPALIVE_COMMENT)?;
                            continue;
                        }
                    }
                    let mut frames = Vec::new();
                    let mut size = 0usize;
                    let mut at = next;
                    // A failed store closed the buffer: its frames are gone, and the failure is all there is to send.
                    while state.failure.is_none() && at < state.frames.len() && size < 256 * 1024 {
                        let frame = state.frames.at(at)?;
                        size += frame.len();
                        frames.push(frame);
                        at += 1;
                    }
                    (frames, state.ended, state.failure.clone(), state.frames.len())
                };
                if let Some(failure) = failure {
                    return stream.write(&failure);
                }
                for frame in frames {
                    stream.write(&frame)?;
                    written += frame.len();
                    next += 1;
                    // Never cut after the terminal: there is nothing left to resume.
                    if written >= self.stream_cut_bytes && !(ended && next == total) {
                        return stream.write(&encode_sse(&json!({ "type": "resume", "turn": log.id, "from": next })));
                    }
                }
                if (ended && next >= total) || self.closing.is_aborted() {
                    return Ok(());
                }
            }
        };
        if let Err(error) = pump()
            && error.kind() == std::io::ErrorKind::InvalidInput
        {
            self.options.logger.error("turn replay read failed", json!({ "error": error.to_string() }));
            let _ = stream.write(&encode_sse(
                &json!({ "type": "error", "reason": "error", "errorMessage": "Could not replay the turn stream; read the transcript." }),
            ));
        }
        let mut state = log.state.lock().unwrap();
        state.followers -= 1;
        if state.expired && state.followers == 0 {
            state.frames.dispose();
        }
    }

    /// Passive conversation-list invalidations. This subscription never opens a
    /// turn; a client that goes away, or stops reading, drops its listener.
    fn conversation_events(&self, responder: Responder) {
        let Ok(mut stream) = responder.event_stream() else { return };
        let (sender, receiver) = mpsc::channel::<Option<String>>();
        let (events, closed) = (Mutex::new(sender.clone()), Mutex::new(sender));
        let subscription = self.host().subscribe(
            move |event| {
                let _ = events.lock().unwrap().send(Some(encode_sse(event)));
            },
            move || {
                let _ = closed.lock().unwrap().send(None);
            },
        );
        let mut written = 0usize;
        let mut frame = SSE_KEEPALIVE_COMMENT.to_string();
        loop {
            if stream.write(&frame).is_err() {
                break;
            }
            written += frame.len();
            if written >= self.stream_cut_bytes || self.closing.is_aborted() {
                break;
            }
            frame = match receiver.recv_timeout(SSE_KEEPALIVE_INTERVAL) {
                Ok(Some(event)) => event,
                Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => SSE_KEEPALIVE_COMMENT.to_string(),
            };
        }
        self.host().unsubscribe(subscription);
    }

    fn handle(self: &Arc<Self>, route: Route, mut context: Context<'_>, responder: &Responder) -> Result<Reply> {
        let options = &self.options;
        let host = self.host();
        // What a request's own work stops with: its caller going away.
        let caller_gone = |responder: &Responder| responder.peer_gone().unwrap_or_default();
        match route {
            Route::Whoami => ok(json!({ "role": context.identity.as_ref().map_or("owner", |identity| identity.role.as_str()) })),
            Route::Machines => {
                context.owner_only()?;
                ok(json!({ "machines": options.remote_serve.machines()? }))
            }
            Route::RemoteGet => ok(options.remote_serve.status().to_json()),
            // The owner's `hooks.json`, read and replaced whole. Whole-document
            // replacement keeps "groups run in file order" honest: there are no
            // per-hook ids to invent for a file that has none.
            Route::HooksConfig => {
                context.owner_only()?;
                let (path, document) = if context.request.method == "GET" {
                    options.hooks.config().ok_or_else(|| GhostError::internal("A configured hook runner has no hooks.json."))?
                } else {
                    let document = context.json_body()?;
                    options.hooks.replace_config(document).map_err(GhostError::invalid)?
                };
                ok(json!({ "path": path.to_string_lossy(), "document": document }))
            }
            Route::Status => {
                context.owner_only()?;
                let running = &options.running_source;
                ok(json!({
                    "version": running.version,
                    "source": { "commit": running.commit, "root": running.root.as_ref().map(|root| root.to_string_lossy()) },
                    "startedAt": crate::clock::iso(running.started_at),
                    "restartNeeded": replaced_since_start(running),
                }))
            }
            Route::GhostName => ok(json!({ "name": options.ghost.name })),
            Route::CharacterGet => {
                let character = read_character(&options.ghost.dir, false)?;
                ok(json!({ "body": character.map(|character| character.body).unwrap_or_default(), "limit": MAX_CHARACTER_BODY_LENGTH }))
            }
            Route::CharacterPut => {
                let body = context.body()?;
                write_character(&options.ghost.dir, string_field(&body, "body")?)?;
                ok(json!({ "ok": true, "limit": MAX_CHARACTER_BODY_LENGTH }))
            }
            Route::Complete => {
                let body = context.body()?;
                let prompt = string_field(&body, "prompt")?;
                let abort = caller_gone(responder);
                ok(json!({ "text": host.complete(prompt, &abort)? }))
            }
            // Fail before any byte of the stream, so the client sees a real status
            // code rather than an SSE error event it has to unwrap.
            Route::Messages => {
                let body = context.body()?;
                let prompt = body.get("prompt").and_then(Value::as_str).map(crate::js_text::trim).filter(|prompt| !prompt.is_empty());
                let prompt = prompt.ok_or_else(|| GhostError::invalid("\"prompt\" must be non-empty text."))?;
                let session = body.get("sessionId").and_then(Value::as_str).filter(|id| !id.is_empty());
                let admission = host.admit_turn(session, prompt)?;
                let log = self.start_turn_log(admission);
                let shared = self.clone();
                Ok(Reply::Stream(Box::new(move |responder| shared.follow_turn(responder, &log, 0))))
            }
            Route::Events => {
                let shared = self.clone();
                Ok(Reply::Stream(Box::new(move |responder| shared.conversation_events(responder))))
            }
            Route::Sessions => ok(json!({ "sessions": host.list_sessions()? })),
            Route::SessionDelete => {
                host.delete_session(&context.id)?;
                ok(json!({ "ok": true }))
            }
            // Idempotent, so a client sends the state it wants rather than a toggle.
            Route::Pin => {
                let pinned = boolean_field(&context.body()?, "pinned")?;
                host.set_pinned(&context.id, pinned)?;
                ok(json!({ "ok": true, "pinned": pinned }))
            }
            // A ghost asking the owner something (`ghost ask`); the owner's next
            // message to the conversation answers it, DELETE withdraws it unanswered.
            // The owner's devices that get an alert when a turn ends (CONTRACTS.md "Push alerts").
            Route::PushPut | Route::PushDelete | Route::PushTest => {
                context.owner_only()?;
                let push = host.push().ok_or_else(|| GhostError::new("push_unavailable", "This ghostd keeps no devices to alert.", 501))?;
                let body = context.body()?;
                match route {
                    Route::PushPut => {
                        let subscription = crate::push::Subscription::parse(&Value::Object(body)).map_err(GhostError::invalid)?;
                        push.subscribe(subscription).map_err(GhostError::internal)?;
                        ok(json!({ "ok": true }))
                    }
                    Route::PushDelete => {
                        let removed = push.unsubscribe(string_field(&body, "endpoint")?).map_err(GhostError::internal)?;
                        ok(json!({ "ok": true, "removed": removed }))
                    }
                    // One alert to one device, now, so the owner sees that alerts reach it.
                    _ => {
                        let sent = push.test(string_field(&body, "endpoint")?, &options.ghost.name).map_err(GhostError::invalid)?;
                        ok(match sent {
                            crate::push::Sent::Delivered => json!({ "ok": true, "delivered": true }),
                            crate::push::Sent::Gone => json!({ "ok": true, "delivered": false, "reason": "The device is no longer subscribed." }),
                            crate::push::Sent::Failed(reason) => json!({ "ok": true, "delivered": false, "reason": reason }),
                        })
                    }
                }
            }
            Route::Read => {
                let body = context.body()?;
                let now = crate::clock::now_ms();
                let read_at = match body.get("readThrough") {
                    None => Some(now),
                    Some(_) => crate::clock::parse_iso(string_field(&body, "readThrough")?).filter(|at| *at <= now),
                };
                let read_at = read_at.ok_or_else(|| GhostError::invalid("readThrough must be a valid timestamp no later than now."))?;
                ok(json!({ "ok": true, "readAt": host.mark_read(&context.id, read_at)? }))
            }
            Route::Title => {
                let body = context.body()?;
                ok(json!({ "ok": true, "title": host.rename_conversation(&context.id, string_field(&body, "title")?)? }))
            }
            // An image body, from any owner.
            Route::AttachmentSave => {
                let bytes = context.request.read_body(MAX_ATTACHMENT_BYTES)?;
                Ok(Reply::Json(201, json!({ "path": host.save_attachment(&context.id, &bytes)? })))
            }
            Route::AttachmentRead => {
                let attachment = host.read_attachment(&context.id, context.param("file"))?;
                Ok(Reply::Bytes {
                    content_type: attachment.content_type,
                    cache: "private, max-age=31536000, immutable",
                    nosniff: true,
                    body: attachment.bytes,
                })
            }
            // The rest of a cut turn response; see CONTRACTS.md, "Turn wire".
            Route::Stream => {
                let log = self.turn_logs.lock().unwrap().get(context.request.query("turn").unwrap_or("")).cloned();
                let Some(log) = log.filter(|log| log.conversation == context.id) else {
                    return Err(GhostError::new("turn_not_found", "That turn is no longer resumable; read the transcript.", 404));
                };
                let reached = log.state.lock().unwrap().frames.len();
                let from = number_param(&context.request, "from")?.filter(|from| from.fract() == 0.0 && *from >= 0.0 && *from <= reached as f64);
                let from = from.ok_or_else(|| GhostError::invalid("\"from\" must be an event index this turn has reached."))? as usize;
                let shared = self.clone();
                Ok(Reply::Stream(Box::new(move |responder| shared.follow_turn(responder, &log, from))))
            }
            Route::Transcript => {
                let read_through = crate::clock::now_iso();
                let mut transcript =
                    host.read_transcript(&context.id, number_param(&context.request, "limit")?, number_param(&context.request, "offset")?)?;
                transcript["readThrough"] = json!(read_through);
                ok(transcript)
            }
            Route::Stop => {
                host.stop_turn(&context.id)?;
                ok(json!({ "stopped": true }))
            }
            Route::QueueGet => ok(host.queued_messages(&context.id)?),
            Route::QueuePost => {
                let body = context.body()?;
                let text = body.get("text").and_then(Value::as_str).map(crate::js_text::trim).filter(|text| !text.is_empty());
                let text = text.ok_or_else(|| GhostError::invalid("\"text\" must be a non-empty string."))?;
                ok(host.queue_message(&context.id, text)?)
            }
        }
    }

    fn route(self: &Arc<Self>, request: Request, identity: Option<TailscaleIdentity>, responder: &Responder) -> Result<Reply> {
        let method = request.method.clone();
        let (route, raw) = match match_route(&request.segments(), &method) {
            Matched::Found(route, params) => (route, params),
            Matched::NotFound => return Err(GhostError::not_found("Not found.")),
            Matched::MethodNotAllowed => return Err(GhostError::new("method_not_allowed", format!("{method} is not allowed here."), 405)),
        };
        let mut params = HashMap::new();
        for (name, segment) in raw {
            let decoded = percent_decode(&segment).ok_or_else(|| GhostError::invalid("URL path segments must use valid percent-encoding."))?;
            params.insert(name, decoded);
        }
        let id = match params.get("id") {
            Some(id) => require_conversation_id(id)?.to_string(),
            None => String::new(),
        };
        self.handle(route, Context { shared: self, request, identity, params, id }, responder)
    }

    /// Nothing a request carries may take the process down: every failure is
    /// an answer, and a handler that panics loses only its own thread.
    fn serve(self: &Arc<Self>, request: Request, mut responder: Responder) {
        self.apply_cors(&request, &mut responder);
        if request.method == "OPTIONS" {
            // A preflight cannot carry credentials — that is what it is asking
            // permission to do. Answering it reveals nothing.
            return responder.empty(204);
        }
        let path = request.path.clone();
        let outcome = self.authenticate(&request, &mut responder).and_then(|identity| self.route(request, identity, &responder));
        match outcome {
            Ok(Reply::Json(status, body)) => responder.json(status, &body),
            Ok(Reply::Bytes { content_type, cache, nosniff, body }) => {
                let mut headers = vec![("content-type", content_type.as_str()), ("cache-control", cache)];
                if nosniff {
                    headers.push(("x-content-type-options", "nosniff"));
                }
                responder.bytes(200, &headers, &body);
            }
            Ok(Reply::Stream(stream)) => stream(responder),
            Err(error) if error.is_internal() => {
                self.options.logger.error("request failed", json!({ "path": path, "error": error.message }));
                responder.error(&GhostError::internal("The daemon failed to handle the request."));
            }
            Err(error) => responder.error(&error),
        }
    }
}

pub struct ListeningServer {
    pub port: u16,
    server: Server,
    shared: Arc<Shared>,
}

impl ListeningServer {
    /// Stop accepting and end every open stream. Turns are the host's to abort.
    pub fn close(&self) {
        self.server.close();
        self.shared.closing.abort();
        let logs: Vec<Arc<TurnLog>> = self.shared.turn_logs.lock().unwrap().drain().map(|(_, log)| log).collect();
        for log in logs {
            log.state.lock().unwrap().ended = true;
            log.changed.notify_all();
        }
    }
}

/// What `ServerOptions.api_token` means. `File` is the machine-local token,
/// minted here rather than on the first authenticated request so a client that
/// starts alongside the daemon finds the file. `Off` is no authentication at
/// all, which is test-only and says so out loud.
fn resolve_api_token(options: &ServerOptions) -> std::result::Result<Option<String>, String> {
    match &options.api_token {
        ApiToken::Off => {
            options.logger.warn("the HTTP API is running without authentication", Value::Null);
            Ok(None)
        }
        ApiToken::Fixed(token) => Ok(Some(token.clone())),
        ApiToken::File => {
            let path = api_token_path(&options.env, &options.home);
            let (token, created) = ensure_api_token(&path)?;
            // The path, never the token: `ghostd api-token` is the only way to see it.
            options.logger.info(if created { "minted the API token" } else { "API token loaded" }, json!({ "path": path.to_string_lossy() }));
            Ok(Some(token))
        }
    }
}

/// Bind `127.0.0.1:<port>` and serve the API.
pub fn start_daemon_server(options: ServerOptions) -> std::result::Result<ListeningServer, String> {
    let api_token = resolve_api_token(&options)?;
    let address = SocketAddr::from(([127, 0, 0, 1], options.port));
    let shared = Arc::new(Shared {
        api_token,
        max_body_bytes: options.max_body_bytes.unwrap_or(DEFAULT_MAX_BODY_BYTES),
        stream_cut_bytes: options.stream_cut_bytes.unwrap_or(DEFAULT_STREAM_CUT_BYTES),
        turn_logs: Mutex::new(HashMap::new()),
        closing: Abort::new(),
        options,
    });
    let serving = shared.clone();
    let server = Server::start(address, move |request, responder| serving.serve(request, responder)).map_err(|error| error.to_string())?;
    Ok(ListeningServer { port: server.address.port(), server, shared })
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
