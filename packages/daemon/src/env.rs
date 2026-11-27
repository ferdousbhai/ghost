//! An environment as a value, so a test hands in its own and nothing reads
//! the process's behind a caller's back.
use std::collections::BTreeMap;
use std::path::PathBuf;

pub type Env = BTreeMap<String, String>;

/// The process's own environment; variables that are not UTF-8 are left out.
pub fn current() -> Env {
    std::env::vars_os().filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?))).collect()
}

/// A variable's trimmed value, when it has one.
pub(crate) fn var<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    env.get(name).map(|value| value.trim()).filter(|value| !value.is_empty())
}

/// The owner's home: `$HOME`, as every process of theirs has it.
pub fn home(env: &Env) -> PathBuf {
    PathBuf::from(var(env, "HOME").unwrap_or("/"))
}

/// The executable `name` resolves to on `env`'s `PATH`, or None.
pub(crate) fn which(name: &str, env: &Env) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    env.get("PATH")?.split(':').filter(|dir| !dir.is_empty()).map(|dir| PathBuf::from(dir).join(name)).find(|path| {
        // What `access(X_OK)` would say for the owner: a file with an execute bit.
        std::fs::metadata(path).is_ok_and(|info| info.is_file() && info.permissions().mode() & 0o111 != 0)
    })
}
