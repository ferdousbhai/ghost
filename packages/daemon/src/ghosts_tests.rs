//! `ghosts.rs` against a `tailscale` that is a closure and ghosts that are tiny loopback servers. A machine's
//! "MagicDNS name" here is an `http://` origin on loopback, which is read as any address is: nothing is asked
//! outside this process, and no config, token file or port of the owner's is touched.
use super::*;
use crate::http::Server;
use crate::process::CommandResult;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// One other machine on the fake tailnet.
pub(crate) struct Machine<'a> {
    /// Its MagicDNS name.
    pub name: &'a str,
    pub os: &'a str,
    pub online: bool,
    /// Signed in as the owner; else as someone the tailnet is shared with.
    pub owners: bool,
    pub tagged: bool,
}

/// An owner's machine that is on: the one kind that is asked for a ghost.
pub(crate) fn machine(name: &str) -> Machine<'_> {
    Machine { name, os: "linux", online: true, owners: true, tagged: false }
}

/// What `tailscale status --json` prints for a signed-in node called `own` with these peers.
pub(crate) fn status(own: &str, peers: &[Machine]) -> Value {
    let peers: serde_json::Map<String, Value> = peers
        .iter()
        .enumerate()
        .map(|(index, peer)| {
            let tags = if peer.tagged { json!(["tag:server"]) } else { json!([]) };
            let user = if peer.owners { 42 } else { 7 };
            (
                format!("key{index}"),
                json!({ "DNSName": format!("{}.", peer.name), "UserID": user, "Online": peer.online, "OS": peer.os, "Tags": tags }),
            )
        })
        .collect();
    json!({
        "BackendState": "Running",
        "Self": { "DNSName": format!("{own}."), "UserID": 42 },
        "Peer": peers,
        "User": { "42": { "LoginName": "owner@example.com" }, "7": { "LoginName": "partner@example.com" } },
    })
}

/// A `tailscale` that prints `status`, counting how often it is asked.
fn tailscale(status: Value) -> (TailscaleRunner, Arc<AtomicUsize>) {
    let asked = Arc::new(AtomicUsize::new(0));
    let count = asked.clone();
    let run: TailscaleRunner = Arc::new(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(CommandResult { stdout: status.to_string(), stderr: String::new(), code: 0 })
    });
    (run, asked)
}

fn failing(failure: CommandFailure) -> TailscaleRunner {
    Arc::new(move |_| Err(failure.clone()))
}

/// What answers at one address: `GET /api/ghost` gets this status and body, and every request is kept.
struct There {
    server: Server,
    asked: Arc<Mutex<Vec<String>>>,
}

impl There {
    fn new(status: u16, body: Value) -> Self {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        let server = Server::start("127.0.0.1:0".parse().unwrap(), move |request, responder| {
            seen.lock().unwrap().push(format!("{} {} {:?}", request.method, request.path, request.header("authorization")));
            responder.json(status, &body);
        })
        .unwrap();
        Self { server, asked }
    }

    /// A ghost that answers its owner and has a model.
    fn ghost() -> Self {
        Self::new(200, json!({ "name": "casper", "model": true, "topics": { "path": "/t", "count": 0 } }))
    }

    /// Its address, by number or as `localhost`.
    fn at(&self, host: &str) -> String {
        format!("http://{host}:{}", self.server.address.port())
    }

    fn address(&self) -> GhostAddress {
        GhostAddress::parse(&self.at("127.0.0.1")).unwrap()
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

/// A scratch home: its own config path and token file, and a daemon port nothing listens on unless a test says so.
struct Scratch {
    dir: PathBuf,
    env: Env,
    _nobody: crate::client::tests::Refusing,
}

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ghost-ghosts-{}", crate::random::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let nobody = crate::client::tests::refusing();
        let path = |name: &str| dir.join(name).display().to_string();
        let env = Env::from([
            ("GHOSTD_CONFIG".to_string(), path("config/config.json")),
            ("GHOSTD_API_TOKEN_FILE".to_string(), path("api-token")),
            ("GHOSTD_PORT".to_string(), nobody.port.to_string()),
        ]);
        Self { dir, env, _nobody: nobody }
    }

    fn config(&self) -> Option<String> {
        std::fs::read_to_string(self.dir.join("config/config.json")).ok()
    }

    fn write_config(&self, config: Value) {
        std::fs::create_dir_all(self.dir.join("config")).unwrap();
        std::fs::write(self.dir.join("config/config.json"), config.to_string()).unwrap();
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_short_name_is_the_machines_full_name_as_tailscale_has_it() {
    let peers =
        [machine("alarm.tail58bdd3.ts.net"), machine("beelink.tail58bdd3.ts.net"), Machine { online: false, ..machine("attic.tail58bdd3.ts.net") }];
    let (run, asked) = tailscale(status("laptop.tail58bdd3.ts.net", &peers));
    let origin = |name: &str| resolve(name, &run).map(|address| address.map(|address| address.origin()));
    assert_eq!(origin("alarm"), Ok(Some("https://alarm.tail58bdd3.ts.net".to_string())));
    assert_eq!(origin(" Beelink "), Ok(Some("https://beelink.tail58bdd3.ts.net".to_string())));
    // A machine that is off still has its name: asking it is what says it is off.
    assert_eq!(origin("attic"), Ok(Some("https://attic.tail58bdd3.ts.net".to_string())));
    // This machine's own name is this machine's own ghost, as `local` is.
    assert_eq!(origin("laptop"), Ok(None));
    assert_eq!(origin("alarmm"), Err(Refusal::Failed("No machine on your tailnet is named \"alarmm\" (`tailscale status` lists them).".to_string())));
    assert_eq!(asked.load(Ordering::SeqCst), 5);

    // `local`, a full name and an origin are what they say: Tailscale is not asked.
    assert_eq!(origin("local"), Ok(None));
    assert_eq!(origin("alarm.tail58bdd3.ts.net"), Ok(Some("https://alarm.tail58bdd3.ts.net".to_string())));
    assert_eq!(origin("http://127.0.0.1:7000"), Ok(Some("http://127.0.0.1:7000".to_string())));
    assert_eq!(
        origin("ftp://alarm"),
        Err(Refusal::Usage(
            "\"ftp://alarm\" is not a machine's address: give its name on your tailnet, or an address like machine.tailnet.ts.net or https://machine.tailnet.ts.net.".to_string()
        ))
    );
    assert_eq!(asked.load(Ordering::SeqCst), 5);
}

#[test]
fn a_short_name_needs_tailscale_and_says_so_with_what_still_works() {
    let cannot = |run: &TailscaleRunner| resolve("alarm", run).unwrap_err();
    let rest = ", so \"alarm\" cannot be looked up: give the machine's full address (`ghost use alarm.<tailnet>.ts.net`).";
    assert_eq!(cannot(&failing(CommandFailure::Missing)), Refusal::Failed(format!("Tailscale is not installed here{rest}")));
    assert_eq!(
        cannot(&failing(CommandFailure::Other("failed to connect to local tailscaled\nmore".into()))),
        Refusal::Failed(format!("Tailscale did not answer here (failed to connect to local tailscaled){rest}"))
    );
    let mut signed_out = status("laptop.tail.ts.net", &[machine("alarm.tail.ts.net")]);
    signed_out["BackendState"] = json!("NeedsLogin");
    assert_eq!(cannot(&tailscale(signed_out.clone()).0), Refusal::Failed(format!("Tailscale is not signed in here{rest}")));
    signed_out["BackendState"] = json!("Stopped");
    assert_eq!(cannot(&tailscale(signed_out).0), Refusal::Failed(format!("Tailscale is not running here{rest}")));
    // With no Tailscale, an address is still an address.
    assert!(resolve("alarm.tail.ts.net", &failing(CommandFailure::Missing)).unwrap().is_some());
}

// The ghost is asked first, and its address saved only once it has answered as this caller's own.
#[test]
fn a_ghost_is_saved_only_after_it_answers_its_owner_and_every_failure_writes_nothing() {
    let scratch = Scratch::new();
    let use_it = |there: &There| use_ghost(&scratch.env, &scratch.dir, Some(&there.address()));

    // Each thing that can be wrong there is one sentence that says which, and no file is made.
    let nobody = crate::client::tests::refusing();
    let gone = GhostAddress::parse(&format!("http://127.0.0.1:{}", nobody.port)).unwrap();
    let Err(Refusal::Unreachable(lost)) = use_ghost(&scratch.env, &scratch.dir, Some(&gone)) else { panic!("nothing answers there") };
    assert!(lost.starts_with(&format!("No ghost answers at http://127.0.0.1:{} (", nobody.port)), "{lost}");
    assert!(
        lost.ends_with("), so nothing was saved: that machine must be on, with Tailscale Serve on for its ghost (`ghost status` there says how)."),
        "{lost}"
    );
    for status in [401, 403] {
        let stranger = There::new(status, json!({ "error": { "code": "unauthorized", "message": "Unauthorized." } }));
        assert_eq!(
            use_it(&stranger),
            Err(Refusal::Refused(format!(
                "The ghost at {} does not take this machine for its owner's, so nothing was saved: sign this machine in to the Tailscale account that machine is on.",
                stranger.at("127.0.0.1")
            )))
        );
    }
    // Something else is served there: a page, another API, or a 404.
    for (status, body) in
        [(200, json!("<html>")), (200, json!({ "ok": true })), (404, json!({ "error": { "code": "not_found", "message": "Not found." } }))]
    {
        let other = There::new(status, body);
        assert_eq!(
            use_it(&other),
            Err(Refusal::Failed(format!(
                "What answers at {} is not a ghost, so nothing was saved: Tailscale Serve there must pass port 443 to ghostd (`ghost status` there says how).",
                other.at("127.0.0.1")
            )))
        );
    }
    let empty = There::new(200, json!({ "name": "casper", "model": false, "topics": { "path": "/t", "count": 0 } }));
    assert_eq!(
        use_it(&empty),
        Err(Refusal::Failed(
            "The ghost on 127.0.0.1 has no model to answer with, so nothing was saved: set `local.model` in ~/.config/ghost/config.json there."
                .to_string()
        ))
    );
    assert_eq!(scratch.config(), None);
    assert!(!scratch.dir.join("config").exists());

    // A ghost that answers: asked once, with no token, and then saved, making the file and its directory.
    let there = There::ghost();
    assert_eq!(use_it(&there), Ok("The ghost on 127.0.0.1 answers here now.".to_string()));
    assert_eq!(there.asked(), ["GET /api/ghost None"]);
    assert_eq!(scratch.config(), Some(format!("{{\n  \"ghost\": \"{}\"\n}}\n", there.at("127.0.0.1"))));
    // One from before the daemon said whether it has a model is taken at its word that it is a ghost.
    let older = There::new(200, json!({ "name": "casper", "topics": { "path": "/t", "count": 0 } }));
    assert!(use_it(&older).is_ok());
    assert_eq!(saved_ghost(&scratch.env, &scratch.dir), Ok(Some(older.address())));

    // A failure leaves the one saved before as it was.
    let before = scratch.config();
    assert!(use_it(&empty).is_err());
    assert_eq!(scratch.config(), before);

    // Back to this machine's own: nothing is asked, the key goes, and saying so again changes nothing.
    for _ in 0..2 {
        assert_eq!(use_ghost(&scratch.env, &scratch.dir, None), Ok("This machine's own ghost answers here now.".to_string()));
        assert_eq!(scratch.config(), Some("{}\n".to_string()));
    }

    // A config ghostd would refuse is not rewritten, though the ghost answered: the sentence says what is wrong.
    scratch.write_config(json!({ "prot": 7717 }));
    let before = scratch.config();
    let Err(Refusal::Failed(refused)) = use_it(&there) else { panic!("the config is not rewritten") };
    assert!(
        refused.starts_with("Nothing was saved: ")
            && refused.ends_with("unknown \"prot\"; the keys are \"port\", \"home\", \"remote\", \"local\", \"ghost\"."),
        "{refused}"
    );
    assert_eq!(scratch.config(), before);
}

// The listing: the owner's own machines that are on are asked, all at once, and those with a ghost that answers are
// listed, this machine's own first, the one in use marked.
#[test]
fn finds_the_ghosts_that_answer_on_the_owners_own_machines() {
    let mut scratch = Scratch::new();
    let (alarm, beelink) = (There::ghost(), There::ghost());
    let refuses = There::new(401, json!({ "error": { "code": "unauthorized", "message": "Unauthorized." } }));
    let no_model = There::new(200, json!({ "name": "casper", "model": false }));
    let not_a_ghost = There::new(200, json!({ "ok": true }));
    // Never asked: a phone, a machine that is off, a partner's, and a tagged server.
    let skipped = There::ghost();
    let nobody = crate::client::tests::refusing();
    let (localhost, numbered) = (alarm.at("localhost"), beelink.at("127.0.0.1"));
    let unanswered = format!("http://127.0.0.1:{}", nobody.port);
    let skipped_at = skipped.at("127.0.0.1");
    let (refuses_at, no_model_at, not_a_ghost_at) = (refuses.at("127.0.0.1"), no_model.at("127.0.0.1"), not_a_ghost.at("127.0.0.1"));
    let peers = [
        machine(&numbered),
        machine(&localhost),
        machine(&unanswered),
        machine(&refuses_at),
        machine(&no_model_at),
        machine(&not_a_ghost_at),
        Machine { os: "iOS", ..machine(&skipped_at) },
        Machine { os: "android", ..machine(&skipped_at) },
        Machine { online: false, ..machine(&skipped_at) },
        Machine { owners: false, ..machine(&skipped_at) },
        Machine { tagged: true, ..machine(&skipped_at) },
    ];
    let (run, asked) = tailscale(status("laptop.tail.ts.net", &peers));
    let ghost = |machine: &str, address: Option<&str>, in_use: bool| Ghost {
        machine: machine.to_string(),
        address: address.map(|address| GhostAddress::parse(address).unwrap()),
        in_use,
    };

    // No daemon on this machine: the two that answer, by name; neither is in use, this machine's own is.
    let found = find(&scratch.env, &scratch.dir, &run).unwrap();
    assert_eq!(found, Found { ghosts: vec![ghost("127.0.0.1", Some(&numbered), false), ghost("localhost", Some(&localhost), false)], in_use: None });
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    assert_eq!((alarm.asked(), beelink.asked()), (vec!["GET /api/ghost None".to_string()], vec!["GET /api/ghost None".to_string()]));
    assert_eq!((refuses.asked().len(), no_model.asked().len(), not_a_ghost.asked().len(), skipped.asked().len()), (1, 1, 1, 0));
    // Finding changes nothing.
    assert_eq!(scratch.config(), None);

    // This machine's own daemon answers, with its token: it is first, named as Tailscale names this machine.
    let here = There::ghost();
    scratch.env.insert("GHOSTD_PORT".into(), here.server.address.port().to_string());
    std::fs::write(scratch.dir.join("api-token"), format!("{}\n", "a".repeat(64))).unwrap();
    std::fs::set_permissions(scratch.dir.join("api-token"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    scratch.write_config(json!({ "ghost": localhost }));
    let found = find(&scratch.env, &scratch.dir, &run).unwrap();
    assert_eq!(
        found,
        Found {
            ghosts: vec![ghost("laptop", None, false), ghost("127.0.0.1", Some(&numbered), false), ghost("localhost", Some(&localhost), true)],
            in_use: GhostAddress::parse(&localhost),
        }
    );
    assert_eq!(here.asked(), [format!("GET /api/ghost Some(\"Bearer {}\")", "a".repeat(64))]);
    // One in use that does not answer is still said to be the one in use.
    scratch.write_config(json!({ "ghost": unanswered }));
    let found = find(&scratch.env, &scratch.dir, &run).unwrap();
    assert_eq!((found.ghosts.iter().filter(|ghost| ghost.in_use).count(), found.in_use), (0, GhostAddress::parse(&unanswered)));

    // Without Tailscale there is no list, and the reason is which of the four it is.
    assert_eq!(find(&scratch.env, &scratch.dir, &failing(CommandFailure::Missing)), Err(NotFound::Tailnet(Tailnet::Missing)));
    let mut signed_out = status("laptop.tail.ts.net", &[]);
    signed_out["BackendState"] = json!("NeedsLogin");
    assert_eq!(find(&scratch.env, &scratch.dir, &tailscale(signed_out).0), Err(NotFound::Tailnet(Tailnet::SignedOut)));
    // A config that cannot be read is said, not searched around.
    scratch.write_config(json!({ "ghost": 7 }));
    assert!(matches!(find(&scratch.env, &scratch.dir, &run), Err(NotFound::Config(message)) if message.contains("\"ghost\" must be")));
}

// The bar's offer is for a machine with nothing of its own to ask, and for no other.
#[test]
fn only_a_machine_with_no_model_and_no_ghost_set_is_wanting_and_is_offered_the_ghosts_of_others() {
    let mut scratch = Scratch::new();
    let (here, there) = (There::ghost(), There::ghost());
    let address = there.at("localhost");
    let (run, _) = tailscale(status("laptop.tail.ts.net", &[machine(&address)]));
    let wants = |env: &Env| wanting(env, &scratch.dir);

    // No config at all: nothing here could answer, whether or not a daemon runs.
    assert!(wants(&scratch.env));
    scratch.write_config(json!({ "port": 7000, "remote": { "owner": "me@example.com" } }));
    assert!(wants(&scratch.env));
    // A machine with a model has its own ghost, and one whose ghost is set has that one.
    scratch.write_config(json!({ "local": { "model": "/m.gguf" } }));
    assert!(!wants(&scratch.env));
    scratch.write_config(json!({ "ghost": address }));
    assert!(!wants(&scratch.env));
    scratch.write_config(json!({}));
    let mut env = scratch.env.clone();
    env.insert("GHOST_AT".into(), address.clone());
    assert!(!wants(&env));
    // Nor is one whose config cannot be read: the bar says that instead.
    scratch.write_config(json!({ "prot": 1 }));
    assert!(!wants(&scratch.env));

    // What it is offered is the ghosts of other machines: never this machine's own daemon, even one that answers.
    scratch.write_config(json!({}));
    scratch.env.insert("GHOSTD_PORT".into(), here.server.address.port().to_string());
    assert_eq!(find(&scratch.env, &scratch.dir, &run).unwrap().ghosts.len(), 2);
    assert_eq!(
        others(&scratch.env, &scratch.dir, &run),
        Ok(vec![Ghost { machine: "localhost".into(), address: GhostAddress::parse(&address), in_use: false }])
    );
    // Or why none can be looked for.
    assert_eq!(others(&scratch.env, &scratch.dir, &failing(CommandFailure::Missing)), Err(Tailnet::Missing));
}
