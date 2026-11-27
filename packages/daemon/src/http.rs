//! HTTP/1.1 over loopback, both ways, and nothing more than Ghost uses: the
//! daemon's server (one request per connection, answered and closed, so an
//! event stream simply ends when the connection does) and the client the CLI
//! uses for the daemon and the daemon for llama-server. Tailscale Serve is
//! the only thing that ever fronts this, and it speaks to it the same way.
use crate::abort::{Abort, AbortGuard};
use crate::error::GhostError;
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

const MAX_HEAD_BYTES: usize = 64 * 1024;
/// A peer that stops mid-request, or stops reading a response, is dropped after this.
const IO_TIMEOUT: Duration = Duration::from_secs(30);

fn bad(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Bytes up to and including the blank line that ends a head.
fn read_head(reader: &mut BufReader<TcpStream>) -> io::Result<Vec<u8>> {
    let mut head = Vec::new();
    loop {
        let before = head.len();
        if reader.read_until(b'\n', &mut head)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed before a full head"));
        }
        if head.len() > MAX_HEAD_BYTES {
            return Err(bad("head too large"));
        }
        let line = &head[before..];
        if line == b"\r\n" || line == b"\n" {
            return Ok(head);
        }
    }
}

enum Framing {
    Length(u64),
    Chunked { left: u64, done: bool },
    UntilClose,
}

/// A message body as its framing delimits it.
pub(crate) struct Body {
    reader: BufReader<TcpStream>,
    framing: Framing,
}

impl Body {
    fn chunk_size(&mut self) -> io::Result<u64> {
        let mut line = String::new();
        self.reader.read_line(&mut line)?;
        let size = line.trim().split(';').next().unwrap_or("");
        u64::from_str_radix(size, 16).map_err(|_| bad("bad chunk size"))
    }
}

impl Read for Body {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        match &mut self.framing {
            Framing::UntilClose => self.reader.read(buffer),
            Framing::Length(left) => {
                if *left == 0 {
                    return Ok(0);
                }
                let want = buffer.len().min(usize::try_from(*left).unwrap_or(usize::MAX));
                let read = self.reader.read(&mut buffer[..want])?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "body ended early"));
                }
                *left -= read as u64;
                Ok(read)
            }
            Framing::Chunked { done: true, .. } => Ok(0),
            Framing::Chunked { left, .. } if *left == 0 => {
                let size = self.chunk_size()?;
                if size == 0 {
                    // Trailers, then the blank line.
                    let mut line = String::new();
                    while self.reader.read_line(&mut line)? > 2 {
                        line.clear();
                    }
                    self.framing = Framing::Chunked { left: 0, done: true };
                    return Ok(0);
                }
                self.framing = Framing::Chunked { left: size, done: false };
                self.read(buffer)
            }
            Framing::Chunked { left, .. } => {
                let want = buffer.len().min(usize::try_from(*left).unwrap_or(usize::MAX));
                let read = self.reader.read(&mut buffer[..want])?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "chunk ended early"));
                }
                *left -= read as u64;
                if *left == 0 {
                    let mut crlf = [0u8; 2];
                    self.reader.read_exact(&mut crlf)?;
                }
                Ok(read)
            }
        }
    }
}

fn framing(headers: &[(String, String)], default: Framing) -> io::Result<Framing> {
    let get = |name: &str| headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
    if get("transfer-encoding").is_some_and(|value| value.to_ascii_lowercase().contains("chunked")) {
        return Ok(Framing::Chunked { left: 0, done: false });
    }
    match get("content-length") {
        Some(length) => length.trim().parse().map(Framing::Length).map_err(|_| bad("bad content-length")),
        None => Ok(default),
    }
}

fn lowercase_headers(parsed: &[httparse::Header<'_>]) -> Vec<(String, String)> {
    parsed.iter().map(|header| (header.name.to_ascii_lowercase(), String::from_utf8_lossy(header.value).trim().to_string())).collect()
}

/// `%XX` decoded as UTF-8; None when the encoding or the text is invalid.
pub(crate) fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let pair = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ── Server ──────────────────────────────────────────────────────────────

pub struct Request {
    pub(crate) method: String,
    /// The path as sent, without its query.
    pub path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    pub(crate) peer: SocketAddr,
    body: Option<Body>,
}

impl Request {
    /// A header's value, by lowercase name.
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// A query parameter's decoded value; the first when repeated.
    pub(crate) fn query(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// The path's non-empty segments, still percent-encoded.
    pub(crate) fn segments(&self) -> Vec<&str> {
        self.path.split('/').filter(|segment| !segment.is_empty()).collect()
    }

    /// The whole body, refused past `max` bytes before it is held, and when empty.
    pub fn read_body(&mut self, max: usize) -> Result<Vec<u8>, GhostError> {
        let too_large = || GhostError::new("payload_too_large", "Request body is too large.", 413);
        let Some(mut body) = self.body.take() else { return Err(GhostError::invalid("Request body is required.")) };
        if matches!(body.framing, Framing::Length(length) if length > max as u64) {
            return Err(too_large());
        }
        let mut bytes = Vec::new();
        (&mut body)
            .take(max as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| GhostError::invalid(format!("Could not read the request body: {error}")))?;
        if bytes.len() > max {
            return Err(too_large());
        }
        if bytes.is_empty() {
            return Err(GhostError::invalid("Request body is required."));
        }
        Ok(bytes)
    }
}

/// Answers one request, once.
pub struct Responder {
    stream: TcpStream,
    headers: Vec<(String, String)>,
}

/// The reason phrase of each status the daemon answers with.
fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

impl Responder {
    /// A header every answer to this request carries (CORS, `WWW-Authenticate`).
    pub(crate) fn set_header(&mut self, name: &str, value: &str) {
        self.headers.push((name.to_string(), value.to_string()));
    }

    fn head(&self, status: u16, headers: &[(&str, &str)]) -> String {
        let mut head = format!("HTTP/1.1 {status} {}\r\nconnection: close\r\n", reason(status));
        for (name, value) in self.headers.iter().map(|(n, v)| (n.as_str(), v.as_str())).chain(headers.iter().copied()) {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        head
    }

    /// A whole response. A peer that has gone away is not an error worth a caller's time.
    pub fn bytes(mut self, status: u16, headers: &[(&str, &str)], body: &[u8]) {
        let length = body.len().to_string();
        let mut all = headers.to_vec();
        all.push(("content-length", &length));
        let mut message = self.head(status, &all).into_bytes();
        message.extend_from_slice(body);
        let _ = self.stream.write_all(&message);
        let _ = self.stream.shutdown(Shutdown::Write);
    }

    pub(crate) fn json(self, status: u16, body: &Value) {
        self.bytes(status, &[("content-type", "application/json; charset=utf-8"), ("cache-control", "no-store")], body.to_string().as_bytes());
    }

    /// The `{ error: { message, code } }` envelope every client parses.
    pub(crate) fn error(self, error: &GhostError) {
        let body = serde_json::json!({ "error": { "message": error.message, "code": error.code } });
        self.json(error.status, &body);
    }

    pub(crate) fn empty(self, status: u16) {
        self.bytes(status, &[], b"");
    }

    /// Start an event stream; it ends when the returned writer is dropped.
    pub fn event_stream(mut self) -> io::Result<EventStream> {
        let head = self.head(
            200,
            &[
                ("content-type", "text/event-stream; charset=utf-8"),
                ("cache-control", "no-store"),
                // Local only, but a proxy in front of the daemon must not buffer the turn.
                ("x-accel-buffering", "no"),
            ],
        );
        self.stream.write_all(head.as_bytes())?;
        Ok(EventStream { stream: self.stream })
    }

    /// A signal that fires when the peer closes its end before the answer: a
    /// request whose work is only for that caller stops with it.
    pub(crate) fn peer_gone(&self) -> io::Result<Abort> {
        let abort = Abort::new();
        let signal = abort.clone();
        let mut stream = self.stream.try_clone()?;
        stream.set_read_timeout(None)?;
        std::thread::spawn(move || {
            let mut byte = [0u8; 1];
            // One request per connection: after it, a read ends only when the
            // peer closes (0) or this side shuts the socket down (error or 0).
            if matches!(stream.read(&mut byte), Ok(0) | Err(_)) {
                signal.abort();
            }
        });
        Ok(abort)
    }
}

pub struct EventStream {
    stream: TcpStream,
}

impl EventStream {
    /// Write one frame; an error means the client is gone or stopped reading.
    pub fn write(&mut self, frame: &str) -> io::Result<()> {
        self.stream.write_all(frame.as_bytes())
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

fn parse_query(raw: &str) -> Vec<(String, String)> {
    raw.split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let decode = |text: &str| percent_decode(&text.replace('+', " "));
            Some((decode(key)?, decode(value)?))
        })
        .collect()
}

fn accept(stream: TcpStream, peer: SocketAddr) -> io::Result<(Request, Responder)> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    stream.set_nodelay(true)?;
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let head = read_head(&mut reader)?;
    let mut slots = [httparse::EMPTY_HEADER; 96];
    let mut parsed = httparse::Request::new(&mut slots);
    if !parsed.parse(&head).map_err(|_| bad("malformed request"))?.is_complete() {
        return Err(bad("incomplete request"));
    }
    let method = parsed.method.unwrap_or("GET").to_string();
    let target = parsed.path.unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let headers = lowercase_headers(parsed.headers);
    let framing = framing(&headers, Framing::Length(0))?;
    if headers.iter().any(|(key, value)| key == "expect" && value.eq_ignore_ascii_case("100-continue")) {
        writer.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
    }
    let request = Request { method, path: path.to_string(), query: parse_query(query), headers, peer, body: Some(Body { reader, framing }) };
    Ok((request, Responder { stream: writer, headers: Vec::new() }))
}

/// A listening server; dropping the handle does not stop it, `close` does.
pub struct Server {
    pub(crate) address: SocketAddr,
    stop: Abort,
}

impl Server {
    /// Bind and serve: every request runs `handle` on its own thread.
    pub fn start(address: SocketAddr, handle: impl Fn(Request, Responder) + Send + Sync + 'static) -> io::Result<Server> {
        let listener = TcpListener::bind(address)?;
        let address = listener.local_addr()?;
        let stop = Abort::new();
        let stopped = stop.clone();
        let handle = Arc::new(handle);
        std::thread::spawn(move || {
            for connection in listener.incoming() {
                if stopped.is_aborted() {
                    break;
                }
                let Ok(stream) = connection else { continue };
                let Ok(peer) = stream.peer_addr() else { continue };
                let handle = handle.clone();
                std::thread::spawn(move || {
                    // A malformed request is answered with silence: nothing a
                    // request carries may take the daemon down.
                    if let Ok((request, responder)) = accept(stream, peer) {
                        handle(request, responder);
                    }
                });
            }
        });
        Ok(Server { address, stop })
    }

    /// Stop accepting. Requests already running finish on their own.
    pub(crate) fn close(&self) {
        self.stop.abort();
        // Wake the accept loop so it sees the flag.
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_secs(1));
    }
}

// ── Client ──────────────────────────────────────────────────────────────

pub struct ClientResponse {
    pub status: u16,
    #[cfg(test)]
    headers: Vec<(String, String)>,
    pub(crate) body: Body,
    _abort: Option<AbortGuard>,
}

impl ClientResponse {
    #[cfg(test)]
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// The rest of the body as text, lossily, up to `max` bytes.
    pub fn text(&mut self, max: u64) -> io::Result<String> {
        let mut bytes = Vec::new();
        (&mut self.body).take(max).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Change how long a read of the body may wait; None waits for ever.
    pub(crate) fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.body.reader.get_ref().set_read_timeout(timeout)
    }
}

pub struct ClientRequest<'a> {
    pub address: SocketAddr,
    pub method: &'a str,
    /// Path and query, already encoded.
    pub target: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub body: Option<&'a [u8]>,
    /// How long connecting, and each read up to the response head, may take; None waits for ever.
    pub timeout: Option<Duration>,
    /// Aborting closes the connection, which ends a read in progress.
    pub abort: Option<&'a Abort>,
}

/// Send one request and read the response head; the body is read by the caller.
pub fn send(request: ClientRequest<'_>) -> io::Result<ClientResponse> {
    let stream = match request.timeout {
        Some(timeout) => TcpStream::connect_timeout(&request.address, timeout)?,
        None => TcpStream::connect(request.address)?,
    };
    stream.set_nodelay(true)?;
    stream.set_read_timeout(request.timeout)?;
    let guard = match request.abort {
        Some(abort) => {
            let handle = stream.try_clone()?;
            Some(abort.on_abort(move || {
                let _ = handle.shutdown(Shutdown::Both);
            }))
        }
        None => None,
    };
    let mut head = format!("{} {} HTTP/1.1\r\nhost: {}\r\nconnection: close\r\n", request.method, request.target, request.address);
    for (name, value) in request.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = request.body {
        head.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let mut message = head.into_bytes();
    message.extend_from_slice(request.body.unwrap_or(b""));
    (&stream).write_all(&message)?;
    let mut reader = BufReader::new(stream);
    let head = read_head(&mut reader)?;
    let mut slots = [httparse::EMPTY_HEADER; 96];
    let mut parsed = httparse::Response::new(&mut slots);
    if !parsed.parse(&head).map_err(|_| bad("malformed response"))?.is_complete() {
        return Err(bad("incomplete response"));
    }
    let status = parsed.code.unwrap_or(0);
    let headers = lowercase_headers(parsed.headers);
    let framing = framing(&headers, Framing::UntilClose)?;
    Ok(ClientResponse {
        status,
        #[cfg(test)]
        headers,
        body: Body { reader, framing },
        _abort: guard,
    })
}

/// Server-sent events off a body: each frame's joined `data:` lines.
pub(crate) struct EventReader<R: Read> {
    reader: BufReader<R>,
}

impl<R: Read> EventReader<R> {
    pub(crate) fn new(body: R) -> Self {
        Self { reader: BufReader::new(body) }
    }

    /// The next event's data, or None at the end of the stream. Comments and
    /// frames without data are skipped.
    pub(crate) fn next_event(&mut self) -> io::Result<Option<String>> {
        let mut data: Option<String> = None;
        loop {
            let mut raw = Vec::new();
            if self.reader.read_until(b'\n', &mut raw)? == 0 {
                return Ok(data);
            }
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if data.is_some() {
                    return Ok(data);
                }
                continue;
            }
            if let Some(value) = line.strip_prefix("data:") {
                let value = value.strip_prefix(' ').unwrap_or(value);
                match &mut data {
                    Some(existing) => {
                        existing.push('\n');
                        existing.push_str(value);
                    }
                    None => data = Some(value.to_string()),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn local() -> SocketAddr {
        "127.0.0.1:0".parse().unwrap()
    }

    fn get(address: SocketAddr, target: &str) -> ClientResponse {
        send(ClientRequest { address, method: "GET", target, headers: &[], body: None, timeout: Some(Duration::from_secs(5)), abort: None }).unwrap()
    }

    #[test]
    fn round_trips_json_with_a_query_and_a_body() {
        let server = Server::start(local(), |mut request, mut responder| {
            responder.set_header("x-extra", "1");
            let body = if request.method == "POST" { String::from_utf8(request.read_body(1024).unwrap()).unwrap() } else { String::new() };
            let reply = json!({ "path": request.path, "q": request.query("q"), "segments": request.segments(), "body": body, "type": request.header("content-type") });
            responder.json(200, &reply);
        })
        .unwrap();
        let mut response = get(server.address, "/api/x%20y/z?q=a+b%26c&other");
        assert_eq!((response.status, response.header("x-extra")), (200, Some("1")));
        let reply: Value = serde_json::from_str(&response.text(4096).unwrap()).unwrap();
        assert_eq!(reply, json!({ "path": "/api/x%20y/z", "q": "a b&c", "segments": ["api", "x%20y", "z"], "body": "", "type": null }));
        let mut posted = send(ClientRequest {
            address: server.address,
            method: "POST",
            target: "/",
            headers: &[("content-type", "application/json")],
            body: Some(b"{\"a\":1}"),
            timeout: Some(Duration::from_secs(5)),
            abort: None,
        })
        .unwrap();
        let reply: Value = serde_json::from_str(&posted.text(4096).unwrap()).unwrap();
        assert_eq!((reply["body"].as_str(), reply["type"].as_str()), (Some("{\"a\":1}"), Some("application/json")));
        server.close();
    }

    #[test]
    fn bodies_are_bounded_and_required() {
        let server = Server::start(local(), |mut request, responder| match request.read_body(4) {
            Ok(_) => responder.empty(204),
            Err(error) => responder.error(&error),
        })
        .unwrap();
        let post = |body: &[u8]| {
            send(ClientRequest {
                address: server.address,
                method: "POST",
                target: "/",
                headers: &[],
                body: Some(body),
                timeout: Some(Duration::from_secs(5)),
                abort: None,
            })
            .unwrap()
        };
        assert_eq!(post(b"1234").status, 204);
        let mut large = post(b"12345");
        assert_eq!(large.status, 413);
        assert!(large.text(4096).unwrap().contains("payload_too_large"));
        assert_eq!(post(b"").status, 400);
        server.close();
    }

    #[test]
    fn chunked_request_bodies_are_decoded() {
        let server = Server::start(local(), |mut request, responder| {
            let body = request.read_body(1024).unwrap();
            responder.bytes(200, &[], &body);
        })
        .unwrap();
        let mut stream = TcpStream::connect(server.address).unwrap();
        stream.write_all(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        assert!(reply.ends_with("\r\n\r\nhello world"), "{reply}");
        server.close();
    }

    #[test]
    fn an_event_stream_ends_with_its_writer_and_reads_back_as_events() {
        let server = Server::start(local(), |_, responder| {
            let mut events = responder.event_stream().unwrap();
            events.write(": keepalive\n\n").unwrap();
            events.write("data: {\"n\":1}\n\n").unwrap();
            events.write("data: a\ndata: b\n\n").unwrap();
        })
        .unwrap();
        let response = get(server.address, "/");
        assert_eq!(response.header("content-type"), Some("text/event-stream; charset=utf-8"));
        let mut events = EventReader::new(response.body);
        assert_eq!(events.next_event().unwrap().as_deref(), Some("{\"n\":1}"));
        assert_eq!(events.next_event().unwrap().as_deref(), Some("a\nb"));
        assert_eq!(events.next_event().unwrap(), None);
        server.close();
    }

    #[test]
    fn abort_ends_a_read_in_progress_and_the_server_sees_the_peer_go() {
        let (arrived, waiting) = std::sync::mpsc::channel();
        let (seen, gone) = std::sync::mpsc::channel();
        let server = Server::start(local(), move |_, responder| {
            let peer = responder.peer_gone().unwrap();
            arrived.send(()).unwrap();
            seen.send(peer.wait(Duration::from_secs(30))).unwrap();
            drop(responder);
        })
        .unwrap();
        let abort = Abort::new();
        std::thread::scope(|scope| {
            let request =
                ClientRequest { address: server.address, method: "GET", target: "/", headers: &[], body: None, timeout: None, abort: Some(&abort) };
            let reading = scope.spawn(|| send(request).map(|response| response.status));
            // The request is with the server, which answers nothing: the client is reading.
            waiting.recv_timeout(Duration::from_secs(30)).unwrap();
            abort.abort();
            assert!(reading.join().unwrap().is_err());
        });
        assert!(gone.recv_timeout(Duration::from_secs(30)).unwrap());
        server.close();
    }

    #[test]
    fn percent_decoding_refuses_a_bad_escape_and_bad_utf8() {
        assert_eq!(percent_decode("a%20b%2F%C3%BC").as_deref(), Some("a b/ü"));
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%ff"), None);
    }
}
