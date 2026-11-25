//! Stand-ins for the window's scripted QA (`packages/window/dev/stand-in.sh`):
//!
//!   stand_in llama-server … --port <n>   a model server that answers every chat with one short reply naming its file,
//!                                        so Ask can be checked without loading a model (ghostd spawns it as `local.server`)
//!   stand_in pictures <dir> <count>      `<dir>/p1.png` … `p<count>.png`, each a different two-colour gradient,
//!                                        alternately wide and tall so the grid's cropping shows
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

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    let mut frame = (data.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&body);
    frame.extend_from_slice(&crc32(&body).to_be_bytes());
    frame
}

/// A zlib stream of stored blocks: valid, and no compressor needed for a sample.
fn stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut blocks = data.chunks(65_535).peekable();
    while let Some(block) = blocks.next() {
        out.push(u8::from(blocks.peek().is_none()));
        out.extend_from_slice(&(block.len() as u16).to_le_bytes());
        out.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        out.extend_from_slice(block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    out.extend_from_slice(&((b << 16) | a).to_be_bytes());
    out
}

fn pictures(dir: &str, count: usize) {
    for n in 1..=count {
        let (width, height) = if n % 2 == 1 { (320usize, 200usize) } else { (200, 320) };
        let mut rows = vec![0u8; (width * 3 + 1) * height];
        for y in 0..height {
            for x in 0..width {
                let at = y * (width * 3 + 1) + 1 + x * 3;
                rows[at] = ((n * 53 + x * 160 / width) % 256) as u8;
                rows[at + 1] = ((n * 97 + y * 160 / height) % 256) as u8;
                rows[at + 2] = ((n * 31 + 90) % 256) as u8;
            }
        }
        let mut header = (width as u32).to_be_bytes().to_vec();
        header.extend_from_slice(&(height as u32).to_be_bytes());
        header.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend(chunk(b"IHDR", &header));
        png.extend(chunk(b"IDAT", &stored(&rows)));
        png.extend(chunk(b"IEND", &[]));
        std::fs::write(format!("{dir}/p{n}.png"), png).expect("the pictures directory");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("llama-server") => llama_server(&args[1..]),
        Some("pictures") => pictures(&args[1], args[2].parse().expect("a count")),
        Some("port") => {
            println!("{}", std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|listener| listener.local_addr()).expect("a free port").port())
        }
        _ => {
            eprintln!("usage: stand_in llama-server --port <n> | pictures <dir> <count> | port");
            std::process::exit(2);
        }
    }
}
