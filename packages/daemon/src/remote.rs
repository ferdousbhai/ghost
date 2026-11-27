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
//! And what the owner serves. Turning Serve on and off is Tailscale's own
//! command, which the owner or the ghost runs (`tailscale serve --bg
//! --https=443 http://127.0.0.1:<port>`); Ghost writes no Serve entry. It
//! only reads whether one proxies to this daemon over HTTPS, since the app is
//! an https page and cannot call an http address: that is what links the app
//! to this machine and names the machine in an alert's link.
use crate::abort::Abort;
use crate::config::RemoteConfig;
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

/// The owner, calling through Tailscale Serve: no one else is admitted.
#[derive(Clone, Debug, PartialEq)]
pub struct TailscaleIdentity {
    pub login: String,
}

type SelfLogin = Box<dyn Fn() -> Option<String> + Send + Sync>;

pub struct RemoteAccess {
    self_login: SelfLogin,
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
        Self { self_login, configured_owner, owner: Mutex::new(None) }
    }

    /// The owner's tailnet identity, when a proxied request carries it; None for anyone else.
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
        (self.owner_login().as_deref() == Some(login.as_str())).then_some(TailscaleIdentity { login })
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
    pub owner: Option<String>,
    /// The first of `remote.apps`, and its link adding this machine
    /// (`<origin>/#add=<hostname>`), None while Serve is off.
    pub app: Option<(String, Option<String>)>,
    /// Tailscale's command that turns Serve on for this daemon.
    pub command: String,
    pub problem: Option<RemoteProblem>,
}

impl RemoteStatus {
    pub fn to_json(&self) -> Value {
        json!({
            "state": self.state,
            "hostname": self.hostname,
            "owner": self.owner,
            "app": self.app.as_ref().map(|(origin, url)| json!({ "origin": origin, "url": url })),
            "command": self.command,
            "problem": self.problem.as_ref().map(RemoteProblem::to_json),
        })
    }
}

fn tailscale_missing() -> RemoteProblem {
    RemoteProblem::new("tailscale_missing", "Tailscale is not installed.", Some("omarchy-install-service-tailscale"))
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

/// Whether Serve proxies HTTPS on port 443 to `target`, from `tailscale serve
/// status --json`, whose `Web` map is keyed by `host:port`.
fn served_over_https(config: &Value, target: &str) -> bool {
    config["Web"].as_object().into_iter().flatten().any(|(host_port, server)| {
        host_port.ends_with(":443")
            && server["Handlers"].as_object().is_some_and(|handlers| {
                handlers.values().any(|handler| handler["Proxy"].as_str().is_some_and(|proxy| proxy.strip_suffix('/').unwrap_or(proxy) == target))
            })
    })
}

/// What Tailscale Serve exposes of this daemon, read from Tailscale on every call.
pub struct RemoteServe {
    target: String,
    run: TailscaleRunner,
    owner: Option<String>,
    app: Option<String>,
}

impl RemoteServe {
    pub fn new(port: u16, config: &RemoteConfig, run: TailscaleRunner) -> Self {
        Self {
            target: format!("http://127.0.0.1:{port}"),
            run,
            // Lowercased as RemoteAccess compares it, so what is reported is what is enforced.
            owner: config.owner.as_deref().map(|owner| owner.trim().to_lowercase()).filter(|owner| !owner.is_empty()),
            app: config.apps.first().cloned(),
        }
    }

    /// Tailscale's own command that serves this daemon to the tailnet over HTTPS.
    pub fn command(&self) -> String {
        format!("tailscale serve --bg --https=443 {}", self.target)
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

    /// The app's link to this machine's conversation, `<origin>/#/<hostname>`,
    /// None while there is no app link.
    pub fn machine_url(&self) -> Option<String> {
        let status = self.status();
        let (origin, url) = status.app?;
        url?;
        Some(format!("{origin}/#/{}", percent_encode(&status.hostname?)))
    }

    pub fn status(&self) -> RemoteStatus {
        let off = RemoteStatus {
            state: "off",
            hostname: None,
            owner: self.owner.clone(),
            app: self.app.clone().map(|origin| (origin, None)),
            command: self.command(),
            problem: None,
        };
        let unavailable = |status: RemoteStatus, problem: RemoteProblem| RemoteStatus { state: "unavailable", problem: Some(problem), ..status };
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
        let failed = |status: RemoteStatus, message: String| RemoteStatus { problem: Some(serve_failed(message)), ..status };
        let result = match (self.run)(&["serve", "status", "--json"]) {
            Ok(result) => result,
            Err(error) => return failed(known, first_line(&error.to_string())),
        };
        if result.code != 0 {
            return failed(known, detail(&result));
        }
        let https = match serde_json::from_str::<Value>(&result.stdout) {
            Ok(config) => served_over_https(&config, &self.target),
            Err(error) => return failed(known, format!("tailscale serve status returned invalid JSON: {error}")),
        };
        let link = https.then(|| format!("{}/#add={}", self.app.clone().unwrap_or_default(), node.hostname.clone().unwrap_or_default()));
        RemoteStatus { state: if https { "on" } else { "off" }, app: known.app.clone().map(|(origin, _)| (origin, link)), ..known }
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
