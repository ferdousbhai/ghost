//! A missing config file is not an error; a malformed one is, and so is a key
//! ghostd does not read. Falling back to defaults would silently move the
//! owner's ghost instead of telling them.
use crate::env::{Env, var};
use crate::xdg::{Base, base_dir, expand_home, resolve};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The web apps admitted to call this daemon with a tailnet identity (CONTRACTS.md "Daemon HTTP API").
const DEFAULT_REMOTE_APPS: &[&str] = &["https://summonghost.com"];
pub const DEFAULT_PORT: u16 = 7717;
pub const DEFAULT_LOCAL_CONTEXT: u64 = 32_768;
const DEFAULT_LOCAL_IDLE_MINUTES: u64 = 5;
/// A model's own default can be its deepest: Inkling 2 Mini's took six minutes over three commands.
const DEFAULT_LOCAL_REASONING_EFFORT: &str = "low";

/// Who may reach the daemon through `tailscale serve`: `owner` is the login
/// that owns the ghost (default: the login this node belongs to), the only
/// one admitted, as logins are compared (`normalise_login`); `apps` the web
/// app origins admitted with a tailnet identity (`[]` admits none).
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteConfig {
    pub owner: Option<String>,
    pub apps: Vec<String>,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self { owner: None, apps: DEFAULT_REMOTE_APPS.iter().map(|app| app.to_string()).collect() }
    }
}

/// A ghost on another machine, as this machine's `ghost` command and bar reach
/// it: its Tailscale Serve address (CONTRACTS.md "A ghost on another machine").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GhostAddress {
    pub tls: bool,
    pub host: String,
    pub port: u16,
}

impl GhostAddress {
    /// A host name, which is `https://` on 443, or an `https://host[:port]` or `http://host[:port]` origin.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim().to_ascii_lowercase();
        let (tls, authority) = match (text.strip_prefix("https://"), text.strip_prefix("http://")) {
            (Some(authority), _) => (true, authority),
            (_, Some(authority)) => (false, authority),
            _ => (true, text.as_str()),
        };
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => (host, port.parse::<u16>().ok().filter(|port| *port != 0)?),
            None => (authority, if tls { 443 } else { 80 }),
        };
        host_ok(host).then(|| Self { tls, host: host.to_string(), port })
    }

    /// `https://host`, with the port when it is not the scheme's own.
    pub fn origin(&self) -> String {
        let (scheme, default) = if self.tls { ("https", 443) } else { ("http", 80) };
        if self.port == default { format!("{scheme}://{}", self.host) } else { format!("{scheme}://{}:{}", self.host, self.port) }
    }

    /// As the config's `ghost` holds it: the host name alone when that says it all, else the origin.
    pub fn written(&self) -> String {
        if self.tls && self.port == 443 { self.host.clone() } else { self.origin() }
    }

    /// What the machine is called: the first label of its name, or the whole of a numeric address.
    pub fn machine(&self) -> &str {
        if self.host.parse::<std::net::IpAddr>().is_ok() {
            return &self.host;
        }
        self.host.split('.').next().unwrap_or(&self.host)
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
    /// The ghost home.
    pub home: PathBuf,
    pub remote: RemoteConfig,
    /// The config file read; it need not exist.
    pub config_path: PathBuf,
    pub hooks_path: PathBuf,
    pub local: Option<LocalModelConfig>,
    /// Where the `ghost` command and the bar find the ghost when it is not
    /// this machine's: `$GHOST_AT`, else the file's `ghost`. ghostd reads
    /// neither.
    pub ghost: Option<GhostAddress>,
}

#[derive(Default, Clone, Debug)]
pub struct Overrides {
    pub port: Option<u16>,
    pub home: Option<String>,
    pub config_path: Option<PathBuf>,
}

/// `$XDG_DATA_HOME/ghost`, else `~/.local/share/ghost`.
fn default_ghost_home(env: &Env, home: &Path) -> PathBuf {
    base_dir(env, Base::Data, home).join("ghost")
}

fn default_config_path(env: &Env, home: &Path) -> PathBuf {
    base_dir(env, Base::Config, home).join("ghost").join("config.json")
}

/// A tailnet login as it is compared: without the space around it or its case; None when nothing is left.
pub fn normalise_login(login: &str) -> Option<String> {
    Some(login.trim().to_lowercase()).filter(|login| !login.is_empty())
}

/// Refuse, by name, the keys of `object` that ghostd does not read; `within` is the path to it (`remote.`).
fn only_keys(object: &serde_json::Map<String, Value>, known: &[&str], within: &str, path: &str) -> Result<(), String> {
    let unknown: Vec<String> = object.keys().filter(|key| !known.contains(&key.as_str())).map(|key| format!("\"{within}{key}\"")).collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let known: Vec<String> = known.iter().map(|key| format!("\"{within}{key}\"")).collect();
    Err(format!("{path}: unknown {}; the keys are {}.", unknown.join(", "), known.join(", ")))
}

/// A host name in lowercase, or a numeric IPv4 address.
fn host_ok(host: &str) -> bool {
    !host.is_empty()
        && host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !host.starts_with(['.', '-'])
        && !host.ends_with(['.', '-'])
}

/// An `https://host[:port]` origin exactly as a browser sends it, or None.
fn app_origin(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let authority = text.strip_prefix("https://")?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    // A browser's origin leaves the default port out and writes no leading zero.
    let port_ok = port.is_none_or(|port| port.parse::<u16>().is_ok_and(|n| n != 443 && n.to_string() == port));
    (host_ok(host) && port_ok).then(|| text.to_string())
}

/// `local`: `{ model, server?, contextSize?, idleMinutes?, reasoningEffort? }`, paths `~`-expanded.
fn parse_local(raw: &Value, path: &str, home: &Path) -> Result<LocalModelConfig, String> {
    let object = raw.as_object().ok_or_else(|| format!("{path}: \"local\" must be a JSON object."))?;
    only_keys(object, &["model", "server", "contextSize", "idleMinutes", "reasoningEffort"], "local.", path)?;
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
        model: resolve(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")), &expand_home(model, home)),
        server,
        context_size: positive("contextSize", DEFAULT_LOCAL_CONTEXT)?,
        idle_ms: positive("idleMinutes", DEFAULT_LOCAL_IDLE_MINUTES)? * 60_000,
        reasoning_effort,
    })
}

#[derive(Default)]
struct ConfigFile {
    port: Option<u16>,
    home: Option<String>,
    owner: Option<String>,
    apps: Option<Vec<String>>,
    local: Option<LocalModelConfig>,
    ghost: Option<GhostAddress>,
}

fn read_config_file(path: &Path, home: &Path) -> Result<Option<ConfigFile>, String> {
    let shown = path.display().to_string();
    let Some(text) = crate::private_file::read_text(path).map_err(|error| format!("Cannot read {shown}: {error}"))? else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&text).map_err(|error| format!("{shown} is not valid JSON: {error}"))?;
    let file = parsed.as_object().ok_or_else(|| format!("{shown} must contain a JSON object."))?;
    only_keys(file, &["port", "home", "remote", "local", "ghost"], "", &shown)?;
    let mut config = ConfigFile::default();
    if let Some(port) = file.get("port") {
        let port = port.as_u64().and_then(|port| u16::try_from(port).ok());
        config.port = Some(port.ok_or_else(|| format!("{shown}: \"port\" must be a whole number from 0 to 65535."))?);
    }
    if let Some(dir) = file.get("home") {
        config.home = Some(dir.as_str().ok_or_else(|| format!("{shown}: \"home\" must be a string."))?.to_string());
    }
    if let Some(remote) = file.get("remote") {
        let remote = remote.as_object().ok_or_else(|| format!("{shown}: \"remote\" must be a JSON object."))?;
        only_keys(remote, &["owner", "apps"], "remote.", &shown)?;
        if let Some(owner) = remote.get("owner") {
            let owner = owner.as_str().and_then(normalise_login);
            config.owner = Some(owner.ok_or_else(|| format!("{shown}: \"remote.owner\" must be a login."))?);
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
    if let Some(ghost) = file.get("ghost") {
        let address = ghost.as_str().and_then(GhostAddress::parse);
        config.ghost = Some(address.ok_or_else(|| {
            format!("{shown}: \"ghost\" must be another machine's address like \"machine.tailnet.ts.net\" or \"https://machine.tailnet.ts.net\".")
        })?);
    }
    Ok(Some(config))
}

/// The config file: `$GHOSTD_CONFIG`, else the XDG one.
fn config_path(env: &Env, home: &Path) -> PathBuf {
    var(env, "GHOSTD_CONFIG").map(|path| expand_home(path, home)).unwrap_or_else(|| default_config_path(env, home))
}

/// The file's own `ghost`: what `ghost use` saved, whatever `$GHOST_AT` says for one command.
pub fn saved_ghost(env: &Env, home: &Path) -> Result<Option<GhostAddress>, String> {
    Ok(read_config_file(&config_path(env, home), home)?.and_then(|file| file.ghost))
}

/// Set the file's `ghost` to `address`, or remove it (None: this machine's own ghost), keeping every other key.
/// The file and its directory are made when absent, private, and the file is replaced whole, through one rename.
/// A file ghostd would refuse is not rewritten: the error says what is wrong with it.
pub fn save_ghost(env: &Env, home: &Path, address: Option<&GhostAddress>) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    let path = config_path(env, home);
    // A link (a dotfiles checkout) is written through, to the file it names.
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    read_config_file(&path, home)?;
    let text = crate::private_file::read_text(&path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let mut document: Value =
        text.as_deref().map_or(Ok(Value::Object(Default::default())), serde_json::from_str).map_err(|error| error.to_string())?;
    let keys = document.as_object_mut().ok_or_else(|| format!("{} must contain a JSON object.", path.display()))?;
    match address {
        Some(address) => drop(keys.insert("ghost".to_string(), Value::String(address.written()))),
        // Nothing to take out: the file is left as it is, or absent.
        None if keys.shift_remove("ghost").is_none() => return Ok(()),
        None => {}
    }
    let written = |error: std::io::Error| format!("Cannot write {}: {error}", path.display());
    if let Some(directory) = path.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(directory).map_err(written)?;
    }
    crate::private_file::write_json_atomic(&path, &document).map_err(written)
}

pub fn load_config(overrides: &Overrides, env: &Env, home: &Path) -> Result<DaemonConfig, String> {
    let config_path = overrides.config_path.clone().unwrap_or_else(|| config_path(env, home));
    let file = read_config_file(&config_path, home)?.unwrap_or_default();
    let env_port = var(env, "GHOSTD_PORT")
        .map(|raw| raw.parse::<u16>().map_err(|_| format!("Invalid port from GHOSTD_PORT: {}", Value::String(raw.to_string()))))
        .transpose()?;
    let port = overrides.port.or(env_port).or(file.port).unwrap_or(DEFAULT_PORT);
    let raw_home = overrides
        .home
        .clone()
        .or_else(|| var(env, "GHOST_HOME").map(str::to_string))
        .or(file.home)
        .unwrap_or_else(|| default_ghost_home(env, home).to_string_lossy().into_owned());
    let hooks = match var(env, "GHOSTD_HOOKS") {
        Some(path) => expand_home(path, home),
        None => config_path.parent().unwrap_or(Path::new("/")).join("hooks.json"),
    };
    // `local` is this machine's own ghost, whatever the file says: an empty variable is not set, so it cannot say so.
    let ghost = match var(env, "GHOST_AT") {
        Some("local") => None,
        Some(raw) => Some(GhostAddress::parse(raw).ok_or_else(|| format!("Invalid address from GHOST_AT: {}", Value::String(raw.to_string())))?),
        None => file.ghost,
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    Ok(DaemonConfig {
        port,
        home: resolve(&cwd, &expand_home(&raw_home, home)),
        remote: RemoteConfig { owner: file.owner, apps: file.apps.unwrap_or_else(|| RemoteConfig::default().apps) },
        hooks_path: resolve(&cwd, &hooks),
        config_path,
        local: file.local,
        ghost,
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
        assert_eq!(config.home, dir.join(".local/share/ghost"));
        assert_eq!(config.hooks_path, dir.join(".config/ghost/hooks.json"));
        assert_eq!(config.remote, RemoteConfig::default());
        assert_eq!(config.local, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn rewrite(dir: &Path, config: Value) {
        std::fs::write(dir.join(".config/ghost/config.json"), config.to_string()).unwrap();
    }

    #[test]
    fn reads_the_local_model_expanding_home_with_defaults() {
        let (dir, env) = scratch(Some(json!({ "local": { "model": "~/models/gemma.gguf" } })));
        assert_eq!(
            load(&dir, &env).unwrap().local,
            Some(LocalModelConfig {
                model: dir.join("models/gemma.gguf"),
                server: "llama-server".into(),
                context_size: 32_768,
                idle_ms: 300_000,
                reasoning_effort: "low".into(),
            })
        );
        rewrite(
            &dir,
            json!({ "local": { "model": "/m.gguf", "server": "~/bin/llama-server", "contextSize": 8192, "idleMinutes": 1, "reasoningEffort": " minimal " } }),
        );
        assert_eq!(
            load(&dir, &env).unwrap().local,
            Some(LocalModelConfig {
                model: PathBuf::from("/m.gguf"),
                server: dir.join("bin/llama-server").to_string_lossy().into_owned(),
                context_size: 8192,
                idle_ms: 60_000,
                reasoning_effort: "minimal".into(),
            })
        );
        // A relative model is under the directory ghostd runs in, as `home` is.
        rewrite(&dir, json!({ "local": { "model": "models/../m.gguf" } }));
        assert_eq!(load(&dir, &env).unwrap().local.unwrap().model, std::env::current_dir().unwrap().join("m.gguf"));
        for local in [
            json!({}),
            json!({ "model": "" }),
            json!({ "model": "/m.gguf", "idleMinutes": 0 }),
            json!({ "model": "/m.gguf", "idleMinutes": 1.5 }),
            json!({ "model": "/m.gguf", "contextSize": -1 }),
            json!({ "model": "/m.gguf", "contextSize": "8192" }),
            json!({ "model": "/m.gguf", "reasoningEffort": 1 }),
            json!({ "model": "/m.gguf", "reasoningEffort": " " }),
            json!("gemma"),
        ] {
            rewrite(&dir, json!({ "local": local }));
            assert!(load(&dir, &env).unwrap_err().contains("\"local"), "{local}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_number_is_a_plain_whole_one() {
        let (dir, env) = scratch(Some(json!({ "port": 8123, "local": { "model": "/m.gguf", "contextSize": 8192, "idleMinutes": 2 } })));
        let config = load(&dir, &env).unwrap();
        let local = config.local.unwrap();
        assert_eq!((config.port, local.context_size, local.idle_ms), (8123, 8192, 120_000));
        // Port 0 is any free port.
        rewrite(&dir, json!({ "port": 0 }));
        assert_eq!(load(&dir, &env).unwrap().port, 0);
        let path = dir.join(".config/ghost/config.json");
        for port in ["70000", "-1", "80.5", "8123.0", "8.123e3", "\"7717\"", "null"] {
            std::fs::write(&path, format!("{{ \"port\": {port} }}")).unwrap();
            assert_eq!(load(&dir, &env).unwrap_err(), format!("{}: \"port\" must be a whole number from 0 to 65535.", path.display()), "{port}");
        }
        for size in ["8192.0", "8.192e3"] {
            std::fs::write(&path, format!("{{ \"local\": {{ \"model\": \"/m.gguf\", \"contextSize\": {size} }} }}")).unwrap();
            assert!(load(&dir, &env).unwrap_err().ends_with("\"local.contextSize\" must be a positive whole number."), "{size}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_the_remote_owner_and_apps() {
        // The owner is kept as logins are compared: trimmed, without its case.
        let (dir, env) = scratch(Some(json!({ "remote": { "owner": " Owner@Example.com " } })));
        assert_eq!(
            load(&dir, &env).unwrap().remote,
            RemoteConfig { owner: Some("owner@example.com".into()), apps: vec!["https://summonghost.com".into()] }
        );
        for owner in [json!(" "), json!(7)] {
            rewrite(&dir, json!({ "remote": { "owner": owner } }));
            assert!(load(&dir, &env).unwrap_err().ends_with("\"remote.owner\" must be a login."), "{owner}");
        }
        // `[]` admits none.
        rewrite(&dir, json!({ "remote": { "apps": [] } }));
        assert_eq!(load(&dir, &env).unwrap().remote.apps, Vec::<String>::new());
        rewrite(&dir, json!({ "remote": { "apps": ["https://lab.summonghost.com", "https://app.example:8443"] } }));
        assert_eq!(load(&dir, &env).unwrap().remote.apps, ["https://lab.summonghost.com", "https://app.example:8443"]);
        for apps in [
            json!("https://summonghost.com"),
            json!(["http://summonghost.com"]),
            json!(["https://summonghost.com/"]),
            json!(["summonghost.com"]),
            json!([7]),
            json!(["https://Summonghost.com"]),
            json!(["https://summonghost.com:443"]),
            json!(["https://summonghost.com:08443"]),
            json!(["https://user@summonghost.com"]),
            json!(["https://"]),
        ] {
            rewrite(&dir, json!({ "remote": { "apps": apps } }));
            assert!(load(&dir, &env).unwrap_err().contains("remote.apps"), "{apps}");
        }
        rewrite(&dir, json!({ "remote": [] }));
        assert!(load(&dir, &env).unwrap_err().contains("\"remote\" must be a JSON object"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_where_the_ghost_is_and_the_environment_overrides_the_file() {
        let (dir, mut env) = scratch(None);
        let ghost = |dir: &Path, env: &Env| load(dir, env).map(|config| config.ghost.map(|ghost| (ghost.origin(), ghost.machine().to_string())));
        let at = |origin: &str, machine: &str| Ok(Some((origin.to_string(), machine.to_string())));
        // Neither set: this machine's own.
        assert_eq!(ghost(&dir, &env), Ok(None));
        // A host name is https on 443; an origin says its scheme, and its port when it is not the scheme's own.
        for (written, origin, machine) in [
            ("beelink.tailnet.ts.net", "https://beelink.tailnet.ts.net", "beelink"),
            (" HTTPS://Beelink.Tailnet.ts.net:443 ", "https://beelink.tailnet.ts.net", "beelink"),
            ("https://beelink.tailnet.ts.net:8443", "https://beelink.tailnet.ts.net:8443", "beelink"),
            ("http://beelink:80", "http://beelink", "beelink"),
            ("http://127.0.0.1:7000", "http://127.0.0.1:7000", "127.0.0.1"),
        ] {
            rewrite(&dir, json!({ "ghost": written }));
            assert_eq!(ghost(&dir, &env), at(origin, machine), "{written}");
        }
        let path = dir.join(".config/ghost/config.json");
        for refused in [
            json!(""),
            json!("https://"),
            json!("beelink/"),
            json!("https://beelink/api"),
            json!("user@beelink"),
            json!("beelink:0"),
            json!("beelink:port"),
            json!("ftp://beelink"),
            json!(7),
            json!(null),
        ] {
            rewrite(&dir, json!({ "ghost": refused }));
            assert_eq!(
                load(&dir, &env).unwrap_err(),
                format!(
                    "{}: \"ghost\" must be another machine's address like \"machine.tailnet.ts.net\" or \"https://machine.tailnet.ts.net\".",
                    path.display()
                ),
                "{refused}"
            );
        }
        // GHOST_AT overrides the file for one command; `local` is this machine's own ghost, and empty is not set.
        rewrite(&dir, json!({ "ghost": "beelink.tailnet.ts.net" }));
        env.insert("GHOST_AT".into(), "http://127.0.0.1:7000".into());
        assert_eq!(ghost(&dir, &env), at("http://127.0.0.1:7000", "127.0.0.1"));
        env.insert("GHOST_AT".into(), "local".into());
        assert_eq!(ghost(&dir, &env), Ok(None));
        env.insert("GHOST_AT".into(), " ".into());
        assert_eq!(ghost(&dir, &env), at("https://beelink.tailnet.ts.net", "beelink"));
        env.insert("GHOST_AT".into(), "bee link".into());
        assert_eq!(load(&dir, &env).unwrap_err(), "Invalid address from GHOST_AT: \"bee link\"");
        std::fs::remove_dir_all(dir).unwrap();
    }

    // `ghost use` and the bar's offer write one key: every other key, and the file's privacy, survive it.
    #[test]
    fn saving_where_the_ghost_is_keeps_every_other_key_and_the_file_private() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, mut env) = scratch(None);
        let path = dir.join(".config/ghost/config.json");
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let alarm = GhostAddress::parse("alarm.tailnet.ts.net").unwrap();
        // The owner's file, in their order, readable by them alone.
        std::fs::write(&path, "{\"port\": 8123, \"remote\": {\"owner\": \"me@example.com\"},\n \"local\": {\"model\": \"/m.gguf\"}}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        save_ghost(&env, &dir, Some(&alarm)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"port\": 8123,\n  \"remote\": {\n    \"owner\": \"me@example.com\"\n  },\n  \"local\": {\n    \"model\": \"/m.gguf\"\n  },\n  \"ghost\": \"alarm.tailnet.ts.net\"\n}\n"
        );
        assert_eq!((mode(&path), saved_ghost(&env, &dir)), (0o600, Ok(Some(alarm.clone()))));
        assert_eq!(std::fs::read_dir(dir.join(".config/ghost")).unwrap().count(), 1, "no temporary file is left");
        // An address that is not a host name on 443 is saved as its origin; a file anyone could read ends private.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        save_ghost(&env, &dir, Some(&GhostAddress::parse("http://127.0.0.1:7000").unwrap())).unwrap();
        assert_eq!((load(&dir, &env).unwrap().ghost.unwrap().origin().as_str(), mode(&path)), ("http://127.0.0.1:7000", 0o600));
        // Back to this machine's own: the key goes, the rest stays; with no key there is nothing to write.
        save_ghost(&env, &dir, None).unwrap();
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.ghost, config.port, config.remote.owner.as_deref(), config.local.is_some()), (None, 8123, Some("me@example.com"), true));
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        save_ghost(&env, &dir, None).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);

        // A file ghostd would refuse is never rewritten: what is wrong with it is the error.
        for broken in ["{ not json", "[]", "{\"host\": 1}", "{\"port\": \"7717\"}"] {
            std::fs::write(&path, broken).unwrap();
            for address in [Some(&alarm), None] {
                assert!(save_ghost(&env, &dir, address).unwrap_err().starts_with(&path.display().to_string()), "{broken}");
            }
            assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
        }

        // No file and no directory: both are made, private. Removing from no file makes none.
        env.insert("XDG_CONFIG_HOME".into(), dir.join("fresh/config").display().to_string());
        let fresh = dir.join("fresh/config/ghost/config.json");
        save_ghost(&env, &dir, None).unwrap();
        assert!(!dir.join("fresh").exists());
        save_ghost(&env, &dir, Some(&alarm)).unwrap();
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "{\n  \"ghost\": \"alarm.tailnet.ts.net\"\n}\n");
        assert_eq!((mode(&fresh), mode(fresh.parent().unwrap())), (0o600, 0o700));
        // A link is written through: it stays a link, and the file it names is the one replaced.
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&fresh, &link).unwrap();
        env.insert("GHOSTD_CONFIG".into(), link.display().to_string());
        save_ghost(&env, &dir, None).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "{}\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_the_xdg_config_file_and_honours_xdg_config_home() {
        let (dir, mut env) = scratch(Some(json!({ "port": 8123, "home": "~/Spirits" })));
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.port, config.home, config.config_path), (8123, dir.join("Spirits"), dir.join(".config/ghost/config.json")));
        let xdg = dir.join("xdg");
        std::fs::create_dir_all(xdg.join("ghost")).unwrap();
        std::fs::write(xdg.join("ghost/config.json"), json!({ "port": 9001 }).to_string()).unwrap();
        env.insert("XDG_CONFIG_HOME".into(), xdg.display().to_string());
        assert_eq!(default_config_path(&env, &dir), xdg.join("ghost/config.json"));
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.port, config.hooks_path), (9001, xdg.join("ghost/hooks.json")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_environment_overrides_the_file_and_an_empty_variable_is_not_set() {
        let (dir, mut env) = scratch(Some(json!({ "port": 8123, "home": "/from-file" })));
        env.insert("GHOSTD_PORT".into(), " 7000 ".into());
        env.insert("GHOST_HOME".into(), dir.join("FromEnv").display().to_string());
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.port, config.home), (7000, dir.join("FromEnv")));
        // An explicit override beats the environment.
        let flagged = load_config(&Overrides { port: Some(7788), home: Some("/flagged".into()), config_path: None }, &env, &dir).unwrap();
        assert_eq!((flagged.port, flagged.home), (7788, PathBuf::from("/flagged")));
        // Empty variables fall back: the default config path, the file's port and root, hooks beside the config.
        for name in ["GHOSTD_CONFIG", "GHOSTD_PORT", "GHOST_HOME", "GHOSTD_HOOKS"] {
            env.insert(name.into(), "  ".into());
        }
        let config = load(&dir, &env).unwrap();
        assert_eq!(config.config_path, dir.join(".config/ghost/config.json"));
        assert_eq!((config.port, config.home, config.hooks_path), (8123, PathBuf::from("/from-file"), dir.join(".config/ghost/hooks.json")));
        // A named config file is the one read, and hooks.json is beside it.
        let elsewhere = dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("c.json"), json!({ "port": 9100 }).to_string()).unwrap();
        env.insert("GHOSTD_CONFIG".into(), elsewhere.join("c.json").display().to_string());
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.port, config.hooks_path), (9100, elsewhere.join("hooks.json")));
        let flagged = load_config(&Overrides { config_path: Some(dir.join("none.json")), ..Default::default() }, &env, &dir).unwrap();
        assert_eq!((flagged.port, flagged.config_path, flagged.hooks_path), (DEFAULT_PORT, dir.join("none.json"), dir.join("hooks.json")));
        // A path from the environment may start at the home directory.
        env.insert("GHOSTD_CONFIG".into(), "~/elsewhere/c.json".into());
        env.insert("GHOSTD_HOOKS".into(), "~/h.json".into());
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.port, config.config_path, config.hooks_path), (9100, elsewhere.join("c.json"), dir.join("h.json")));
        env.insert("GHOSTD_PORT".into(), "70000".into());
        assert_eq!(load(&dir, &env).unwrap_err(), "Invalid port from GHOSTD_PORT: \"70000\"");
        env.insert("GHOSTD_PORT".into(), "not-a-port".into());
        assert_eq!(load(&dir, &env).unwrap_err(), "Invalid port from GHOSTD_PORT: \"not-a-port\"");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_a_file_that_is_not_an_object_of_the_keys_it_reads() {
        let (dir, env) = scratch(None);
        let path = dir.join(".config/ghost/config.json");
        let refused = |config: Value| {
            rewrite(&dir, config);
            load(&dir, &env).unwrap_err().strip_prefix(&format!("{}: ", path.display())).expect("the file is named").to_string()
        };
        // A key ghostd does not read is named, with the ones it does, wherever it is.
        assert_eq!(
            refused(json!({ "host": "0.0.0.0", "prot": 1 })),
            "unknown \"host\", \"prot\"; the keys are \"port\", \"home\", \"remote\", \"local\", \"ghost\"."
        );
        assert_eq!(refused(json!({ "remote": { "port": 443 } })), "unknown \"remote.port\"; the keys are \"remote.owner\", \"remote.apps\".");
        assert_eq!(
            refused(json!({ "local": { "model": "/m.gguf", "context": 8192 } })),
            "unknown \"local.context\"; the keys are \"local.model\", \"local.server\", \"local.contextSize\", \"local.idleMinutes\", \"local.reasoningEffort\"."
        );
        assert_eq!(refused(json!({ "home": 7 })), "\"home\" must be a string.");
        rewrite(&dir, json!([]));
        assert_eq!(load(&dir, &env).unwrap_err(), format!("{} must contain a JSON object.", path.display()));
        std::fs::write(&path, "{").unwrap();
        assert!(load(&dir, &env).unwrap_err().starts_with(&format!("{} is not valid JSON: ", path.display())));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
