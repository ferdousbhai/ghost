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

/// Who may reach the daemon through `tailscale serve`: `owner` is the login
/// that owns the ghost (default: the login this node belongs to), the only
/// one admitted; `apps` the web app origins
/// admitted with a tailnet identity (`[]` admits none).
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
}

#[derive(Default, Clone, Debug)]
pub struct Overrides {
    pub port: Option<u16>,
    pub home: Option<String>,
    pub config_path: Option<PathBuf>,
}

/// `$XDG_DATA_HOME/ghost`, else `~/.local/share/ghost`.
pub fn default_ghost_home(env: &Env, home: &Path) -> PathBuf {
    base_dir(env, Base::Data, home).join("ghost")
}

pub fn default_config_path(env: &Env, home: &Path) -> PathBuf {
    base_dir(env, Base::Config, home).join("ghost").join("config.json")
}

/// A JSON number that is a whole one, however it was written (`8192`, `8192.0`, `8.192e3`).
fn whole(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().filter(|n| n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n)).map(|n| n as u64))
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
        Some(value) => whole(value).filter(|n| *n >= 1).ok_or_else(|| format!("{path}: \"local.{key}\" must be a positive whole number.")),
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
        config.port = Some(parse_port(&whole(port).map_or_else(|| port.to_string(), |port| port.to_string()), &shown)?);
    }
    if let Some(dir) = file.get("home") {
        config.home = Some(dir.as_str().ok_or_else(|| format!("{shown}: \"home\" must be a string."))?.to_string());
    }
    if let Some(remote) = file.get("remote") {
        let remote = remote.as_object().ok_or_else(|| format!("{shown}: \"remote\" must be a JSON object."))?;
        if let Some(owner) = remote.get("owner") {
            let owner =
                owner.as_str().filter(|owner| !owner.trim().is_empty()).ok_or_else(|| format!("{shown}: \"remote.owner\" must be a login."))?;
            config.owner = Some(owner.to_string());
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
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    Ok(DaemonConfig {
        port,
        home: resolve(&cwd, &expand_home(&raw_home, home)),
        remote: RemoteConfig { owner: file.owner, apps: file.apps.unwrap_or_else(|| RemoteConfig::default().apps) },
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
        assert_eq!(config.home, dir.join(".local/share/ghost"));
        assert_eq!(config.hooks_path, dir.join(".config/ghost/hooks.json"));
        assert_eq!(config.remote, RemoteConfig::default());
        assert_eq!(config.local, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn flags_beat_the_environment_which_beats_the_file() {
        let (dir, mut env) = scratch(Some(json!({ "port": 7001, "home": "~/a", "host": "0.0.0.0" })));
        assert_eq!(load(&dir, &env).unwrap().port, 7001);
        assert_eq!(load(&dir, &env).unwrap().home, dir.join("a"));
        env.insert("GHOSTD_PORT".into(), "7002".into());
        env.insert("GHOST_HOME".into(), "/b".into());
        env.insert("GHOSTD_HOOKS".into(), "~/h.json".into());
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.port, config.home.clone(), config.hooks_path.clone()), (7002, PathBuf::from("/b"), dir.join("h.json")));
        let flagged = load_config(&Overrides { port: Some(7003), home: Some("/c".into()), config_path: None }, &env, &dir).unwrap();
        assert_eq!((flagged.port, flagged.home), (7003, PathBuf::from("/c")));
        env.insert("GHOSTD_PORT".into(), "70000".into());
        assert!(load(&dir, &env).unwrap_err().contains("Invalid port from GHOSTD_PORT"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_and_local_are_validated() {
        let (dir, env) = scratch(Some(json!({
            "remote": { "owner": "Me@Example.com", "apps": ["https://a.example", "https://b.example:8443"] },
            "local": { "model": "~/m.gguf", "idleMinutes": 2 },
        })));
        let config = load(&dir, &env).unwrap();
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

    // ── Configuration ───────────────────────────────────────────────────

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
    fn a_whole_number_is_one_however_json_writes_it() {
        let (dir, env) = scratch(None);
        std::fs::write(
            dir.join(".config/ghost/config.json"),
            r#"{ "port": 8123.0, "local": { "model": "/m.gguf", "contextSize": 8.192e3, "idleMinutes": 2.0 } }"#,
        )
        .unwrap();
        let config = load(&dir, &env).unwrap();
        let local = config.local.unwrap();
        assert_eq!((config.port, local.context_size, local.idle_ms), (8123, 8192, 120_000));
        for port in [json!(70000), json!(-1), json!(80.5)] {
            rewrite(&dir, json!({ "port": port }));
            assert!(load(&dir, &env).unwrap_err().contains("Invalid port from"), "{port}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_the_remote_owner_and_apps() {
        let (dir, env) = scratch(Some(json!({ "remote": { "owner": "Owner@example.com" } })));
        assert_eq!(
            load(&dir, &env).unwrap().remote,
            RemoteConfig { owner: Some("Owner@example.com".into()), apps: vec!["https://summonghost.com".into()] }
        );
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
    fn reads_the_xdg_config_file_and_honours_xdg_config_home() {
        let (dir, mut env) = scratch(Some(json!({ "port": 8123, "home": "~/Spirits", "offline": true })));
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
        let (dir, mut env) = scratch(Some(json!({ "port": 8123, "home": "/from-file", "offline": true })));
        env.insert("GHOSTD_PORT".into(), " 7000 ".into());
        env.insert("GHOST_HOME".into(), dir.join("FromEnv").display().to_string());
        let config = load(&dir, &env).unwrap();
        assert_eq!((config.port, config.home), (7000, dir.join("FromEnv")));
        // An explicit override beats the environment.
        assert_eq!(load_config(&Overrides { port: Some(7788), ..Default::default() }, &env, &dir).unwrap().port, 7788);
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
        env.insert("GHOSTD_PORT".into(), "not-a-port".into());
        assert_eq!(load(&dir, &env).unwrap_err(), "Invalid port from GHOSTD_PORT: \"not-a-port\"");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ignores_keys_it_does_not_read_such_as_the_retired_host_guests_and_peers() {
        let (dir, env) = scratch(Some(
            json!({ "host": "0.0.0.0", "someday": true, "remote": { "guests": "read-only", "peers": [{ "login": "wife@example.com" }], "later": 1 } }),
        ));
        let config = load(&dir, &env).unwrap();
        assert_eq!(config.remote, RemoteConfig { owner: None, apps: vec!["https://summonghost.com".into()] });
        assert_eq!((config.port, config.local), (DEFAULT_PORT, None));
        rewrite(&dir, json!({ "home": 7 }));
        assert!(load(&dir, &env).unwrap_err().contains("\"home\" must be a string"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
