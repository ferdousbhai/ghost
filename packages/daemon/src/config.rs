//! A missing config file is not an error; a malformed one is. Falling back to
//! defaults would silently move the owner's ghost instead of telling them.
use crate::env::{Env, var};
use crate::xdg::{Base, base_dir, expand_home, resolve};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The web apps admitted to call this daemon with a tailnet identity (CONTRACTS.md "Daemon HTTP API").
pub const DEFAULT_REMOTE_APPS: &[&str] = &["https://summonghost.com"];
pub const DEFAULT_PORT: u16 = 7717;
pub const DEFAULT_LOCAL_CONTEXT: u64 = 32_768;
pub const DEFAULT_LOCAL_IDLE_MINUTES: u64 = 5;
/// A model's own default can be its deepest: Inkling 2 Mini's took six minutes over three commands.
pub const DEFAULT_LOCAL_REASONING_EFFORT: &str = "low";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Guests {
    #[default]
    None,
    ReadOnly,
}

impl Guests {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ReadOnly => "read-only",
        }
    }
}

/// Who may reach the daemon through `tailscale serve`: `owner` is the login
/// that owns the ghost (default: the login this node belongs to), `guests`
/// says what other tailnet members may do, `apps` the web app origins
/// admitted with a tailnet identity (`[]` admits none).
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteConfig {
    pub owner: Option<String>,
    pub guests: Guests,
    pub apps: Vec<String>,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self { owner: None, guests: Guests::None, apps: DEFAULT_REMOTE_APPS.iter().map(|app| app.to_string()).collect() }
    }
}

/// The model ghostd runs itself (CONTRACTS.md "Local model").
#[derive(Clone, Debug, PartialEq)]
pub struct LocalModelConfig {
    /// The GGUF file, used in place.
    pub model: PathBuf,
    /// The llama-server executable.
    pub server: String,
    pub context_size: u64,
    /// Unused this long, the server stops and its memory returns.
    pub idle_ms: u64,
    /// How deeply the model reasons before it answers, as its chat template names the depths.
    pub reasoning_effort: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DaemonConfig {
    pub port: u16,
    pub ghosts_root: PathBuf,
    pub remote: RemoteConfig,
    /// The config file read; it need not exist.
    pub config_path: PathBuf,
    pub hooks_path: PathBuf,
    pub local: Option<LocalModelConfig>,
}

#[derive(Default, Clone, Debug)]
pub struct Overrides {
    pub port: Option<u16>,
    pub ghosts_root: Option<String>,
    pub config_path: Option<PathBuf>,
}

pub fn default_config_path(env: &Env, home: &Path) -> PathBuf {
    base_dir(env, Base::Config, home).join("ghost").join("config.json")
}

fn parse_port(raw: &str, source: &str) -> Result<u16, String> {
    raw.parse::<u16>().map_err(|_| format!("Invalid port from {source}: {}", Value::String(raw.to_string())))
}

/// An `https://host[:port]` origin exactly as a browser sends it, or None.
fn app_origin(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let authority = text.strip_prefix("https://")?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    let host_ok = !host.is_empty()
        && host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !host.starts_with(['.', '-'])
        && !host.ends_with(['.', '-']);
    // A browser's origin leaves the default port out and writes no leading zero.
    let port_ok = port.is_none_or(|port| port.parse::<u16>().is_ok_and(|n| n != 443 && n.to_string() == port));
    (host_ok && port_ok).then(|| text.to_string())
}

/// `local`: `{ model, server?, contextSize?, idleMinutes?, reasoningEffort? }`, paths `~`-expanded.
fn parse_local(raw: &Value, path: &str, home: &Path) -> Result<LocalModelConfig, String> {
    let object = raw.as_object().ok_or_else(|| format!("{path}: \"local\" must be a JSON object."))?;
    let text = |key: &str| object.get(key).map(|value| value.as_str().map(str::trim).filter(|text| !text.is_empty()));
    let model = text("model").flatten().ok_or_else(|| format!("{path}: \"local.model\" must be the path of a GGUF file."))?;
    let server = match text("server") {
        None => "llama-server".to_string(),
        Some(Some(server)) => expand_home(server, home).to_string_lossy().into_owned(),
        Some(None) => return Err(format!("{path}: \"local.server\" must be the llama-server executable.")),
    };
    let reasoning_effort = match text("reasoningEffort") {
        None => DEFAULT_LOCAL_REASONING_EFFORT.to_string(),
        Some(Some(effort)) => effort.to_string(),
        Some(None) => return Err(format!("{path}: \"local.reasoningEffort\" must be a reasoning depth the model names, such as \"low\".")),
    };
    let positive = |key: &str, fallback: u64| match object.get(key) {
        None => Ok(fallback),
        Some(value) => value.as_u64().filter(|n| *n >= 1).ok_or_else(|| format!("{path}: \"local.{key}\" must be a positive whole number.")),
    };
    Ok(LocalModelConfig {
        model: resolve(home, &expand_home(model, home)),
        server,
        context_size: positive("contextSize", DEFAULT_LOCAL_CONTEXT)?,
        idle_ms: positive("idleMinutes", DEFAULT_LOCAL_IDLE_MINUTES)? * 60_000,
        reasoning_effort,
    })
}

#[derive(Default)]
struct ConfigFile {
    port: Option<u16>,
    ghosts_root: Option<String>,
    owner: Option<String>,
    guests: Option<Guests>,
    apps: Option<Vec<String>>,
    local: Option<LocalModelConfig>,
}

fn read_config_file(path: &Path, home: &Path) -> Result<Option<ConfigFile>, String> {
    let shown = path.display().to_string();
    let Some(text) = crate::private_file::read_text(path).map_err(|error| format!("Cannot read {shown}: {error}"))? else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&text).map_err(|error| format!("{shown} is not valid JSON: {error}"))?;
    let file = parsed.as_object().ok_or_else(|| format!("{shown} must contain a JSON object."))?;
    let mut config = ConfigFile::default();
    if let Some(port) = file.get("port") {
        if !port.is_number() {
            return Err(format!("{shown}: \"port\" must be a number."));
        }
        config.port = Some(parse_port(&port.to_string(), &shown)?);
    }
    if let Some(root) = file.get("ghostsRoot") {
        config.ghosts_root = Some(root.as_str().ok_or_else(|| format!("{shown}: \"ghostsRoot\" must be a string."))?.to_string());
    }
    if let Some(remote) = file.get("remote") {
        let remote = remote.as_object().ok_or_else(|| format!("{shown}: \"remote\" must be a JSON object."))?;
        if let Some(owner) = remote.get("owner") {
            let owner =
                owner.as_str().filter(|owner| !owner.trim().is_empty()).ok_or_else(|| format!("{shown}: \"remote.owner\" must be a login."))?;
            config.owner = Some(owner.to_string());
        }
        if let Some(guests) = remote.get("guests") {
            config.guests = Some(match guests.as_str() {
                Some("read-only") => Guests::ReadOnly,
                Some("none") => Guests::None,
                _ => return Err(format!("{shown}: \"remote.guests\" must be \"read-only\" or \"none\".")),
            });
        }
        if let Some(apps) = remote.get("apps") {
            let origins: Option<Vec<String>> = apps.as_array().and_then(|apps| apps.iter().map(app_origin).collect());
            config.apps =
                Some(origins.ok_or_else(|| format!("{shown}: \"remote.apps\" must be a list of origins like \"https://summonghost.com\"."))?);
        }
    }
    if let Some(local) = file.get("local") {
        config.local = Some(parse_local(local, &shown, home)?);
    }
    Ok(Some(config))
}

pub fn load_config(overrides: &Overrides, env: &Env, home: &Path) -> Result<DaemonConfig, String> {
    let config_path =
        overrides.config_path.clone().or_else(|| var(env, "GHOSTD_CONFIG").map(PathBuf::from)).unwrap_or_else(|| default_config_path(env, home));
    let file = read_config_file(&config_path, home)?.unwrap_or_default();
    let env_port = var(env, "GHOSTD_PORT").map(|raw| parse_port(raw, "GHOSTD_PORT")).transpose()?;
    let port = overrides.port.or(env_port).or(file.port).unwrap_or(DEFAULT_PORT);
    let raw_root = overrides
        .ghosts_root
        .clone()
        .or_else(|| var(env, "GHOSTS_ROOT").map(str::to_string))
        .or(file.ghosts_root)
        .unwrap_or_else(|| home.join("ghosts").to_string_lossy().into_owned());
    let hooks = match var(env, "GHOSTD_HOOKS") {
        Some(path) => expand_home(path, home),
        None => config_path.parent().unwrap_or(Path::new("/")).join("hooks.json"),
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    Ok(DaemonConfig {
        port,
        ghosts_root: resolve(&cwd, &expand_home(&raw_root, home)),
        remote: RemoteConfig {
            owner: file.owner,
            guests: file.guests.unwrap_or_default(),
            apps: file.apps.unwrap_or_else(|| RemoteConfig::default().apps),
        },
        hooks_path: resolve(&cwd, &hooks),
        config_path,
        local: file.local,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(config: Option<Value>) -> (PathBuf, Env) {
        let dir = std::env::temp_dir().join(format!("ghost-config-{}", crate::random::uuid()));
        std::fs::create_dir_all(dir.join(".config/ghost")).unwrap();
        if let Some(config) = config {
            std::fs::write(dir.join(".config/ghost/config.json"), config.to_string()).unwrap();
        }
        (dir, Env::new())
    }

    fn load(dir: &Path, env: &Env) -> Result<DaemonConfig, String> {
        load_config(&Overrides::default(), env, dir)
    }

    #[test]
    fn defaults_without_a_file() {
        let (dir, env) = scratch(None);
        let config = load(&dir, &env).unwrap();
        assert_eq!(config.port, 7717);
        assert_eq!(config.ghosts_root, dir.join("ghosts"));
        assert_eq!(config.hooks_path, dir.join(".config/ghost/hooks.json"));
        assert_eq!(config.remote, RemoteConfig::default());
        assert_eq!(config.local, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn flags_beat_the_environment_which_beats_the_file() {
        let (dir, mut env) = scratch(Some(json!({ "port": 7001, "ghostsRoot": "~/a", "host": "0.0.0.0" })));
        assert_eq!(load(&dir, &env).unwrap().port, 7001);
        assert_eq!(load(&dir, &env).unwrap().ghosts_root, dir.join("a"));
        env.insert("GHOSTD_PORT".into(), "7002".into());
        env.insert("GHOSTS_ROOT".into(), "/b".into());
        env.insert("GHOSTD_HOOKS".into(), "~/h.json".into());
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.port, config.ghosts_root.clone(), config.hooks_path.clone()), (7002, PathBuf::from("/b"), dir.join("h.json")));
        let flagged = load_config(&Overrides { port: Some(7003), ghosts_root: Some("/c".into()), config_path: None }, &env, &dir).unwrap();
        assert_eq!((flagged.port, flagged.ghosts_root), (7003, PathBuf::from("/c")));
        env.insert("GHOSTD_PORT".into(), "70000".into());
        assert!(load(&dir, &env).unwrap_err().contains("Invalid port from GHOSTD_PORT"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_and_local_are_validated() {
        let (dir, env) = scratch(Some(json!({
            "remote": { "owner": "Me@Example.com", "guests": "read-only", "apps": ["https://a.example", "https://b.example:8443"] },
            "local": { "model": "~/m.gguf", "idleMinutes": 2 },
        })));
        let config = load(&dir, &env).unwrap();
        assert_eq!(config.remote.guests, Guests::ReadOnly);
        assert_eq!(config.remote.apps, ["https://a.example", "https://b.example:8443"]);
        let local = config.local.unwrap();
        assert_eq!(
            (local.model, local.server.as_str(), local.context_size, local.idle_ms, local.reasoning_effort.as_str()),
            (dir.join("m.gguf"), "llama-server", 32_768, 120_000, "low")
        );
        for (bad, says) in [
            (json!({ "remote": { "apps": ["http://a.example"] } }), "remote.apps"),
            (json!({ "remote": { "apps": ["https://a.example/"] } }), "remote.apps"),
            (json!({ "remote": { "apps": "https://a.example" } }), "remote.apps"),
            (json!({ "remote": { "guests": "all" } }), "remote.guests"),
            (json!({ "remote": { "owner": " " } }), "remote.owner"),
            (json!({ "local": {} }), "local.model"),
            (json!({ "local": { "model": "m", "contextSize": 0 } }), "local.contextSize"),
            (json!({ "local": { "model": "m", "server": "" } }), "local.server"),
            (json!({ "port": "7717" }), "\"port\" must be a number"),
            (json!([]), "must contain a JSON object"),
        ] {
            std::fs::write(dir.join(".config/ghost/config.json"), bad.to_string()).unwrap();
            assert!(load(&dir, &env).unwrap_err().contains(says), "{bad}");
        }
        std::fs::write(dir.join(".config/ghost/config.json"), "{").unwrap();
        assert!(load(&dir, &env).unwrap_err().contains("is not valid JSON"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
