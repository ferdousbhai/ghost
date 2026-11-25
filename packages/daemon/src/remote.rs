//! Remote access (CONTRACTS.md "Daemon HTTP API"). Two halves:
//!
//! Who is calling over the tailnet. `tailscale serve` terminates TLS on the
//! tailnet address, proxies to the loopback daemon, and stamps the caller's
//! identity on the request as `Tailscale-User-Login`, stripping any such
//! header a client sent itself. Ghost accepts the identity only on a loopback
//! connection: on this owner-only machine a local process that could forge
//! the header could already read the API token file, so the header is exactly
//! as trustworthy as Tailscale documents it to be.
//!
//! And Ghost's own Serve exposure: `tailscale serve --bg --https=443`
//! proxying to the daemon, so an app in `remote.apps` reaches its API at the
//! node's tailnet name. The app is an https page, which cannot call an http
//! address, so a tailnet without HTTPS certificates gets no Serve entry at
//! all. Status is read from Tailscale on every call; the one thing remembered
//! is an operator refusal, because only a write attempt can reveal it.
//! Tailscale keeps a `--bg` Serve entry across restarts, so Ghost stores no
//! on/off of its own.
use crate::abort::Abort;
use crate::config::{Guests, RemoteConfig};
use crate::env::Env;
use crate::error::GhostError;
use crate::http::percent_encode;
use crate::process::{CommandFailure, CommandResult, run_command};
use serde_json::{Value, json};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Runs `tailscale` with these arguments; a test hands in a script.
pub type TailscaleRunner = Arc<dyn Fn(&[&str]) -> Result<CommandResult, CommandFailure> + Send + Sync>;

/// The real `tailscale`, bounded at ten seconds a call.
pub fn tailscale_runner(env: Env) -> TailscaleRunner {
    Arc::new(move |args| run_command("tailscale", args, &env, None, Duration::from_secs(10), &Abort::new()))
}

#[derive(Clone, Debug, PartialEq)]
pub struct TailscalePeer {
    pub hostname: String,
    /// None for a tagged node, which is owned by its tags.
    pub login: Option<String>,
    pub online: bool,
}

/// `tailscale status --json`, reduced to what Ghost asks of it.
#[derive(Clone, Debug, PartialEq)]
pub struct TailscaleNode {
    /// `Running`, `NeedsLogin`, `Stopped`, ... as `tailscale status` reports it.
    pub backend_state: String,
    /// The login this node is signed in as.
    pub login: Option<String>,
    /// The node's MagicDNS name, without the trailing dot.
    pub hostname: Option<String>,
    /// Whether the tailnet has HTTPS certificates enabled.
    pub certs: bool,
    pub peers: Vec<TailscalePeer>,
}

fn login_of(users: &Value, user_id: &Value) -> Option<String> {
    let key = match user_id {
        Value::String(id) => id.clone(),
        Value::Number(id) => id.to_string(),
        _ => return None,
    };
    users.get(key)?.get("LoginName")?.as_str().map(str::trim).filter(|login| !login.is_empty()).map(str::to_string)
}

fn dns_hostname(name: &Value) -> Option<String> {
    let name = name.as_str()?.trim();
    let name = name.strip_suffix('.').unwrap_or(name);
    (!name.is_empty()).then(|| name.to_string())
}

/// Ask Tailscale about this node; an error when it is missing or does not answer.
pub fn read_tailscale_node(run: &TailscaleRunner) -> Result<TailscaleNode, CommandFailure> {
    let result = run(&["status", "--json"])?;
    if result.code != 0 {
        let said = [result.stderr.trim(), result.stdout.trim()].into_iter().find(|text| !text.is_empty()).map(str::to_string);
        return Err(CommandFailure::Other(said.unwrap_or_else(|| format!("tailscale exited with code {}", result.code))));
    }
    let status: Value = serde_json::from_str(&result.stdout).map_err(|error| CommandFailure::Other(error.to_string()))?;
    let users = &status["User"];
    let peers = status["Peer"]
        .as_object()
        .map(|peers| {
            peers
                .values()
                .filter_map(|peer| {
                    let hostname = dns_hostname(&peer["DNSName"])?;
                    // A tagged node is owned by its tags, whatever user id it reports.
                    let tagged = peer["Tags"].as_array().is_some_and(|tags| !tags.is_empty());
                    Some(TailscalePeer {
                        hostname,
                        login: if tagged { None } else { login_of(users, &peer["UserID"]) },
                        online: peer["Online"] == true,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(TailscaleNode {
        backend_state: status["BackendState"].as_str().unwrap_or("").to_string(),
        login: login_of(users, &status["Self"]["UserID"]),
        hostname: dns_hostname(&status["Self"]["DNSName"]),
        certs: status["CertDomains"]
            .as_array()
            .is_some_and(|domains| domains.iter().any(|domain| domain.as_str().is_some_and(|name| !name.is_empty()))),
        peers,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Owner,
    Guest,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Guest => "guest",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TailscaleIdentity {
    pub login: String,
    pub role: Role,
}

type SelfLogin = Box<dyn Fn() -> Option<String> + Send + Sync>;

pub struct RemoteAccess {
    self_login: SelfLogin,
    guests: Guests,
    configured_owner: Option<String>,
    /// Resolved once it is known; an unanswered `tailscale status` is asked again next time.
    owner: Mutex<Option<String>>,
}

impl RemoteAccess {
    pub fn new(config: &RemoteConfig, run: TailscaleRunner) -> Self {
        Self::with_self_login(config, Box::new(move || read_tailscale_node(&run).ok()?.login))
    }

    /// Test seam over `tailscale status`.
    pub fn with_self_login(config: &RemoteConfig, self_login: SelfLogin) -> Self {
        let configured_owner = config.owner.as_deref().map(|owner| owner.trim().to_lowercase()).filter(|owner| !owner.is_empty());
        Self { self_login, guests: config.guests, configured_owner, owner: Mutex::new(None) }
    }

    /// The tailnet identity a proxied request carries, or None when it carries none Ghost admits.
    pub fn identify(&self, login_header: Option<&str>, peer: IpAddr) -> Option<TailscaleIdentity> {
        let login = login_header.map(|login| login.trim().to_lowercase()).filter(|login| !login.is_empty())?;
        // The addresses a connection to the daemon's own 127.0.0.1 or ::1 arrives from, and no other in 127.0.0.0/8.
        let loopback = match peer {
            IpAddr::V4(address) => address == Ipv4Addr::LOCALHOST,
            IpAddr::V6(address) => address == Ipv6Addr::LOCALHOST || address.to_ipv4_mapped() == Some(Ipv4Addr::LOCALHOST),
        };
        if !loopback {
            return None;
        }
        let role = if self.owner_login().as_deref() == Some(login.as_str()) { Role::Owner } else { Role::Guest };
        if role == Role::Guest && self.guests == Guests::None {
            return None;
        }
        Some(TailscaleIdentity { login, role })
    }

    pub fn owner_login(&self) -> Option<String> {
        if let Some(owner) = &self.configured_owner {
            return Some(owner.clone());
        }
        let mut owner = self.owner.lock().unwrap();
        if owner.is_none() {
            *owner = (self.self_login)().map(|login| login.to_lowercase());
        }
        owner.clone()
    }
}

// ── Serve ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteProblem {
    pub code: String,
    pub message: String,
    /// A command the owner can run to clear the problem.
    pub action: Option<String>,
}

impl RemoteProblem {
    fn new(code: &str, message: impl Into<String>, action: Option<&str>) -> Self {
        Self { code: code.to_string(), message: message.into(), action: action.map(str::to_string) }
    }
    fn to_json(&self) -> Value {
        let mut problem = json!({ "code": self.code, "message": self.message });
        if let Some(action) = &self.action {
            problem["action"] = json!(action);
        }
        problem
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteStatus {
    /// `on`, `off`, or `unavailable` while Tailscale is missing, stopped, or logged out.
    pub state: &'static str,
    pub hostname: Option<String>,
    pub guests: Guests,
    pub owner: Option<String>,
    /// The first of `remote.apps`, and its link adding this machine
    /// (`<origin>/#add=<hostname>`), None while Serve is off.
    pub app: Option<(String, Option<String>)>,
    pub problem: Option<RemoteProblem>,
}

impl RemoteStatus {
    pub fn to_json(&self) -> Value {
        json!({
            "state": self.state,
            "hostname": self.hostname,
            "guests": self.guests.as_str(),
            "owner": self.owner,
            "app": self.app.as_ref().map(|(origin, url)| json!({ "origin": origin, "url": url })),
            "problem": self.problem.as_ref().map(RemoteProblem::to_json),
        })
    }
}

/// The listeners Ghost writes: HTTPS, and plain HTTP, which earlier versions used without certificates and are now only cleared.
const HTTPS: &str = "--https=443";
const HTTP: &str = "--http=80";
const OPERATOR_ACTION: &str = "sudo tailscale set --operator=$USER";

fn tailscale_missing() -> RemoteProblem {
    RemoteProblem::new("tailscale_missing", "Tailscale is not installed.", Some("omarchy-install-service-tailscale"))
}

fn https_required() -> RemoteProblem {
    RemoteProblem::new(
        "https_required",
        "This tailnet has no HTTPS certificates, which the app needs: turn on HTTPS Certificates on the DNS page of the Tailscale admin console (https://login.tailscale.com/admin/dns), then turn remote access on again.",
        None,
    )
}

fn first_line(text: &str) -> String {
    text.trim().lines().next().unwrap_or("").trim().to_string()
}

fn detail(result: &CommandResult) -> String {
    [first_line(&result.stderr), first_line(&result.stdout)]
        .into_iter()
        .find(|line| !line.is_empty())
        .unwrap_or_else(|| format!("tailscale exited with code {}", result.code))
}

fn serve_failed(message: impl Into<String>) -> RemoteProblem {
    RemoteProblem::new("serve_failed", message, None)
}

/// Ghost's own Serve listeners, from `tailscale serve status --json`: the `Web`
/// map is keyed by `host:port`, and Ghost only ever writes ports 443 and 80.
fn served_listeners(config: &Value, target: &str) -> (bool, bool) {
    let (mut https, mut http) = (false, false);
    for (host_port, server) in config["Web"].as_object().into_iter().flatten() {
        let proxied = server["Handlers"].as_object().is_some_and(|handlers| {
            handlers.values().any(|handler| handler["Proxy"].as_str().is_some_and(|proxy| proxy.strip_suffix('/').unwrap_or(proxy) == target))
        });
        if !proxied {
            continue;
        }
        if host_port.ends_with(":443") {
            https = true;
        } else if host_port.ends_with(":80") {
            http = true;
        }
    }
    (https, http)
}

/// Status plus what only enable and disable need: certificates, and a leftover HTTP entry.
struct Inspection {
    status: RemoteStatus,
    certs: bool,
    http: bool,
}

pub struct RemoteServe {
    target: String,
    run: TailscaleRunner,
    owner: Option<String>,
    guests: Guests,
    app: Option<String>,
    /// The last Serve refusal for lack of the operator right; cleared by the next accepted write.
    operator_problem: Mutex<Option<RemoteProblem>>,
}

impl RemoteServe {
    pub fn new(port: u16, config: &RemoteConfig, run: TailscaleRunner) -> Self {
        Self {
            target: format!("http://127.0.0.1:{port}"),
            run,
            // Lowercased as RemoteAccess compares it, so what is reported is what is enforced.
            owner: config.owner.as_deref().map(|owner| owner.trim().to_lowercase()).filter(|owner| !owner.is_empty()),
            guests: config.guests,
            app: config.apps.first().cloned(),
            operator_problem: Mutex::new(None),
        }
    }

    pub fn status(&self) -> RemoteStatus {
        self.inspect().status
    }

    /// Turn the exposure on over HTTPS, clearing a plain-HTTP entry an earlier
    /// version left. Without certificates nothing is written and the problem
    /// says how to get them.
    pub fn enable(&self) -> RemoteStatus {
        let Inspection { status, certs, http } = self.inspect();
        if status.state == "unavailable" {
            return status;
        }
        if http && let Some(problem) = self.change(&["serve", HTTP, "off"]) {
            return RemoteStatus { problem: Some(problem), ..status };
        }
        if !certs {
            let problem = self.operator_problem.lock().unwrap().clone().unwrap_or_else(https_required);
            return RemoteStatus { problem: Some(problem), ..self.status() };
        }
        match self.change(&["serve", "--bg", HTTPS, &self.target]) {
            Some(problem) => RemoteStatus { problem: Some(problem), ..status },
            None => self.status(),
        }
    }

    /// Turn off each listener Ghost has on, the plain-HTTP one an earlier version wrote included.
    pub fn disable(&self) -> RemoteStatus {
        let Inspection { status, http, .. } = self.inspect();
        let listeners: Vec<&str> = [(status.state == "on").then_some(HTTPS), http.then_some(HTTP)].into_iter().flatten().collect();
        if listeners.is_empty() {
            return status;
        }
        for listener in listeners {
            if let Some(problem) = self.change(&["serve", listener, "off"]) {
                return RemoteStatus { problem: Some(problem), ..status };
            }
        }
        self.status()
    }

    /// The owner's other tailnet machines: nodes signed in as the owner's
    /// login, which excludes this one and tagged nodes. Whether one runs Ghost
    /// is the app's probe to find out.
    pub fn machines(&self) -> Result<Value, GhostError> {
        let node = read_tailscale_node(&self.run).map_err(|error| {
            GhostError::new("tailscale_unavailable", format!("Tailscale did not answer: {}", first_line(&error.to_string())), 503)
        })?;
        let owner = self.owner.clone().or_else(|| node.login.as_deref().map(str::to_lowercase));
        let machines: Vec<Value> = node
            .peers
            .iter()
            .filter(|peer| owner.is_some() && peer.login.as_deref().map(str::to_lowercase) == owner)
            .map(|peer| json!({ "hostname": peer.hostname, "online": peer.online }))
            .collect();
        Ok(Value::Array(machines))
    }

    /// The app's deep link to one conversation on this machine,
    /// `<origin>/#/<hostname>/<id>`, None while there is no app link.
    pub fn conversation_url(&self, id: &str) -> Option<String> {
        let status = self.status();
        let (origin, url) = status.app?;
        url?;
        Some(format!("{origin}/#/{}/{}", percent_encode(&status.hostname?), percent_encode(id)))
    }

    fn inspect(&self) -> Inspection {
        let off = RemoteStatus {
            state: "off",
            hostname: None,
            guests: self.guests,
            owner: self.owner.clone(),
            app: self.app.clone().map(|origin| (origin, None)),
            problem: None,
        };
        let unavailable = |status: RemoteStatus, problem: RemoteProblem| Inspection {
            status: RemoteStatus { state: "unavailable", problem: Some(problem), ..status },
            certs: false,
            http: false,
        };
        let node = match read_tailscale_node(&self.run) {
            Ok(node) => node,
            Err(CommandFailure::Missing) => return unavailable(off, tailscale_missing()),
            Err(error) => return unavailable(off, RemoteProblem::new("tailscale_stopped", first_line(&error.to_string()), None)),
        };
        let known = RemoteStatus {
            hostname: node.hostname.clone(),
            owner: self.owner.clone().or_else(|| node.login.as_deref().map(str::to_lowercase)),
            ..off
        };
        if node.backend_state == "NeedsLogin" || node.hostname.is_none() {
            return unavailable(known, RemoteProblem::new("not_logged_in", "This machine is not logged in to Tailscale.", Some("tailscale up")));
        }
        if node.backend_state != "Running" {
            return unavailable(known, RemoteProblem::new("tailscale_stopped", "Tailscale is not running.", None));
        }
        let failed = |status: RemoteStatus, message: String| Inspection {
            status: RemoteStatus { problem: Some(serve_failed(message)), ..status },
            certs: node.certs,
            http: false,
        };
        let result = match (self.run)(&["serve", "status", "--json"]) {
            Ok(result) => result,
            Err(error) => return failed(known, first_line(&error.to_string())),
        };
        if result.code != 0 {
            return failed(known, detail(&result));
        }
        let (https, http) = match serde_json::from_str::<Value>(&result.stdout) {
            Ok(config) => served_listeners(&config, &self.target),
            Err(error) => return failed(known, format!("tailscale serve status returned invalid JSON: {error}")),
        };
        let link = https.then(|| format!("{}/#add={}", self.app.clone().unwrap_or_default(), node.hostname.clone().unwrap_or_default()));
        Inspection {
            status: RemoteStatus {
                state: if https { "on" } else { "off" },
                app: known.app.clone().map(|(origin, _)| (origin, link)),
                problem: self.operator_problem.lock().unwrap().clone(),
                ..known
            },
            certs: node.certs,
            http,
        }
    }

    /// Ask Tailscale for one Serve change; a refusal is returned, and remembered when it is the operator right.
    fn change(&self, args: &[&str]) -> Option<RemoteProblem> {
        let result = match (self.run)(args) {
            Ok(result) => result,
            Err(CommandFailure::Missing) => return Some(tailscale_missing()),
            Err(error) => return Some(serve_failed(first_line(&error.to_string()))),
        };
        let mut remembered = self.operator_problem.lock().unwrap();
        if result.code != 0 {
            let message = detail(&result);
            let operator = format!("{}\n{}", result.stderr, result.stdout).to_lowercase().contains("operator");
            *remembered = operator.then(|| RemoteProblem::new("operator_required", message.clone(), Some(OPERATOR_ACTION)));
            return Some(remembered.clone().unwrap_or_else(|| serve_failed(message)));
        }
        *remembered = None;
        None
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
