//! Stand-ins for the window's scripted QA (`packages/window/dev/stand-in.sh`):
//!
//!   stand_in llama-server … --port <n>   a model server that, for every turn, reasons, runs one command and gives one
//!                                        short reply, so Ask can be checked without loading a model (ghostd spawns it
//!                                        as `local.server`)
//!   stand_in port                        a loopback port that is free now
use ghostd::http::Server;
use serde_json::json;
use std::net::SocketAddr;
use std::time::Duration;

const REPLY: &str =
    "The boat leaves at **nine**, from the north pier (Documents/Notes/Ferry trip.md).\n\n- Bring the tickets.\n- Sara is meeting you there.";

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

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("llama-server") => llama_server(&args[1..]),
        Some("port") => {
            println!("{}", std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|listener| listener.local_addr()).expect("a free port").port())
        }
        _ => {
            eprintln!("usage: stand_in llama-server --port <n> | port");
            std::process::exit(2);
        }
    }
}
