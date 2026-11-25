use super::*;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};

const FAKE_TARGET: &str = "http://127.0.0.1:7717";
const FAKE_HOSTNAME: &str = "ghostbox.example.ts.net";

/// What the fake `tailscale` reports and what Ghost asked of it.
struct FakeState {
    calls: Vec<Vec<String>>,
    /// The listeners `tailscale serve status` reports; `serve --bg` turns HTTPS on and `serve ... off` either off.
    https: bool,
    /// A plain-HTTP (port 80) entry only an earlier version wrote; Ghost now only clears it.
    http: bool,
    certs: bool,
    backend_state: String,
}

#[derive(Clone)]
struct FakeTailscale(Arc<Mutex<FakeState>>);

fn ok(stdout: impl Into<String>) -> Result<CommandResult, CommandFailure> {
    Ok(CommandResult { stdout: stdout.into(), stderr: String::new(), code: 0 })
}

impl FakeTailscale {
    /// A `tailscale` that answers `status`, `serve status`, `serve --bg`, and `serve ... off` from its fields.
    fn new() -> Self {
        Self(Arc::new(Mutex::new(FakeState { calls: Vec::new(), https: false, http: false, certs: true, backend_state: "Running".into() })))
    }
    fn with(self, change: impl FnOnce(&mut FakeState)) -> Self {
        change(&mut self.0.lock().unwrap());
        self
    }
    fn https(self) -> Self {
        self.with(|fake| fake.https = true)
    }
    fn http(self) -> Self {
        self.with(|fake| fake.http = true)
    }
    fn no_certs(self) -> Self {
        self.with(|fake| fake.certs = false)
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
                "User": { "42": { "LoginName": "owner@example.com" }, "7": { "LoginName": "partner@example.com" } },
                "CertDomains": if fake.certs { json!([FAKE_HOSTNAME]) } else { json!([]) },
            })
            .to_string()),
            "serve status --json" => {
                let mut web = serde_json::Map::new();
                for port in [fake.https.then_some("443"), fake.http.then_some("80")].into_iter().flatten() {
                    web.insert(format!("{FAKE_HOSTNAME}:{port}"), json!({ "Handlers": { "/": { "Proxy": FAKE_TARGET } } }));
                }
                ok(if web.is_empty() { json!({}) } else { json!({ "Web": web }) }.to_string())
            }
            "serve --bg --https=443 http://127.0.0.1:7717" => {
                fake.https = true;
                ok("")
            }
            "serve --https=443 off" => {
                fake.https = false;
                ok("")
            }
            "serve --http=80 off" => {
                fake.http = false;
                ok("")
            }
            _ => Err(CommandFailure::Other(format!("Unexpected command: {line}"))),
        }
    }

    fn runner(&self) -> TailscaleRunner {
        let fake = self.clone();
        Arc::new(move |args| fake.answer(args))
    }

    /// A RemoteServe over this fake, as the earlier daemon built one by default: no guests, no apps.
    fn serve(&self) -> RemoteServe {
        self.serve_with(None, &[])
    }
    fn serve_with(&self, owner: Option<&str>, apps: &[&str]) -> RemoteServe {
        RemoteServe::new(7717, &remote(owner, Guests::None, apps), self.runner())
    }

    /// The Serve writes asked for: every `serve` call but `serve status`.
    fn writes(&self) -> Vec<String> {
        self.0.lock().unwrap().calls.iter().filter(|args| args[0] == "serve" && args[1] != "status").map(|args| args.join(" ")).collect()
    }
}

fn remote(owner: Option<&str>, guests: Guests, apps: &[&str]) -> RemoteConfig {
    RemoteConfig { owner: owner.map(str::to_string), guests, apps: apps.iter().map(|app| app.to_string()).collect() }
}

fn missing_binary() -> TailscaleRunner {
    Arc::new(|_| Err(CommandFailure::Missing))
}

const APP: &str = "https://summonghost.com";

// ── Serve status ────────────────────────────────────────────────────────

#[test]
fn derives_an_https_url_owner_and_guest_policy_from_tailscale_json() {
    let status = FakeTailscale::new().https().serve().status();
    assert_eq!(
        status.to_json(),
        json!({ "state": "on", "hostname": "ghostbox.example.ts.net", "guests": "none", "owner": "owner@example.com", "app": null, "command": "tailscale serve --bg --https=443 http://127.0.0.1:7717", "problem": null })
    );
    // The policy and the owner reported are the ones configured, the owner as it is compared.
    let configured = RemoteServe::new(7717, &remote(Some(" Partner@Example.com "), Guests::ReadOnly, &[]), FakeTailscale::new().runner()).status();
    assert_eq!((configured.guests.as_str(), configured.owner.as_deref(), configured.state), ("read-only", Some("partner@example.com"), "off"));
}

#[test]
fn links_the_first_app_to_this_machine_only_once_serve_is_on_https() {
    let apps = [APP, "https://lab.summonghost.com"];
    assert_eq!(
        FakeTailscale::new().https().serve_with(None, &apps).status().to_json()["app"],
        json!({ "origin": APP, "url": "https://summonghost.com/#add=ghostbox.example.ts.net" })
    );
    for fake in [FakeTailscale::new().http().no_certs(), FakeTailscale::new()] {
        assert_eq!(fake.serve_with(None, &apps).status().to_json()["app"], json!({ "origin": APP, "url": null }));
    }
}

#[test]
fn links_a_conversation_in_the_first_app_only_while_there_is_an_app_link() {
    let linked = FakeTailscale::new().https().serve_with(None, &[APP]);
    assert_eq!(linked.conversation_url("c 1").as_deref(), Some("https://summonghost.com/#/ghostbox.example.ts.net/c%201"));
    for serve in [
        FakeTailscale::new().https().serve_with(None, &[]),
        FakeTailscale::new().no_certs().http().serve_with(None, &[APP]),
        FakeTailscale::new().serve_with(None, &[APP]),
    ] {
        assert_eq!(serve.conversation_url("c1"), None);
    }
}

#[test]
fn reports_a_plain_http_entry_an_earlier_version_wrote_as_off_since_no_app_can_use_it() {
    let status = FakeTailscale::new().no_certs().http().serve().status();
    assert_eq!((status.state, status.problem), ("off", None));
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
            "state": "unavailable", "hostname": "ghostbox.example.ts.net", "guests": "none", "owner": "owner@example.com", "app": null,
            "command": "tailscale serve --bg --https=443 http://127.0.0.1:7717",
            "problem": { "code": "not_logged_in", "message": "This machine is not logged in to Tailscale.", "action": "tailscale up" },
        })
    );
    // A tailscale that is there and does not answer is stopped, in its own first words.
    let silent: TailscaleRunner = Arc::new(|_| {
        Ok(CommandResult { stdout: String::new(), stderr: "failed to connect to local tailscaled\n(is it running?)\n".into(), code: 1 })
    });
    let problem = RemoteServe::new(7717, &remote(None, Guests::None, &[]), silent).status().problem.unwrap();
    assert_eq!(problem.to_json(), json!({ "code": "tailscale_stopped", "message": "failed to connect to local tailscaled" }));
}

#[test]
fn reports_a_missing_tailscale_binary_with_its_install_action() {
    let status = RemoteServe::new(7717, &remote(None, Guests::None, &[APP]), missing_binary()).status();
    assert_eq!(
        status.to_json(),
        json!({
            "state": "unavailable", "hostname": null, "guests": "none", "owner": null, "app": { "origin": APP, "url": null },
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
        let status = RemoteServe::new(7717, &remote(None, Guests::None, &[]), runner).status();
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
fn only_an_https_proxy_to_this_daemon_is_remote_access_and_ghost_writes_nothing() {
    let served = |web: Value| -> &'static str {
        let fake = FakeTailscale::new();
        let inner = fake.clone();
        let runner: TailscaleRunner =
            Arc::new(move |args| if args == ["serve", "status", "--json"] { ok(json!({ "Web": web }).to_string()) } else { inner.answer(args) });
        let serve = RemoteServe::new(7717, &remote(None, Guests::None, &[]), runner);
        let status = serve.status();
        // Turning Serve on is Tailscale's command, which the status names; Ghost only reads.
        assert_eq!(status.command, "tailscale serve --bg --https=443 http://127.0.0.1:7717");
        assert!(fake.writes().is_empty());
        status.state
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
        FakeTailscale::new().serve_with(Some("Partner@Example.com"), &[]).machines().unwrap(),
        json!([{ "hostname": "partner.example.ts.net", "online": true }])
    );
}

#[test]
fn machines_is_a_503_when_tailscale_does_not_answer() {
    let error = RemoteServe::new(7717, &remote(None, Guests::None, &[]), missing_binary()).machines().unwrap_err();
    assert_eq!((error.code.as_str(), error.status), ("tailscale_unavailable", 503));
    assert!(error.message.starts_with("Tailscale did not answer: "), "{}", error.message);
}

// ── Who is calling: RemoteAccess::identify ──────────────────────────────

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

fn access(owner: Option<&str>, guests: Guests) -> RemoteAccess {
    RemoteAccess::with_self_login(&remote(owner, guests, &[]), Box::new(|| Some("Owner@Example.com".to_string())))
}

fn role(access: &RemoteAccess, login: &str) -> Option<Role> {
    access.identify(Some(login), LOOPBACK).map(|identity| identity.role)
}

#[test]
fn admits_the_owner_fully_and_guests_read_only() {
    let access = access(None, Guests::ReadOnly);
    assert_eq!(
        access.identify(Some("guest@example.com"), LOOPBACK),
        Some(TailscaleIdentity { login: "guest@example.com".into(), role: Role::Guest })
    );
    assert_eq!(
        access.identify(Some("owner@example.com"), LOOPBACK),
        Some(TailscaleIdentity { login: "owner@example.com".into(), role: Role::Owner })
    );
    // A login is compared without its case or the space around it, and reported that way.
    assert_eq!(
        access.identify(Some(" OWNER@example.com "), LOOPBACK),
        Some(TailscaleIdentity { login: "owner@example.com".into(), role: Role::Owner })
    );
    assert_eq!((Role::Owner.as_str(), Role::Guest.as_str()), ("owner", "guest"));
    // No header, or an empty one, is no identity.
    assert_eq!(access.identify(None, LOOPBACK), None);
    assert_eq!(access.identify(Some("  "), LOOPBACK), None);
}

#[test]
fn honours_guests_none_and_a_configured_owner_login() {
    let access = access(Some(" Guest@Example.com "), Guests::None);
    assert_eq!(role(&access, "owner@example.com"), None);
    assert_eq!(role(&access, "guest@example.com"), Some(Role::Owner));
    assert_eq!(access.owner_login().as_deref(), Some("guest@example.com"));
    // An empty configured owner is none: the node's own login owns.
    let unset = self::access(Some("  "), Guests::None);
    assert_eq!(role(&unset, "owner@example.com"), Some(Role::Owner));
    assert_eq!(role(&unset, "guest@example.com"), None);
}

#[test]
fn accepts_the_identity_only_on_a_loopback_connection() {
    let access = access(None, Guests::ReadOnly);
    let from = |peer: &str| access.identify(Some("owner@example.com"), peer.parse().unwrap()).map(|identity| identity.role);
    for loopback in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
        assert_eq!(from(loopback), Some(Role::Owner), "{loopback}");
    }
    // The tailnet address itself, a LAN address, and the rest of 127.0.0.0/8 are not where Serve calls from.
    for elsewhere in ["100.101.102.103", "192.168.1.20", "127.0.0.2", "::ffff:192.168.1.20", "fd7a:115c:a1e0::1"] {
        assert_eq!(from(elsewhere), None, "{elsewhere}");
    }
    assert_eq!(access.identify(Some("owner@example.com"), IpAddr::V6(Ipv6Addr::UNSPECIFIED)), None);
}

#[test]
fn resolves_the_owner_once_it_is_known_and_asks_again_until_then() {
    let asked = Arc::new(AtomicUsize::new(0));
    let count = asked.clone();
    // Tailscale does not answer the first time.
    let access = RemoteAccess::with_self_login(
        &remote(None, Guests::ReadOnly, &[]),
        Box::new(move || (count.fetch_add(1, Ordering::SeqCst) > 0).then(|| "Owner@Example.com".to_string())),
    );
    assert_eq!(role(&access, "owner@example.com"), Some(Role::Guest));
    assert_eq!(role(&access, "owner@example.com"), Some(Role::Owner));
    assert_eq!(role(&access, "owner@example.com"), Some(Role::Owner));
    assert_eq!(asked.load(Ordering::SeqCst), 2);

    // With guests refused, an owner nobody can name admits no one.
    let unknown = RemoteAccess::with_self_login(&remote(None, Guests::None, &[]), Box::new(|| None));
    assert_eq!(role(&unknown, "owner@example.com"), None);
    // A configured owner never asks Tailscale.
    let configured = RemoteAccess::with_self_login(&remote(Some("me@example.com"), Guests::None, &[]), Box::new(|| panic!("tailscale was asked")));
    assert_eq!(role(&configured, "me@example.com"), Some(Role::Owner));
}

#[test]
fn reads_the_owner_from_tailscale_status_itself() {
    let fake = FakeTailscale::new();
    let access = RemoteAccess::new(&remote(None, Guests::ReadOnly, &[]), fake.runner());
    assert_eq!(role(&access, "Owner@example.com"), Some(Role::Owner));
    assert_eq!(role(&access, "partner@example.com"), Some(Role::Guest));
    assert_eq!(fake.0.lock().unwrap().calls, [["status", "--json"]]);
    // Without Tailscale there is no owner, so everyone is at most a guest.
    let missing = RemoteAccess::new(&remote(None, Guests::ReadOnly, &[]), missing_binary());
    assert_eq!(role(&missing, "owner@example.com"), Some(Role::Guest));
}

#[test]
fn reads_a_node_out_of_tailscale_status() {
    let node = read_tailscale_node(&FakeTailscale::new().runner()).unwrap();
    assert_eq!(
        (node.backend_state.as_str(), node.login.as_deref(), node.hostname.as_deref(), node.certs),
        ("Running", Some("owner@example.com"), Some(FAKE_HOSTNAME), true)
    );
    let tagged = TailscalePeer { hostname: "server.example.ts.net".into(), login: None, online: true };
    assert_eq!(node.peers.len(), 4);
    assert_eq!(node.peers[3], tagged);
    assert_eq!(node.peers[2].login.as_deref(), Some("partner@example.com"));

    let answering = |result: CommandResult| -> TailscaleRunner { Arc::new(move |_| Ok(result.clone())) };
    // A status with almost nothing in it is still a node: logged out, unnamed, without certificates or peers.
    let bare = json!({ "Self": { "DNSName": " . ", "UserID": "9" }, "User": { "9": { "LoginName": "  " } }, "Peer": { "x": { "DNSName": "" } }, "CertDomains": [""] });
    let empty = read_tailscale_node(&answering(CommandResult { stdout: bare.to_string(), ..Default::default() })).unwrap();
    assert_eq!(empty, TailscaleNode { backend_state: String::new(), login: None, hostname: None, certs: false, peers: Vec::new() });
    // A failure says what tailscale said: stderr, else stdout, else its exit code.
    let failed = |stdout: &str, stderr: &str| {
        read_tailscale_node(&answering(CommandResult { stdout: stdout.into(), stderr: stderr.into(), code: 4 })).unwrap_err().to_string()
    };
    assert_eq!(failed("out\n", " err \n"), "err");
    assert_eq!(failed(" out\n", ""), "out");
    assert_eq!(failed("", ""), "tailscale exited with code 4");
    assert!(read_tailscale_node(&answering(CommandResult { stdout: "<html>".into(), ..Default::default() })).is_err());
    assert_eq!(read_tailscale_node(&missing_binary()), Err(CommandFailure::Missing));
}
