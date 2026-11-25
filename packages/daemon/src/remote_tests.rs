use super::*;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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

    fn listeners(&self) -> (bool, bool) {
        let fake = self.0.lock().unwrap();
        (fake.https, fake.http)
    }
    /// The Serve writes asked for: every `serve` call but `serve status`.
    fn writes(&self) -> Vec<String> {
        self.0.lock().unwrap().calls.iter().filter(|args| args[0] == "serve" && args[1] != "status").map(|args| args.join(" ")).collect()
    }
    fn forget_calls(&self) {
        self.0.lock().unwrap().calls.clear();
    }
}

fn remote(owner: Option<&str>, guests: Guests, apps: &[&str]) -> RemoteConfig {
    RemoteConfig { owner: owner.map(str::to_string), guests, apps: apps.iter().map(|app| app.to_string()).collect() }
}

fn missing_binary() -> TailscaleRunner {
    Arc::new(|_| Err(CommandFailure::Missing))
}

const APP: &str = "https://summonghost.com";

// ── remote-serve.test.ts: status ────────────────────────────────────────

#[test]
fn derives_an_https_url_owner_and_guest_policy_from_tailscale_json() {
    let status = FakeTailscale::new().https().serve().status();
    assert_eq!(
        status.to_json(),
        json!({ "state": "on", "hostname": "ghostbox.example.ts.net", "guests": "none", "owner": "owner@example.com", "app": null, "problem": null })
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
fn only_a_proxy_to_this_daemon_on_443_or_80_is_ghosts_own_listener() {
    let served = |web: Value| -> (&'static str, Vec<String>) {
        let fake = FakeTailscale::new();
        let inner = fake.clone();
        let runner: TailscaleRunner =
            Arc::new(move |args| if args == ["serve", "status", "--json"] { ok(json!({ "Web": web }).to_string()) } else { inner.answer(args) });
        let serve = RemoteServe::new(7717, &remote(None, Guests::None, &[]), runner);
        let state = serve.status().state;
        // What disable would turn off shows which listeners were taken for Ghost's.
        fake.forget_calls();
        serve.disable();
        (state, fake.writes())
    };
    let proxy = |target: &str| json!({ "Handlers": { "/": { "Proxy": target } } });
    // A trailing slash is the same target; another port's proxy, or another target, is someone else's.
    assert_eq!(served(json!({ "ghostbox.example.ts.net:443": proxy("http://127.0.0.1:7717/") })).0, "on");
    assert_eq!(served(json!({ "ghostbox.example.ts.net:443": proxy("http://127.0.0.1:3000") })), ("off", vec![]));
    assert_eq!(served(json!({ "ghostbox.example.ts.net:8443": proxy(FAKE_TARGET) })), ("off", vec![]));
    assert_eq!(served(json!({ "ghostbox.example.ts.net:443": { "Handlers": { "/": { "Path": "/srv" } } } })), ("off", vec![]));
    assert_eq!(served(json!({ "ghostbox.example.ts.net:80": proxy(FAKE_TARGET) })), ("off", vec!["serve --http=80 off".to_string()]));
}

// ── remote-serve.test.ts: machines ──────────────────────────────────────

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

// ── remote-serve.test.ts: mutations ─────────────────────────────────────

#[test]
fn serves_over_https_and_without_certificates_writes_nothing_and_says_how_to_get_them() {
    let served = FakeTailscale::new();
    let status = served.serve().enable();
    assert_eq!((status.state, status.problem), ("on", None));
    assert!(served.writes().contains(&format!("serve --bg --https=443 {FAKE_TARGET}")));

    let refused = FakeTailscale::new().no_certs();
    let status = refused.serve().enable();
    let problem = status.problem.unwrap();
    assert_eq!((status.state, problem.code.as_str()), ("off", "https_required"));
    assert!(problem.message.contains("HTTPS Certificates"));
    assert_eq!(refused.writes(), Vec::<String>::new());
}

#[test]
fn clears_a_plain_http_entry_an_earlier_version_wrote_on_enable_and_on_disable() {
    for certs in [true, false] {
        let fake = FakeTailscale::new().http().with(|fake| fake.certs = certs);
        fake.serve().enable();
        let mut expected = vec!["serve --http=80 off".to_string()];
        if certs {
            expected.push(format!("serve --bg --https=443 {FAKE_TARGET}"));
        }
        assert_eq!(fake.writes(), expected);
    }
    let fake = FakeTailscale::new().no_certs().http();
    let status = fake.serve().disable();
    assert_eq!((status.state, status.problem), ("off", None));
    assert_eq!(fake.writes(), ["serve --http=80 off"]);
    assert_eq!(fake.listeners(), (false, false));
}

#[test]
fn turns_off_both_listeners_when_an_https_one_and_an_earlier_versions_http_one_are_on() {
    let fake = FakeTailscale::new().https().http();
    let remote = fake.serve();
    assert_eq!(remote.status().state, "on");
    let status = remote.disable();
    assert_eq!((status.state, status.problem), ("off", None));
    assert_eq!(fake.writes(), ["serve --https=443 off", "serve --http=80 off"]);
    assert_eq!(fake.listeners(), (false, false));
}

#[test]
fn turns_off_only_the_listener_that_is_on_and_nothing_when_none_is() {
    let fake = FakeTailscale::new().https();
    let remote = fake.serve();
    let status = remote.disable();
    assert_eq!((status.state, status.problem), ("off", None));
    assert_eq!(fake.writes(), ["serve --https=443 off"]);
    fake.forget_calls();
    remote.disable();
    assert_eq!(fake.writes(), Vec::<String>::new());
}

#[test]
fn turns_an_operator_failure_into_the_stable_problem_and_remembers_it_until_a_write_is_accepted() {
    let fake = FakeTailscale::new();
    let denied = Arc::new(AtomicBool::new(true));
    let (inner, refusing) = (fake.clone(), denied.clone());
    let runner: TailscaleRunner = Arc::new(move |args| {
        if args.get(1) == Some(&"--bg") && refusing.load(Ordering::SeqCst) {
            return Ok(CommandResult { stdout: String::new(), stderr: "Access denied.\nUse 'sudo tailscale set --operator=$USER'.".into(), code: 1 });
        }
        inner.answer(args)
    });
    let remote = RemoteServe::new(7717, &remote(None, Guests::None, &[]), runner);
    let operator = json!({ "code": "operator_required", "message": "Access denied.", "action": "sudo tailscale set --operator=$USER" });
    assert_eq!(remote.enable().problem.unwrap().to_json(), operator);
    let status = remote.status();
    assert_eq!((status.state, status.problem.unwrap().to_json()), ("off", operator));
    denied.store(false, Ordering::SeqCst);
    let status = remote.enable();
    assert_eq!((status.state, status.problem), ("on", None));
    assert_eq!(remote.status().problem, None);
}

#[test]
fn a_refusal_that_is_not_the_operator_right_is_reported_once_and_not_remembered() {
    let fake = FakeTailscale::new().https();
    let inner = fake.clone();
    let runner: TailscaleRunner = Arc::new(move |args| {
        if args == ["serve", "--https=443", "off"] {
            return Ok(CommandResult { stdout: "busy\n".into(), stderr: String::new(), code: 1 });
        }
        inner.answer(args)
    });
    let remote = RemoteServe::new(7717, &remote(None, Guests::None, &[]), runner);
    let status = remote.disable();
    assert_eq!((status.state, status.problem.unwrap().to_json()), ("on", json!({ "code": "serve_failed", "message": "busy" })));
    assert_eq!(remote.status().problem, None);
    // Nothing is written while Tailscale is unavailable.
    let stopped = FakeTailscale::new().with(|fake| fake.backend_state = "Stopped".into());
    assert_eq!(stopped.serve().enable().state, "unavailable");
    assert_eq!(stopped.writes(), Vec::<String>::new());
}

// ── tailscale-identity.ts, by RemoteAccess::identify ────────────────────

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
