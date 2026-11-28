use super::*;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};

const FAKE_TARGET: &str = "http://127.0.0.1:7717";
const FAKE_HOSTNAME: &str = "ghostbox.example.ts.net";

/// What the fake `tailscale` reports and what Ghost asked of it.
struct FakeState {
    calls: Vec<Vec<String>>,
    /// Whether `tailscale serve status` reports this daemon served on HTTPS.
    https: bool,
    backend_state: String,
}

#[derive(Clone)]
struct FakeTailscale(Arc<Mutex<FakeState>>);

fn ok(stdout: impl Into<String>) -> Result<CommandResult, CommandFailure> {
    Ok(CommandResult { stdout: stdout.into(), stderr: String::new(), code: 0 })
}

impl FakeTailscale {
    /// A `tailscale` that answers `status` and `serve status` from its fields, and nothing else.
    fn new() -> Self {
        Self(Arc::new(Mutex::new(FakeState { calls: Vec::new(), https: false, backend_state: "Running".into() })))
    }
    fn with(self, change: impl FnOnce(&mut FakeState)) -> Self {
        change(&mut self.0.lock().unwrap());
        self
    }
    fn https(self) -> Self {
        self.with(|fake| fake.https = true)
    }

    fn answer(&self, args: &[&str]) -> Result<CommandResult, CommandFailure> {
        let mut fake = self.0.lock().unwrap();
        fake.calls.push(args.iter().map(|arg| arg.to_string()).collect());
        let line = args.join(" ");
        match line.as_str() {
            "status --json" => ok(json!({
                "BackendState": fake.backend_state,
                "Self": { "DNSName": format!("{FAKE_HOSTNAME}."), "UserID": 42 },
                // The owner's laptop and phone, a partner's shared machine, and a tagged server.
                "Peer": {
                    "a": { "DNSName": "laptop.example.ts.net.", "UserID": 42, "Online": true },
                    "b": { "DNSName": "phone.example.ts.net.", "UserID": 42, "Online": false },
                    "c": { "DNSName": "partner.example.ts.net.", "UserID": 7, "Online": true },
                    "d": { "DNSName": "server.example.ts.net.", "UserID": 42, "Online": true, "Tags": ["tag:server"] },
                },
                "User": { "42": { "LoginName": "Owner@Example.com" }, "7": { "LoginName": "partner@example.com" } },
            })
            .to_string()),
            "serve status --json" => {
                let mut web = serde_json::Map::new();
                if fake.https {
                    web.insert(format!("{FAKE_HOSTNAME}:443"), json!({ "Handlers": { "/": { "Proxy": FAKE_TARGET } } }));
                }
                ok(if web.is_empty() { json!({}) } else { json!({ "Web": web }) }.to_string())
            }
            _ => Err(CommandFailure::Other(format!("Unexpected command: {line}"))),
        }
    }

    fn runner(&self) -> TailscaleRunner {
        let fake = self.clone();
        Arc::new(move |args| fake.answer(args))
    }

    /// A RemoteServe over this fake, with no apps.
    fn serve(&self) -> RemoteServe {
        self.serve_with(None, &[])
    }
    fn serve_with(&self, owner: Option<&str>, apps: &[&str]) -> RemoteServe {
        RemoteServe::new(7717, &remote(owner, apps), self.runner())
    }
}

fn remote(owner: Option<&str>, apps: &[&str]) -> RemoteConfig {
    RemoteConfig { owner: owner.map(str::to_string), apps: apps.iter().map(|app| app.to_string()).collect() }
}

fn missing_binary() -> TailscaleRunner {
    Arc::new(|_| Err(CommandFailure::Missing))
}

const APP: &str = "https://summonghost.com";

// ── Serve status ────────────────────────────────────────────────────────

#[test]
fn reports_the_state_hostname_owner_and_command_from_tailscale_json() {
    let status = FakeTailscale::new().https().serve().status();
    assert_eq!(
        status.to_json(),
        json!({ "state": "on", "hostname": "ghostbox.example.ts.net", "owner": "owner@example.com", "app": null, "command": "tailscale serve --bg --https=443 http://127.0.0.1:7717", "problem": null })
    );
    // The owner reported is the one configured.
    let configured = RemoteServe::new(7717, &remote(Some("partner@example.com"), &[]), FakeTailscale::new().runner()).status();
    assert_eq!((configured.owner.as_deref(), configured.state), (Some("partner@example.com"), "off"));
}

#[test]
fn links_the_first_app_to_this_machine_only_once_serve_is_on_https() {
    let apps = [APP, "https://lab.summonghost.com"];
    assert_eq!(
        FakeTailscale::new().https().serve_with(None, &apps).status().to_json()["app"],
        json!({ "origin": APP, "url": "https://summonghost.com/#add=ghostbox.example.ts.net" })
    );
    assert_eq!(FakeTailscale::new().serve_with(None, &apps).status().to_json()["app"], json!({ "origin": APP, "url": null }));
}

#[test]
fn links_this_machine_in_the_first_app_only_while_there_is_an_app_link() {
    let linked = FakeTailscale::new().https().serve_with(None, &[APP]);
    assert_eq!(linked.machine_url().as_deref(), Some("https://summonghost.com/#/ghostbox.example.ts.net"));
    for serve in [FakeTailscale::new().https().serve_with(None, &[]), FakeTailscale::new().serve_with(None, &[APP])] {
        assert_eq!(serve.machine_url(), None);
    }
}

#[test]
fn reports_a_stopped_daemon_as_unavailable() {
    let stopped = FakeTailscale::new().with(|fake| fake.backend_state = "Stopped".into()).serve().status();
    assert_eq!(
        (stopped.state, stopped.problem.unwrap().to_json()),
        ("unavailable", json!({ "code": "tailscale_stopped", "message": "Tailscale is not running." }))
    );
    // Logged out, the node still says who it was and how to come back.
    let logged_out = FakeTailscale::new().with(|fake| fake.backend_state = "NeedsLogin".into()).serve().status();
    assert_eq!(
        logged_out.to_json(),
        json!({
            "state": "unavailable", "hostname": "ghostbox.example.ts.net", "owner": "owner@example.com", "app": null,
            "command": "tailscale serve --bg --https=443 http://127.0.0.1:7717",
            "problem": { "code": "not_logged_in", "message": "This machine is not logged in to Tailscale.", "action": "tailscale up" },
        })
    );
    // A tailscale that is there and does not answer is stopped, in its own first words.
    let silent: TailscaleRunner = Arc::new(|_| {
        Ok(CommandResult { stdout: String::new(), stderr: "failed to connect to local tailscaled\n(is it running?)\n".into(), code: 1 })
    });
    let problem = RemoteServe::new(7717, &remote(None, &[]), silent).status().problem.unwrap();
    assert_eq!(problem.to_json(), json!({ "code": "tailscale_stopped", "message": "failed to connect to local tailscaled" }));
}

#[test]
fn reports_a_missing_tailscale_binary_with_its_install_action() {
    let status = RemoteServe::new(7717, &remote(None, &[APP]), missing_binary()).status();
    assert_eq!(
        status.to_json(),
        json!({
            "state": "unavailable", "hostname": null, "owner": null, "app": { "origin": APP, "url": null },
            "command": "tailscale serve --bg --https=443 http://127.0.0.1:7717",
            "problem": { "code": "tailscale_missing", "message": "Tailscale is not installed.", "action": "omarchy-install-service-tailscale" },
        })
    );
}

#[test]
fn a_serve_status_that_fails_or_is_not_json_is_a_problem_not_a_state() {
    let fake = FakeTailscale::new();
    let answers = |serve_status: Result<CommandResult, CommandFailure>| -> TailscaleRunner {
        let fake = fake.clone();
        Arc::new(move |args| if args == ["serve", "status", "--json"] { serve_status.clone() } else { fake.answer(args) })
    };
    let problem = |runner: TailscaleRunner| {
        let status = RemoteServe::new(7717, &remote(None, &[]), runner).status();
        assert_eq!((status.state, status.hostname.as_deref()), ("off", Some(FAKE_HOSTNAME)));
        status.problem.unwrap().to_json()
    };
    let refused = Ok(CommandResult { stdout: "out\n".into(), stderr: "\n serve is disabled \nmore\n".into(), code: 1 });
    assert_eq!(problem(answers(refused)), json!({ "code": "serve_failed", "message": "serve is disabled" }));
    let wordless = Ok(CommandResult { stdout: String::new(), stderr: String::new(), code: 3 });
    assert_eq!(problem(answers(wordless)), json!({ "code": "serve_failed", "message": "tailscale exited with code 3" }));
    assert_eq!(problem(answers(Err(CommandFailure::Other("timed out\nlater".into())))), json!({ "code": "serve_failed", "message": "timed out" }));
    let message = problem(answers(ok("not json")))["message"].as_str().unwrap().to_string();
    assert!(message.starts_with("tailscale serve status returned invalid JSON: "), "{message}");
}

#[test]
fn only_an_https_proxy_to_this_daemon_is_remote_access() {
    let served = |web: Value| -> &'static str {
        let fake = FakeTailscale::new();
        let inner = fake.clone();
        let runner: TailscaleRunner =
            Arc::new(move |args| if args == ["serve", "status", "--json"] { ok(json!({ "Web": web }).to_string()) } else { inner.answer(args) });
        RemoteServe::new(7717, &remote(None, &[]), runner).status().state
    };
    let proxy = |target: &str| json!({ "Handlers": { "/": { "Proxy": target } } });
    // A trailing slash is the same target; another port's proxy, another target, or plain HTTP is not it.
    assert_eq!(served(json!({ "ghostbox.example.ts.net:443": proxy("http://127.0.0.1:7717/") })), "on");
    assert_eq!(served(json!({ "ghostbox.example.ts.net:443": proxy("http://127.0.0.1:3000") })), "off");
    assert_eq!(served(json!({ "ghostbox.example.ts.net:8443": proxy(FAKE_TARGET) })), "off");
    assert_eq!(served(json!({ "ghostbox.example.ts.net:443": { "Handlers": { "/": { "Path": "/srv" } } } })), "off");
    assert_eq!(served(json!({ "ghostbox.example.ts.net:80": proxy(FAKE_TARGET) })), "off");
}

// ── Machines ────────────────────────────────────────────────────────────

#[test]
fn lists_the_owners_other_untagged_nodes_online_or_not() {
    assert_eq!(
        FakeTailscale::new().serve().machines().unwrap(),
        json!([{ "hostname": "laptop.example.ts.net", "online": true }, { "hostname": "phone.example.ts.net", "online": false }])
    );
    assert_eq!(
        FakeTailscale::new().serve_with(Some("partner@example.com"), &[]).machines().unwrap(),
        json!([{ "hostname": "partner.example.ts.net", "online": true }])
    );
}

#[test]
fn machines_is_a_503_when_tailscale_does_not_answer() {
    let error = RemoteServe::new(7717, &remote(None, &[]), missing_binary()).machines().unwrap_err();
    assert_eq!((error.code.as_str(), error.status), ("tailscale_unavailable", 503));
    assert!(error.message.starts_with("Tailscale did not answer: "), "{}", error.message);
}

// ── Who is calling: RemoteAccess::identify ──────────────────────────────

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

fn access(owner: Option<&str>) -> RemoteAccess {
    RemoteAccess::with_self_login(&remote(owner, &[]), Box::new(|| Some("Owner@Example.com".to_string())))
}

/// Whether `login` is admitted: only the owner is.
fn admitted(access: &RemoteAccess, login: &str) -> bool {
    access.identify(Some(login), LOOPBACK)
}

#[test]
fn admits_the_owner_and_no_one_else() {
    let access = access(None);
    assert!(admitted(&access, "owner@example.com"));
    // A login is compared without its case or the space around it.
    assert!(admitted(&access, " OWNER@example.com "));
    // Anyone else on the tailnet is no one.
    assert!(!admitted(&access, "someone@example.com"));
    // No header, or an empty one, is no identity.
    assert!(!access.identify(None, LOOPBACK));
    assert!(!admitted(&access, "  "));
}

#[test]
fn honours_a_configured_owner_login() {
    let access = access(Some("partner@example.com"));
    assert!(!admitted(&access, "owner@example.com"));
    assert!(admitted(&access, "Partner@Example.com"));
    assert_eq!(access.owner_login().as_deref(), Some("partner@example.com"));
}

#[test]
fn accepts_the_identity_only_on_a_loopback_connection() {
    let access = access(None);
    let from = |peer: &str| access.identify(Some("owner@example.com"), peer.parse().unwrap());
    for loopback in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
        assert!(from(loopback), "{loopback}");
    }
    // The tailnet address itself, a LAN address, and the rest of 127.0.0.0/8 are not where Serve calls from.
    for elsewhere in ["100.101.102.103", "192.168.1.20", "127.0.0.2", "::ffff:192.168.1.20", "fd7a:115c:a1e0::1"] {
        assert!(!from(elsewhere), "{elsewhere}");
    }
    assert!(!access.identify(Some("owner@example.com"), IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
}

#[test]
fn resolves_the_owner_once_it_is_known_and_asks_again_until_then() {
    let asked = Arc::new(AtomicUsize::new(0));
    let count = asked.clone();
    // Tailscale does not answer the first time.
    let access = RemoteAccess::with_self_login(
        &remote(None, &[]),
        Box::new(move || (count.fetch_add(1, Ordering::SeqCst) > 0).then(|| "Owner@Example.com".to_string())),
    );
    assert!(!admitted(&access, "owner@example.com"));
    assert!(admitted(&access, "owner@example.com"));
    assert!(admitted(&access, "owner@example.com"));
    assert_eq!(asked.load(Ordering::SeqCst), 2);

    // An owner nobody can name admits no one.
    let unknown = RemoteAccess::with_self_login(&remote(None, &[]), Box::new(|| None));
    assert!(!admitted(&unknown, "owner@example.com"));
    // A configured owner never asks Tailscale.
    let configured = RemoteAccess::with_self_login(&remote(Some("me@example.com"), &[]), Box::new(|| panic!("tailscale was asked")));
    assert!(admitted(&configured, "me@example.com"));
}

#[test]
fn reads_the_owner_from_tailscale_status_itself() {
    let fake = FakeTailscale::new();
    let access = RemoteAccess::new(&remote(None, &[]), fake.runner());
    assert!(admitted(&access, "Owner@example.com"));
    assert!(!admitted(&access, "partner@example.com"));
    assert_eq!(fake.0.lock().unwrap().calls, [["status", "--json"]]);
    // Without Tailscale there is no owner, so no one is admitted.
    let missing = RemoteAccess::new(&remote(None, &[]), missing_binary());
    assert!(!admitted(&missing, "owner@example.com"));
}

#[test]
fn reads_a_node_out_of_tailscale_status() {
    let node = read_tailscale_node(&FakeTailscale::new().runner()).unwrap();
    assert_eq!(
        (node.backend_state.as_str(), node.login.as_deref(), node.hostname.as_deref()),
        ("Running", Some("owner@example.com"), Some(FAKE_HOSTNAME))
    );
    let tagged = TailscalePeer { hostname: "server.example.ts.net".into(), login: None, online: true, os: String::new() };
    assert_eq!(node.peers.len(), 4);
    assert_eq!(node.peers[3], tagged);
    assert_eq!(node.peers[2].login.as_deref(), Some("partner@example.com"));

    let answering = |result: CommandResult| -> TailscaleRunner { Arc::new(move |_| Ok(result.clone())) };
    // A status with almost nothing in it is still a node: logged out, unnamed, without peers.
    let bare = json!({ "Self": { "DNSName": " . ", "UserID": "9" }, "User": { "9": { "LoginName": "  " } }, "Peer": { "x": { "DNSName": "" } } });
    let empty = read_tailscale_node(&answering(CommandResult { stdout: bare.to_string(), ..Default::default() })).unwrap();
    assert_eq!(empty, TailscaleNode { backend_state: String::new(), login: None, hostname: None, peers: Vec::new() });
    // A failure says what tailscale said: the first line of stderr, else of stdout, else its exit code.
    let failed = |stdout: &str, stderr: &str| {
        read_tailscale_node(&answering(CommandResult { stdout: stdout.into(), stderr: stderr.into(), code: 4 })).unwrap_err().to_string()
    };
    assert_eq!(failed("out\n", " err \nmore\n"), "err");
    assert_eq!(failed(" out\n", ""), "out");
    assert_eq!(failed("", ""), "tailscale exited with code 4");
    assert!(read_tailscale_node(&answering(CommandResult { stdout: "<html>".into(), ..Default::default() })).is_err());
    assert_eq!(read_tailscale_node(&missing_binary()), Err(CommandFailure::Missing));
}
