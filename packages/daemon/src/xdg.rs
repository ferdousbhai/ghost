//! freedesktop user directories, resolved the way Omarchy's own scripts do.
use crate::env::{Env, var};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy)]
pub enum Base {
    Cache,
    Config,
    Data,
    State,
}

/// An XDG base directory: the variable when it names an absolute path, else its default under `home`.
pub fn base_dir(env: &Env, base: Base, home: &Path) -> PathBuf {
    let (variable, fallback) = match base {
        Base::Cache => ("XDG_CACHE_HOME", ".cache"),
        Base::Config => ("XDG_CONFIG_HOME", ".config"),
        Base::Data => ("XDG_DATA_HOME", ".local/share"),
        Base::State => ("XDG_STATE_HOME", ".local/state"),
    };
    match var(env, variable) {
        Some(value) if Path::new(value).is_absolute() => PathBuf::from(value),
        _ => home.join(fallback),
    }
}

/// `~`, `~/…`, and `$HOME/…` under `home`; any other path unchanged.
pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("$HOME/")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// `path` made absolute under `base` with `.` and `..` folded, without touching the disk.
pub fn resolve(base: &Path, path: &Path) -> PathBuf {
    let mut resolved = PathBuf::new();
    for component in base.join(path).components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            other => resolved.push(other),
        }
    }
    resolved
}

/// One `NAME="value"` line out of the freedesktop user-dirs file.
fn user_dir(name: &str, env: &Env, home: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(base_dir(env, Base::Config, home).join("user-dirs.dirs")).ok()?;
    contents.lines().find_map(|line| {
        let value = line.trim().strip_prefix(name)?.trim_start().strip_prefix('=')?.trim();
        let value = value.strip_prefix('"').unwrap_or(value);
        let value = value.split('"').next().unwrap_or("").trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// The owner's documents directory: `XDG_DOCUMENTS_DIR` from the environment
/// first and then `user-dirs.dirs`, falling back to the English default. A
/// systemd user unit inherits none of the XDG desktop variables, so the file
/// matters as much as the environment. A relative value is under `home`.
pub fn documents_dir(env: &Env, home: &Path) -> PathBuf {
    match var(env, "XDG_DOCUMENTS_DIR").map(str::to_string).or_else(|| user_dir("XDG_DOCUMENTS_DIR", env, home)) {
        Some(configured) => resolve(home, &expand_home(&configured, home)),
        None => home.join("Documents"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn base_dirs_need_an_absolute_variable() {
        let home = Path::new("/home/o");
        assert_eq!(base_dir(&env(&[("XDG_STATE_HOME", "/s")]), Base::State, home), Path::new("/s"));
        assert_eq!(base_dir(&env(&[("XDG_STATE_HOME", "rel")]), Base::State, home), Path::new("/home/o/.local/state"));
        assert_eq!(base_dir(&env(&[]), Base::Cache, home), Path::new("/home/o/.cache"));
    }

    #[test]
    fn documents_come_from_the_variable_then_the_file_then_the_default() {
        let dir = std::env::temp_dir().join(format!("ghost-xdg-{}", crate::random::uuid()));
        std::fs::create_dir_all(dir.join(".config")).unwrap();
        let file = |contents: &str| std::fs::write(dir.join(".config/user-dirs.dirs"), contents).unwrap();
        assert_eq!(documents_dir(&env(&[]), &dir), dir.join("Documents"));
        // A systemd user unit inherits no XDG desktop variables, so the file decides.
        file("XDG_DESKTOP_DIR=\"$HOME/Desk\"\n  XDG_DOCUMENTS_DIR = \"$HOME/Docs\"\n");
        assert_eq!(documents_dir(&env(&[]), &dir), dir.join("Docs"));
        assert_eq!(documents_dir(&env(&[("XDG_DOCUMENTS_DIR", "~/Mine")]), &dir), dir.join("Mine"));
        assert_eq!(documents_dir(&env(&[("XDG_DOCUMENTS_DIR", "$HOME/Dokumente")]), &dir), dir.join("Dokumente"));
        assert_eq!(documents_dir(&env(&[("XDG_DOCUMENTS_DIR", "rel/../x")]), &dir), dir.join("x"));
        // An unquoted value, an absolute one, and a line for another directory with a longer name.
        file("XDG_DOCUMENTS_DIRS=\"$HOME/No\"\nXDG_DOCUMENTS_DIR=/srv/docs\n");
        assert_eq!(documents_dir(&env(&[]), &dir), Path::new("/srv/docs"));
        file("XDG_DOCUMENTS_DIR=\"\"\n");
        assert_eq!(documents_dir(&env(&[]), &dir), dir.join("Documents"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_user_dirs_from_xdg_config_home_and_an_empty_variable_defers_to_it() {
        let dir = std::env::temp_dir().join(format!("ghost-xdg-{}", crate::random::uuid()));
        let config = dir.join("elsewhere");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("user-dirs.dirs"), "XDG_DOCUMENTS_DIR=\"$HOME/Papers\"\n").unwrap();
        let config = config.display().to_string();
        assert_eq!(documents_dir(&env(&[("XDG_CONFIG_HOME", &config), ("XDG_DOCUMENTS_DIR", " ")]), &dir), dir.join("Papers"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expands_home_only_at_the_start_of_a_path() {
        let home = Path::new("/home/o");
        assert_eq!(expand_home("~", home), home);
        assert_eq!(expand_home("~/a", home), Path::new("/home/o/a"));
        assert_eq!(expand_home("$HOME/a", home), Path::new("/home/o/a"));
        for unchanged in ["~other/a", "/x/~/a", "a/$HOME/b", "$HOMEWARD"] {
            assert_eq!(expand_home(unchanged, home), Path::new(unchanged));
        }
        assert_eq!(resolve(Path::new("/base"), Path::new("a/./b/../c")), Path::new("/base/a/c"));
        assert_eq!(resolve(Path::new("/base"), Path::new("/abs/../x")), Path::new("/x"));
    }
}
