//! Which ghost answers on this machine, and the ghosts there are to choose
//! from (CONTRACTS.md "A ghost on another machine"): what `ghost use` and the
//! bar's offer both do. A ghost is asked before it is saved, and found by
//! asking the owner's own machines on the tailnet, only when one of those two
//! asks: nothing here runs in the background, and none of it needs a daemon on
//! this machine.
use crate::client::{CONTROL_TIMEOUT, Client, ClientError};
pub use crate::config::GhostAddress;
use crate::config::{Overrides, load_config, save_ghost, saved_ghost};
use crate::env::Env;
use crate::process::CommandFailure;
use crate::remote::{TailscaleNode, first_line, read_tailscale_node};
pub use crate::remote::{TailscaleRunner, tailscale_runner};
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long one machine has to answer when the tailnet is searched, and how long the search waits for them all.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(4);

/// Why a ghost was not saved, or the tailnet not searched: one sentence, and what kind of failure it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// What was asked for cannot be done as written.
    Usage(String),
    /// Nothing answered at the address.
    Unreachable(String),
    /// A ghost answered and did not take this machine for its owner's.
    Refused(String),
    /// Anything else: not a ghost, one with no model, Tailscale, the config file.
    Failed(String),
}

impl Refusal {
    pub fn message(&self) -> &str {
        match self {
            Self::Usage(message) | Self::Unreachable(message) | Self::Refused(message) | Self::Failed(message) => message,
        }
    }
}

/// Why Tailscale cannot say what machines the owner has.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tailnet {
    Missing,
    SignedOut,
    Stopped,
    Failed(String),
}

impl Tailnet {
    /// The clause a sentence about it starts with.
    pub fn clause(&self) -> String {
        match self {
            Self::Missing => "Tailscale is not installed here".to_string(),
            Self::SignedOut => "Tailscale is not signed in here".to_string(),
            Self::Stopped => "Tailscale is not running here".to_string(),
            Self::Failed(why) => format!("Tailscale did not answer here ({why})"),
        }
    }
}

/// This node as Tailscale has it, once it is signed in and running.
fn tailnet(run: &TailscaleRunner) -> Result<TailscaleNode, Tailnet> {
    let node = match read_tailscale_node(run) {
        Ok(node) => node,
        Err(CommandFailure::Missing) => return Err(Tailnet::Missing),
        Err(error) => return Err(Tailnet::Failed(first_line(&error.to_string()))),
    };
    match node.backend_state.as_str() {
        "Running" if node.hostname.is_some() => Ok(node),
        "NeedsLogin" | "Running" => Err(Tailnet::SignedOut),
        _ => Err(Tailnet::Stopped),
    }
}

/// What `ghost use <machine>` names: `local` and this machine's own name are
/// this machine's ghost (None); an address is itself; a short machine name is
/// that machine's full MagicDNS name, as `tailscale status` has it.
pub fn resolve(machine: &str, run: &TailscaleRunner) -> Result<Option<GhostAddress>, Refusal> {
    let machine = machine.trim();
    if machine.eq_ignore_ascii_case("local") {
        return Ok(None);
    }
    if machine.contains(['.', ':', '/']) {
        return GhostAddress::parse(machine).map(Some).ok_or_else(|| {
            Refusal::Usage(format!(
                "\"{machine}\" is not a machine's address: give its name on your tailnet, or an address like machine.tailnet.ts.net or https://machine.tailnet.ts.net."
            ))
        });
    }
    let node = tailnet(run).map_err(|problem| {
        Refusal::Failed(format!(
            "{}, so \"{machine}\" cannot be looked up: give the machine's full address (`ghost use {machine}.<tailnet>.ts.net`).",
            problem.clause()
        ))
    })?;
    let named = |hostname: &str| GhostAddress::parse(hostname).filter(|address| address.machine().eq_ignore_ascii_case(machine));
    if node.hostname.as_deref().and_then(named).is_some() {
        return Ok(None);
    }
    node.peers
        .iter()
        .find_map(|peer| named(&peer.hostname))
        .map(Some)
        .ok_or_else(|| Refusal::Failed(format!("No machine on your tailnet is named \"{machine}\" (`tailscale status` lists them).")))
}

/// What asking an address for its ghost came to.
enum Probe {
    Answers,
    NoModel,
    Refused,
    NotAGhost,
    Unreachable(String),
}

/// Ask for the ghost (`GET /api/ghost`): it is one when it names itself, and
/// it admits the caller by answering at all. One that says it has no model
/// answers no turn.
fn probe(client: &mut Client, timeout: Duration) -> Probe {
    match client.request("GET", "/api/ghost", None, Some(timeout)) {
        Ok(ghost) if ghost["name"].is_string() && ghost["model"] == false => Probe::NoModel,
        Ok(ghost) if ghost["name"].is_string() => Probe::Answers,
        Err(ClientError::Refused { .. } | ClientError::Unauthorized { .. }) => Probe::Refused,
        Err(ClientError::UnreachableAt { why, .. } | ClientError::Unreachable(why)) => Probe::Unreachable(why),
        Ok(_) | Err(_) => Probe::NotAGhost,
    }
}

/// Say which ghost answers on this machine: the one at `address`, or this
/// machine's own (None). Another machine's is asked first, and saved only if a
/// ghost answers there, takes this machine for its owner's, and has a model;
/// otherwise nothing is written and the sentence says which of those failed.
/// Returns the sentence that says what answers now.
pub fn use_ghost(env: &Env, home: &Path, address: Option<&GhostAddress>) -> Result<String, Refusal> {
    let saved = |()| match address {
        Some(address) => format!("The ghost on {} answers here now.", address.machine()),
        None => "This machine's own ghost answers here now.".to_string(),
    };
    if let Some(address) = address {
        let (origin, machine) = (address.origin(), address.machine());
        match probe(&mut Client::at(env, home, address.clone()), CONTROL_TIMEOUT) {
            Probe::Answers => {}
            Probe::Unreachable(why) => {
                return Err(Refusal::Unreachable(format!(
                    "No ghost answers at {origin} ({why}), so nothing was saved: that machine must be on, with Tailscale Serve on for its ghost (`ghost status` there says how)."
                )));
            }
            Probe::Refused => {
                return Err(Refusal::Refused(format!(
                    "The ghost at {origin} does not take this machine for its owner's, so nothing was saved: sign this machine in to the Tailscale account that machine is on."
                )));
            }
            Probe::NotAGhost => {
                return Err(Refusal::Failed(format!(
                    "What answers at {origin} is not a ghost, so nothing was saved: Tailscale Serve there must pass port 443 to ghostd (`ghost status` there says how)."
                )));
            }
            Probe::NoModel => {
                return Err(Refusal::Failed(format!(
                    "The ghost on {machine} has no model to answer with, so nothing was saved: set `local.model` in ~/.config/ghost/config.json there."
                )));
            }
        }
    }
    save_ghost(env, home, address).map(saved).map_err(|error| Refusal::Failed(format!("Nothing was saved: {error}")))
}

/// A ghost that answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ghost {
    /// What its machine is called.
    pub machine: String,
    /// Where it is; None for this machine's own.
    pub address: Option<GhostAddress>,
    /// The one the config says answers here.
    pub in_use: bool,
}

/// The ghosts that answer, this machine's own first, and where the config says the ghost is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub ghosts: Vec<Ghost>,
    /// The saved address; None is this machine's own ghost.
    pub in_use: Option<GhostAddress>,
}

/// Why the ghosts cannot be listed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotFound {
    Tailnet(Tailnet),
    /// The config file cannot be used as it is.
    Config(String),
}

/// A machine that could not hold a ghost: Tailscale's name for a phone's or a television's system.
fn handheld(os: &str) -> bool {
    ["ios", "android", "tvos"].iter().any(|system| os.eq_ignore_ascii_case(system))
}

/// Look for ghosts: this machine's own daemon, and every other machine of the
/// owner's that is online on the tailnet (phones left out, and tagged nodes,
/// which are no login's), each asked at once and given `PROBE_TIMEOUT` to
/// answer. Those listed answer, take the caller for their owner, and have a
/// model.
pub fn find(env: &Env, home: &Path, run: &TailscaleRunner) -> Result<Found, NotFound> {
    let in_use = saved_ghost(env, home).map_err(NotFound::Config)?;
    let node = tailnet(run).map_err(NotFound::Tailnet)?;
    let own = node.hostname.as_deref().and_then(GhostAddress::parse).map(|address| address.machine().to_string());
    let mut asked: Vec<(Option<GhostAddress>, String)> = vec![(None, own.unwrap_or_else(|| "this machine".to_string()))];
    for peer in &node.peers {
        if !peer.online || handheld(&peer.os) || node.login.is_none() || peer.login != node.login {
            continue;
        }
        if let Some(address) = GhostAddress::parse(&peer.hostname) {
            asked.push((Some(address.clone()), address.machine().to_string()));
        }
    }
    let (answers, answered) = mpsc::channel();
    for (index, (address, _)) in asked.iter().enumerate() {
        let (answers, env, home, address) = (answers.clone(), env.clone(), home.to_path_buf(), address.clone());
        std::thread::spawn(move || {
            let client = match address {
                Some(address) => Ok(Client::at(&env, &home, address)),
                None => Client::local(&env, &home),
            };
            let answers_there = client.is_ok_and(|mut client| matches!(probe(&mut client, PROBE_TIMEOUT), Probe::Answers));
            let _ = answers.send((index, answers_there));
        });
    }
    drop(answers);
    // A machine that has not answered by the deadline is not waited for: its thread ends by its own timeout.
    let deadline = Instant::now() + SEARCH_TIMEOUT;
    let mut there = vec![false; asked.len()];
    while let Ok((index, answers_there)) = answered.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        there[index] = answers_there;
    }
    let mut ghosts: Vec<Ghost> = asked
        .into_iter()
        .zip(there)
        .filter(|(_, answers_there)| *answers_there)
        .map(|((address, machine), _)| Ghost { in_use: address == in_use, machine, address })
        .collect();
    // This machine's own stays first; the others are in the order of their names.
    ghosts.sort_by(|a, b| (a.address.is_some(), &a.machine).cmp(&(b.address.is_some(), &b.machine)));
    Ok(Found { ghosts, in_use })
}

/// Whether this machine has nothing of its own to ask: no address of another's
/// ghost is set and no local model is configured, so nothing here could answer
/// a turn, whether or not its daemon runs. False while the config cannot be
/// read, which is its own error.
pub fn wanting(env: &Env, home: &Path) -> bool {
    load_config(&Overrides::default(), env, home).is_ok_and(|config| config.ghost.is_none() && config.local.is_none())
}

/// The ghosts on the owner's other machines, which the bar offers a machine
/// that is `wanting`; or why they cannot be looked for.
pub fn others(env: &Env, home: &Path, run: &TailscaleRunner) -> Result<Vec<Ghost>, Tailnet> {
    match find(env, home, run) {
        Ok(found) => Ok(found.ghosts.into_iter().filter(|ghost| ghost.address.is_some()).collect()),
        Err(NotFound::Tailnet(problem)) => Err(problem),
        Err(NotFound::Config(_)) => Ok(Vec::new()),
    }
}

#[cfg(test)]
#[path = "ghosts_tests.rs"]
pub(crate) mod tests;
