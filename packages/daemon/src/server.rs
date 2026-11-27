//! The daemon's HTTP API (CONTRACTS.md "Daemon HTTP API"): the gate every
//! `/api` request passes, the routes, and the two event streams. A turn runs
//! on its own thread and never waits on the response that started it.
use crate::attachments::MAX_ATTACHMENT_BYTES;
use crate::conversation_host::{ConversationHost, Emit, TurnAdmission};
use crate::env::Env;
use crate::error::{GhostError, Result};
use crate::home::{Home, MAX_CHARACTER_BODY_LENGTH};
use crate::hooks::HookRunner;
use crate::http::{Request, Responder, Server, percent_decode};
use crate::log::Logger;
use crate::remote::{RemoteAccess, RemoteServe};
use crate::running_source::{RunningSource, replaced_since_start};
use crate::token::{api_token_path, ensure_api_token, token_matches};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

const MAX_BODY_BYTES: usize = 1_048_576;
/// How much of a turn may wait unsent for its reader. A reader further behind
/// than this is not reading: its response ends there, and the turn carries on.
const MAX_TURN_BACKLOG_BYTES: usize = 8 * 1_048_576;
const SSE_KEEPALIVE_COMMENT: &str = ": keepalive\n\n";
const SSE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// The bearer token every private `/api` route requires.
pub enum ApiToken {
    /// Read from, and minted into, the XDG state token file: a client that
    /// reads that file is authenticated and a web page that cannot is not.
    File,
    /// Use this token.
    #[cfg(test)]
    Fixed(String),
    /// No authentication at all, for tests whose subject is routing or streaming.
    #[cfg(test)]
    Off,
}

pub struct ServerOptions {
    /// The machine's one ghost.
    pub ghost: Home,
    pub host: ConversationHost,
    /// What runs this daemon, as `GET /api/status` reports it.
    pub running_source: RunningSource,
    /// The owner's `hooks.json`, as `HookRunner::from_config` admitted it.
    pub hooks: Arc<HookRunner>,
    pub logger: Logger,
    pub api_token: ApiToken,
    /// Callers reaching the daemon through `tailscale serve`; None admits none.
    pub remote: Option<Arc<RemoteAccess>>,
    /// Web app origins (`remote.apps`) admitted past the Origin check, with a
    /// tailnet identity only, never the bearer token.
    pub remote_apps: Vec<String>,
    /// Reads what Tailscale Serve exposes of this daemon.
    pub remote_serve: Arc<RemoteServe>,
    pub port: u16,
    /// Where the token file is resolved from.
    pub env: Env,
    pub home: std::path::PathBuf,
}

fn encode_sse(event: &Value) -> String {
    format!("data: {event}\n\n")
}

struct Shared {
    options: ServerOptions,
    api_token: Option<String>,
}

enum Reply {
    Json(u16, Value),
    /// A stored attachment, which never changes under its name.
    Image {
        content_type: String,
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
    Ghost,
    CharacterGet,
    CharacterPut,
    Complete,
    Messages,
    Events,
    Conversation,
    ConversationDelete,
    PushPut,
    PushDelete,
    PushTest,
    Read,
    AttachmentSave,
    AttachmentRead,
    Transcript,
    Stop,
    QueueGet,
    QueuePost,
}

/// `"GET PUT"`, `"api/conversation/attachments/:file"`: a `:name` segment is a parameter.
const ROUTES: &[(&str, &str, Route)] = &[
    ("GET", "api/remote/whoami", Route::Whoami),
    ("GET", "api/remote/machines", Route::Machines),
    ("GET", "api/remote", Route::RemoteGet),
    ("GET PUT", "api/hooks/config", Route::HooksConfig),
    ("GET", "api/status", Route::Status),
    ("PUT", "api/push/subscription", Route::PushPut),
    ("DELETE", "api/push/subscription", Route::PushDelete),
    ("POST", "api/push/test", Route::PushTest),
    ("GET", "api/ghost", Route::Ghost),
    ("GET", "api/character", Route::CharacterGet),
    ("PUT", "api/character", Route::CharacterPut),
    ("POST", "api/complete", Route::Complete),
    ("POST", "api/messages", Route::Messages),
    ("GET", "api/events", Route::Events),
    ("GET", "api/conversation", Route::Conversation),
    ("DELETE", "api/conversation", Route::ConversationDelete),
    ("PUT", "api/conversation/read", Route::Read),
    ("POST", "api/conversation/attachments", Route::AttachmentSave),
    ("GET", "api/conversation/attachments/:file", Route::AttachmentRead),
    ("GET", "api/conversation/transcript", Route::Transcript),
    ("POST", "api/conversation/stop", Route::Stop),
    ("GET", "api/conversation/queue", Route::QueueGet),
    ("POST", "api/conversation/queue", Route::QueuePost),
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

/// A query parameter as a count; None when absent.
fn count_param(request: &Request, key: &str) -> Result<Option<usize>> {
    let Some(raw) = request.query(key) else { return Ok(None) };
    raw.trim().parse().map(Some).map_err(|_| GhostError::invalid(format!("\"{key}\" must be a whole number, zero or more.")))
}

fn string_field<'a>(body: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    body.get(key).and_then(Value::as_str).ok_or_else(|| GhostError::invalid(format!("\"{key}\" must be a string.")))
}

struct Context {
    request: Request,
    params: HashMap<&'static str, String>,
}

impl Context {
    fn param(&self, name: &str) -> &str {
        self.params.get(name).map_or("", String::as_str)
    }

    fn json_body(&mut self) -> Result<Value> {
        let bytes = self.request.read_body(MAX_BODY_BYTES)?;
        serde_json::from_slice(&bytes).map_err(|_| GhostError::invalid("Request body must be JSON."))
    }

    /// The request's JSON object body, read within the size bound.
    fn body(&mut self) -> Result<Map<String, Value>> {
        match self.json_body()? {
            Value::Object(body) => Ok(body),
            _ => Err(GhostError::invalid("Request body must be a JSON object.")),
        }
    }
}

impl Shared {
    fn host(&self) -> &ConversationHost {
        &self.options.host
    }

    /// The gate every `/api` request passes before it is routed: the owner,
    /// by the bearer token or their own tailnet login, or a refusal. Paths
    /// outside `/api` pass, to be 404s.
    fn authenticate(&self, request: &Request, responder: &mut Responder) -> Result<()> {
        let Some(api_token) = &self.api_token else { return Ok(()) };
        if request.segments().first() != Some(&"api") {
            return Ok(());
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
        let owner_by_tailnet =
            || self.options.remote.as_ref().is_some_and(|remote| remote.identify(request.header("tailscale-user-login"), request.peer.ip()));
        if !token_ok && !owner_by_tailnet() {
            responder.set_header("www-authenticate", "Bearer");
            return Err(GhostError::new("unauthorized", "This API needs the machine-local bearer token. Run `ghostd api-token`.", 401));
        }
        if matches!(request.method.as_str(), "POST" | "PUT") && !is_preflighted_content_type(request.header("content-type")) {
            return Err(GhostError::new("unsupported_media_type", "Mutating requests must be application/json, or an image for an attachment.", 415));
        }
        Ok(())
    }

    /// The daemon serves no web page. Only a `remote.apps` origin is answered,
    /// so a page on any other origin cannot read a ghost's conversation
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

    /// Run an admitted turn on its own thread and return what streams it to
    /// the response. The turn never waits on its reader: each event is queued
    /// in memory, and a reader whose queue passes `MAX_TURN_BACKLOG_BYTES`, or
    /// whose socket refuses a write (gone, or not reading for the socket's
    /// timeout), is dropped. The turn runs on to its end and its log either
    /// way: `POST …/stop` is the only stop. The response ends when the turn
    /// has given the conversation back, after its terminal event.
    fn start_turn(admission: TurnAdmission) -> impl FnOnce(Responder) + Send {
        let (queue, frames) = mpsc::channel::<String>();
        // Bytes queued and not yet taken for writing, and whether anyone still reads.
        let (backlog, reading) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(true)));
        let (queued, read) = (backlog.clone(), reading.clone());
        let emit: Emit = Arc::new(move |event| {
            if !read.load(Ordering::Relaxed) {
                return;
            }
            let frame = encode_sse(&event);
            if queued.fetch_add(frame.len(), Ordering::Relaxed) + frame.len() > MAX_TURN_BACKLOG_BYTES {
                read.store(false, Ordering::Relaxed);
            } else {
                let _ = queue.send(frame);
            }
        });
        // The queue closes when the turn drops `emit`, as it returns.
        std::thread::spawn(move || admission.run(emit));
        move |responder| {
            let Ok(mut stream) = responder.event_stream() else { return reading.store(false, Ordering::Relaxed) };
            let mut frame = SSE_KEEPALIVE_COMMENT.to_string();
            while reading.load(Ordering::Relaxed) && stream.write(&frame).is_ok() {
                // A turn can idle behind a slow model; a comment keeps the
                // connection warm and costs a client nothing.
                frame = match frames.recv_timeout(SSE_KEEPALIVE_INTERVAL) {
                    Ok(frame) => {
                        backlog.fetch_sub(frame.len(), Ordering::Relaxed);
                        frame
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => SSE_KEEPALIVE_COMMENT.to_string(),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                };
            }
            reading.store(false, Ordering::Relaxed);
        }
    }

    /// Passive invalidations of the conversation. This subscription never opens a
    /// turn; it ends when the client goes away or stops reading, or the host shuts down.
    fn conversation_events(&self, responder: Responder) {
        let Ok(mut stream) = responder.event_stream() else { return };
        let (events, receiver) = mpsc::channel::<Option<String>>();
        let closed = events.clone();
        let subscription = self.host().subscribe(
            move |event| {
                let _ = events.send(Some(encode_sse(event)));
            },
            move || {
                let _ = closed.send(None);
            },
        );
        let mut frame = SSE_KEEPALIVE_COMMENT.to_string();
        while stream.write(&frame).is_ok() {
            frame = match receiver.recv_timeout(SSE_KEEPALIVE_INTERVAL) {
                Ok(Some(event)) => event,
                Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => SSE_KEEPALIVE_COMMENT.to_string(),
            };
        }
        self.host().unsubscribe(subscription);
    }

    fn handle(self: &Arc<Self>, route: Route, mut context: Context, responder: &Responder) -> Result<Reply> {
        let options = &self.options;
        let host = self.host();
        // What a request's own work stops with: its caller going away.
        let caller_gone = |responder: &Responder| responder.peer_gone().unwrap_or_default();
        match route {
            // Anyone admitted is the owner: through the token on this machine, or their own Tailscale login.
            Route::Whoami => ok(json!({ "role": "owner" })),
            Route::Machines => ok(json!({ "machines": options.remote_serve.machines()? })),
            Route::RemoteGet => ok(options.remote_serve.status().to_json()),
            // The owner's `hooks.json`, read and replaced whole. Whole-document
            // replacement keeps "groups run in file order" honest: there are no
            // per-hook ids to invent for a file that has none.
            Route::HooksConfig => {
                let (path, document) = if context.request.method == "GET" {
                    options.hooks.config()
                } else {
                    let document = context.json_body()?;
                    options.hooks.replace_config(document).map_err(GhostError::invalid)?
                };
                ok(json!({ "path": path.to_string_lossy(), "document": document }))
            }
            Route::Status => {
                let running = &options.running_source;
                ok(json!({
                    "version": running.version,
                    "source": { "commit": running.commit, "root": running.root.as_ref().map(|root| root.to_string_lossy()) },
                    "startedAt": crate::clock::iso(running.started_at),
                    "restartNeeded": replaced_since_start(running),
                }))
            }
            Route::Ghost => {
                // The topic documents are the owner's to read, edit and delete: where they are, and how many.
                let topics = options.ghost.topics_dir();
                ok(json!({ "name": options.ghost.name(), "topics": { "path": topics.to_string_lossy(), "count": crate::topics::count(&topics) } }))
            }
            Route::CharacterGet => {
                let character = options.ghost.read_character(false)?;
                ok(json!({ "body": character.unwrap_or_default(), "limit": MAX_CHARACTER_BODY_LENGTH }))
            }
            Route::CharacterPut => {
                let body = context.body()?;
                options.ghost.write_character(string_field(&body, "body")?)?;
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
                let prompt = body.get("prompt").and_then(Value::as_str).map(str::trim).filter(|prompt| !prompt.is_empty());
                let prompt = prompt.ok_or_else(|| GhostError::invalid("\"prompt\" must be non-empty text."))?;
                Ok(Reply::Stream(Box::new(Self::start_turn(host.admit_turn(prompt)?))))
            }
            Route::Events => {
                let shared = self.clone();
                Ok(Reply::Stream(Box::new(move |responder| shared.conversation_events(responder))))
            }
            Route::Conversation => ok(host.conversation()?),
            Route::ConversationDelete => {
                host.delete_conversation()?;
                ok(json!({ "ok": true }))
            }
            // The owner's devices that get an alert when a turn ends (CONTRACTS.md "Push alerts").
            Route::PushPut | Route::PushDelete | Route::PushTest => {
                let push = host.push();
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
                        let sent = push.test(string_field(&body, "endpoint")?, &options.ghost.name()).map_err(GhostError::invalid)?;
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
                ok(json!({ "ok": true, "readAt": host.mark_read(read_at)? }))
            }
            // The body is the image itself.
            Route::AttachmentSave => {
                let bytes = context.request.read_body(MAX_ATTACHMENT_BYTES)?;
                Ok(Reply::Json(201, json!({ "path": host.save_attachment(&bytes)? })))
            }
            Route::AttachmentRead => {
                let attachment = host.read_attachment(context.param("file"))?;
                Ok(Reply::Image { content_type: attachment.content_type, body: attachment.bytes })
            }
            Route::Transcript => {
                let read_through = crate::clock::now_iso();
                let mut transcript = host.read_transcript(count_param(&context.request, "limit")?, count_param(&context.request, "offset")?)?;
                transcript["readThrough"] = json!(read_through);
                ok(transcript)
            }
            Route::Stop => {
                host.stop_turn()?;
                ok(json!({ "stopped": true }))
            }
            Route::QueueGet => ok(host.queued_messages()),
            Route::QueuePost => {
                let body = context.body()?;
                let text = body.get("text").and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty());
                let text = text.ok_or_else(|| GhostError::invalid("\"text\" must be a non-empty string."))?;
                ok(host.queue_message(text)?)
            }
        }
    }

    fn route(self: &Arc<Self>, request: Request, responder: &Responder) -> Result<Reply> {
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
        self.handle(route, Context { request, params }, responder)
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
        let outcome = self.authenticate(&request, &mut responder).and_then(|()| self.route(request, &responder));
        match outcome {
            Ok(Reply::Json(status, body)) => responder.json(status, &body),
            Ok(Reply::Image { content_type, body }) => {
                let headers = [
                    ("content-type", content_type.as_str()),
                    ("cache-control", "private, max-age=31536000, immutable"),
                    ("x-content-type-options", "nosniff"),
                ];
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

/// What `ServerOptions.api_token` means. `File` is the machine-local token,
/// minted here rather than on the first authenticated request so a client that
/// starts alongside the daemon finds the file.
fn resolve_api_token(options: &ServerOptions) -> std::result::Result<Option<String>, String> {
    match &options.api_token {
        #[cfg(test)]
        ApiToken::Off => Ok(None),
        #[cfg(test)]
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

/// Bind `127.0.0.1:<port>` and serve the API. Closing the server stops it
/// accepting; the streams still open end with the host, whose shutdown aborts
/// the running turn and closes the event subscriptions.
pub fn start_daemon_server(options: ServerOptions) -> std::result::Result<Server, String> {
    let api_token = resolve_api_token(&options)?;
    let address = SocketAddr::from(([127, 0, 0, 1], options.port));
    let shared = Arc::new(Shared { api_token, options });
    Server::start(address, move |request, responder| shared.serve(request, responder)).map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
