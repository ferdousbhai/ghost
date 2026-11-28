//! Stand-ins for the bar's scripted QA (`packages/bar/dev/stand-in.sh`):
//!
//!   stand_in llama-server … --port <n>   a model server that, for every turn, reasons, runs one command and gives one
//!                                        short reply, so Ask can be checked without loading a model (ghostd spawns it
//!                                        as `local.server`); told "Which pier?", it asks that with its `ask` tool
//!   stand_in port                        a loopback port that is free now
//!   stand_in serve <port> <to> <login>   what Tailscale Serve is to a daemon on loopback port <to>, but for the TLS:
//!                                        every request to <port> is passed on, stamped as that tailnet login's
use ghostd::http::Server;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

const REPLY: &str =
    "The boat leaves at **nine**, from the north pier (Documents/Notes/Ferry trip.md).\n\n- Bring the tickets.\n- Sara is meeting you there.";

/// What the owner says to have it put a question back, and the question it puts.
const ASK_FOR: &str = "Which pier?";
const QUESTION: &str = "There are two piers. Which do you mean?";
const ANSWERS: [&str; 3] = ["The north pier", "The south pier", "Neither"];

/// The command its one tool call runs: a shell builtin, so it needs nothing of the scratch home.
const COMMAND: &str = "echo 'The boat leaves at nine from the north pier.'";

fn llama_server(args: &[String]) {
    let port: u16 =
        args.iter().position(|arg| arg == "--port").and_then(|at| args.get(at + 1)).and_then(|port| port.parse().ok()).expect("--port <n>");
    Server::start(SocketAddr::from(([127, 0, 0, 1], port)), |mut request, responder| match request.path.as_str() {
        "/health" => responder.bytes(200, &[], b"ok"),
        "/v1/chat/completions" => {
            // Once per turn it behaves as the model does: it reasons, runs a command, then answers.
            let body: serde_json::Value = request.read_body(8 << 20).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
            let answering = body["messages"].as_array().is_some_and(|messages| messages.last().is_some_and(|last| last["role"] == "tool"));
            let Ok(mut events) = responder.event_stream() else { return };
            // A question for the owner ends the turn: the server is not called again for it.
            let asking = body["messages"].as_array().and_then(|messages| messages.last()).is_some_and(|last| last["role"] == "user" && last["content"].to_string().contains(ASK_FOR));
            if asking {
                let call = json!([{ "index": 0, "id": "call-ask", "function": { "name": "ask", "arguments": json!({ "question": QUESTION, "options": ANSWERS }).to_string() } }]);
                let _ = events.write(&format!("data: {}\n\n", json!({ "choices": [{ "delta": { "tool_calls": call } }] })));
                let _ = events.write("data: [DONE]\n\n");
                return;
            }
            if !answering {
                let call =
                    json!([{ "index": 0, "id": "call-1", "function": { "name": "bash", "arguments": json!({ "command": COMMAND }).to_string() } }]);
                for delta in [
                    json!({ "reasoning_content": "The ferry note should say. " }),
                    json!({ "reasoning_content": "I will read it." }),
                    json!({ "tool_calls": call }),
                ] {
                    if events.write(&format!("data: {}\n\n", json!({ "choices": [{ "delta": delta }] }))).is_err() {
                        return;
                    }
                }
                let _ = events.write("data: [DONE]\n\n");
                return;
            }
            for word in REPLY.split_inclusive(' ') {
                if events.write(&format!("data: {}\n\n", json!({ "choices": [{ "delta": { "content": word } }] }))).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = events.write("data: [DONE]\n\n");
        }
        _ => responder.bytes(404, &[], b"not found"),
    })
    .expect("the port ghostd chose");
    loop {
        std::thread::park();
    }
}

/// One request, passed on with `Tailscale-User-Login` after its request line, and its answer passed back as it
/// comes; either side closing closes the other, so a reader that leaves a stream is gone for the daemon too.
fn pass_on(mut client: TcpStream, to: u16, login: &str) -> std::io::Result<()> {
    let mut daemon = TcpStream::connect(("127.0.0.1", to))?;
    let (mut line, mut byte) = (Vec::new(), [0u8; 1]);
    while byte[0] != b'\n' {
        client.read_exact(&mut byte)?;
        line.push(byte[0]);
    }
    daemon.write_all(&line)?;
    daemon.write_all(format!("tailscale-user-login: {login}\r\n").as_bytes())?;
    let (mut asking, mut asked) = (client.try_clone()?, daemon.try_clone()?);
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut asking, &mut asked);
        let _ = asked.shutdown(Shutdown::Both);
    });
    let _ = std::io::copy(&mut daemon, &mut client);
    client.shutdown(Shutdown::Both)
}

fn serve(args: &[String]) {
    let [port, to, login] = args else { panic!("serve <port> <to> <login>") };
    let (port, to): (u16, u16) = (port.parse().expect("a port"), to.parse().expect("a port"));
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("the port is free");
    for client in listener.incoming().flatten() {
        let login = login.clone();
        std::thread::spawn(move || pass_on(client, to, &login));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("llama-server") => llama_server(&args[1..]),
        Some("serve") => serve(&args[1..]),
        Some("port") => {
            println!("{}", std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|listener| listener.local_addr()).expect("a free port").port())
        }
        _ => {
            eprintln!("usage: stand_in llama-server --port <n> | port | serve <port> <to> <login>");
            std::process::exit(2);
        }
    }
}
