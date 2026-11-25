//! Stand-ins for the window's scripted QA (`packages/window/dev/stand-in.sh`):
//!
//!   stand_in llama-server … --port <n>   a model server that answers every chat with one short reply naming its file,
//!                                        so Ask can be checked without loading a model (ghostd spawns it as `local.server`)
//!   stand_in port                        a loopback port that is free now
use ghostd::http::Server;
use serde_json::json;
use std::net::SocketAddr;
use std::time::Duration;

const REPLY: &str =
    "The boat leaves at **nine**, from the north pier (Documents/Notes/Ferry trip.md).\n\n- Bring the tickets.\n- Sara is meeting you there.";

fn llama_server(args: &[String]) {
    let port: u16 =
        args.iter().position(|arg| arg == "--port").and_then(|at| args.get(at + 1)).and_then(|port| port.parse().ok()).expect("--port <n>");
    Server::start(SocketAddr::from(([127, 0, 0, 1], port)), |request, responder| match request.path.as_str() {
        "/health" => responder.bytes(200, &[], b"ok"),
        "/v1/chat/completions" => {
            let Ok(mut events) = responder.event_stream() else { return };
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
