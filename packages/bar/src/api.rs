//! ghostd's HTTP API, through the client the `ghost` command uses (`ghostd::client`). The daemon is found afresh for
//! each request, so a bar that outlives a restart of ghostd or a new token goes on working, and a port, config or
//! token file that cannot be used is the error the bar shows, never another daemon's port. It is this machine's, or
//! where the owner has said their ghost is, the one on another machine. Requests block, each on a thread of its own,
//! off the GTK main loop.

use std::sync::mpsc;

use ghostd::{
    abort::Abort,
    client::{CONTROL_TIMEOUT, Client, ClientError},
    env,
};
use gtk::gio;
use serde_json::Value;

fn client() -> Result<Client, ClientError> {
    let env = env::current();
    Client::discover(&env, &env::home(&env))
}

/// The name of the machine the ghost is on when it is not this one; none too while the config cannot be read, which
/// the first request says.
pub fn machine() -> Option<String> {
    client().ok()?.machine().map(str::to_string)
}

/// One JSON request, which the daemon answers at once.
pub async fn call(method: &'static str, path: String, body: Option<Value>) -> Result<Value, String> {
    let request = move || client()?.request(method, &path, body.as_ref(), Some(CONTROL_TIMEOUT));
    match gio::spawn_blocking(request).await {
        Ok(answer) => answer.map_err(|error| error.to_string()),
        Err(_) => Err("The request was lost.".to_string()),
    }
}

/// Post `body` and hand over the turn's events (CONTRACTS.md "Turn wire") one by one, or why they stopped coming.
/// The channel closes when the daemon ends the stream, or when `abort` is aborted, which ends the reading alone:
/// the turn is stopped through the API.
pub fn stream(path: &'static str, body: Value, abort: Abort) -> mpsc::Receiver<Result<Value, String>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let read = client().and_then(|mut client| {
            client.stream(path, Some(&body), Some(&abort), &mut |event| {
                let _ = tx.send(Ok(event.clone()));
            })
        });
        if let Err(error) = read {
            let _ = tx.send(Err(error.to_string()));
        }
    });
    rx
}
