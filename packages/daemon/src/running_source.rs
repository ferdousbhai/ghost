//! What is running right now: the daemon's version, and — when it runs from a
//! source checkout rather than the packaged install — that checkout's root and
//! HEAD commit. Nothing here fails: an unreadable checkout only means "unknown".
use crate::env::Env;
use crate::process::run_command;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningSource {
    pub version: String,
    pub commit: Option<String>,
    pub root: Option<PathBuf>,
    /// The executable this process was started from, and when it started (milliseconds).
    pub entry: PathBuf,
    pub started_at: i64,
}

/// The executable this process runs. Ask once, at start: after an upgrade
/// replaces the file, the kernel names the old one as deleted.
pub fn running_executable() -> PathBuf {
    std::env::current_exe().unwrap_or_default()
}

/// A Cargo workspace root: its `Cargo.toml` has a `[workspace]` table.
fn is_workspace_root(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("Cargo.toml")).is_ok_and(|manifest| manifest.lines().any(|line| line.trim() == "[workspace]"))
}

/// The nearest ancestor of `start_dir` that is this repository's checkout root (a clone or a worktree).
fn find_source_root(start_dir: &Path) -> Option<PathBuf> {
    let start = crate::xdg::resolve(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")), start_dir);
    start.ancestors().find(|dir| dir.join(".git").exists() && is_workspace_root(dir)).map(Path::to_path_buf)
}

/// The commit `HEAD` names in the checkout at `root`, or None if git cannot
/// say. Git's own variables are dropped: under a hook's GIT_DIR, `-C root`
/// would answer for the hook's repository instead.
fn read_head_commit(root: &Path, env: &Env) -> Option<String> {
    let env: Env = env.iter().filter(|(name, _)| !name.starts_with("GIT_")).map(|(name, value)| (name.clone(), value.clone())).collect();
    let args = ["-C", &root.to_string_lossy(), "rev-parse", "--verify", "-q", "HEAD"];
    let result = run_command("git", &args, &env, Duration::from_secs(10)).ok()?;
    let commit = result.stdout.trim();
    (result.code == 0 && !commit.is_empty()).then(|| commit.to_string())
}

/// What is running from `entry`: `version` plus the checkout behind it when there is one.
pub fn resolve_running_source(version: &str, entry: &Path, env: &Env) -> RunningSource {
    let root = entry.parent().and_then(find_source_root);
    let commit = root.as_deref().and_then(|root| read_head_commit(root, env));
    RunningSource { version: version.to_string(), commit, root, entry: entry.to_path_buf(), started_at: crate::clock::now_ms() }
}

/// The code on disk is no longer what this process runs, so it needs a
/// restart to run it: an install or a build rewrote the executable after this
/// process started. The file's ctime says when it was written here; a package
/// cannot backdate it the way it carries its build time as the mtime, and a
/// commit that was not built changes nothing that runs.
pub fn replaced_since_start(running: &RunningSource) -> bool {
    match std::fs::metadata(&running.entry) {
        Ok(info) => i128::from(info.ctime()) * 1_000_000_000 + i128::from(info.ctime_nsec()) > i128::from(running.started_at) * 1_000_000,
        // Gone: an upgrade replaced it under another name.
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::now_ms;

    /// The environment without git's own variables, and with no configuration
    /// of the owner's. A hook (pre-push runs the gate) exports GIT_DIR, and
    /// with it `git -C <temp> init` and `commit` would act on the real repository.
    fn outside_any_repository() -> Env {
        let mut env: Env = crate::env::current().into_iter().filter(|(name, _)| !name.starts_with("GIT_")).collect();
        env.insert("GIT_CONFIG_GLOBAL".into(), "/dev/null".into());
        env.insert("GIT_CONFIG_SYSTEM".into(), "/dev/null".into());
        env
    }

    /// Make `root` a git repository with one commit, and return that commit.
    fn git_commit(root: &Path) -> String {
        let env = outside_any_repository();
        let git = |args: &[&str]| {
            let mut argv = vec!["-C", root.to_str().unwrap()];
            argv.extend_from_slice(args);
            let result = run_command("git", &argv, &env, Duration::from_secs(30)).expect("git runs");
            assert_eq!(result.code, 0, "git {args:?}: {}", result.stderr);
            result.stdout.trim().to_string()
        };
        if !root.join(".git").exists() {
            git(&["init", "-q"]);
            git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
        }
        git(&["rev-parse", "HEAD"])
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("running-source-{}", crate::random::uuid()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A checkout whose Cargo.toml marks it as a workspace root.
    fn workspace(root: PathBuf) -> PathBuf {
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("Cargo.toml"), "[workspace]\nmembers = [\"packages/daemon\"]\nresolver = \"3\"\n").unwrap();
        root
    }

    #[test]
    fn walks_up_to_the_workspace_root_that_has_a_git_directory() {
        let base = Scratch::new();
        let root = workspace(base.0.join("checkout"));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let deep = root.join("packages/daemon/target/release");
        std::fs::create_dir_all(&deep).unwrap();
        // A member package's own manifest on the way up is not the root.
        std::fs::write(root.join("packages/daemon/Cargo.toml"), "[package]\nname = \"ghostd\"\n").unwrap();
        assert_eq!(find_source_root(&deep), Some(root));
    }

    #[test]
    fn accepts_a_worktree_whose_git_is_a_gitdir_file() {
        let base = Scratch::new();
        let root = workspace(base.0.join("worktree"));
        let git_dir = base.0.join("main/.git/worktrees/wt");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(root.join(".git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
        assert_eq!(find_source_root(&root), Some(root));
    }

    #[test]
    fn refuses_a_git_checkout_that_is_not_a_workspace_root() {
        let base = Scratch::new();
        let root = base.0.join("elsewhere");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        assert_eq!(find_source_root(&root), None);
        std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"not-ghost\"\n\n[workspace.metadata]\nx = 1\n").unwrap();
        assert_eq!(find_source_root(&root), None);
    }

    #[test]
    fn reports_no_root_for_a_packaged_install_with_no_git_above_it() {
        let base = Scratch::new();
        let runtime = workspace(base.0.join("usr/lib/ghost"));
        assert_eq!(find_source_root(&runtime), None);
    }

    #[test]
    fn asks_git_for_the_head_commit_and_is_none_when_git_cannot_say() {
        let base = Scratch::new();
        let env = outside_any_repository();
        let root = workspace(base.0.join("checkout"));
        assert_eq!(read_head_commit(&root, &env), None);
        let commit = git_commit(&root);
        assert!((40..=64).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_hexdigit()), "{commit}");
        assert_eq!(read_head_commit(&root, &env), Some(commit.clone()));
        assert_eq!(read_head_commit(&base.0.join("missing"), &env), None);
        // A hook's GIT_DIR would answer for the hook's repository: it is dropped.
        let mut hooked = env.clone();
        hooked.insert("GIT_DIR".into(), base.0.join("missing/.git").display().to_string());
        assert_eq!(read_head_commit(&root, &hooked), Some(commit));
    }

    #[test]
    fn carries_the_version_even_when_there_is_no_checkout() {
        let base = Scratch::new();
        let entry = base.0.join("ghostd");
        let before = now_ms();
        let running = resolve_running_source("1.2.3", &entry, &outside_any_repository());
        assert!(running.started_at >= before && running.started_at <= now_ms());
        assert_eq!(running, RunningSource { version: "1.2.3".into(), root: None, commit: None, entry, started_at: running.started_at });
    }

    #[test]
    fn reports_the_checkout_root_and_its_commit() {
        let base = Scratch::new();
        let root = workspace(base.0.join("checkout"));
        let commit = git_commit(&root);
        let running = resolve_running_source("0.0.1", &root.join("packages/daemon/target/release/ghostd"), &outside_any_repository());
        assert_eq!((running.version.as_str(), running.root, running.commit), ("0.0.1", Some(root), Some(commit)));
    }

    // A daemon outlives its install: what answers can be older than what is on
    // disk, and `ghost status` has to be able to say so.
    #[test]
    fn sees_an_installed_executable_rewritten_after_the_daemon_started() {
        let base = Scratch::new();
        let entry = base.0.join("ghostd");
        std::fs::write(&entry, "old").unwrap();
        let running = resolve_running_source("1.0.0", &entry, &outside_any_repository());
        assert_eq!(running.entry, entry);
        // Started after the file was written: current.
        assert!(!replaced_since_start(&RunningSource { started_at: now_ms() + 60_000, ..running.clone() }));
        // Written after the daemon started (its ctime, which an install cannot backdate): stale.
        assert!(replaced_since_start(&RunningSource { started_at: now_ms() - 60_000, ..running.clone() }));
        // An executable that is gone was replaced under another name.
        assert!(replaced_since_start(&RunningSource { entry: base.0.join("missing"), ..running }));
    }

    #[test]
    fn goes_by_what_runs_not_what_is_committed() {
        let base = Scratch::new();
        let root = workspace(base.0.join("checkout"));
        git_commit(&root);
        // A checkout's commit moving without a build changes nothing that runs.
        let entry = base.0.join("ghostd");
        std::fs::write(&entry, "built").unwrap();
        let running = RunningSource {
            entry,
            started_at: now_ms() + 60_000,
            commit: Some("0".repeat(40)),
            ..resolve_running_source("0.0.1", &root.join("packages/daemon/ghostd"), &outside_any_repository())
        };
        assert!(!replaced_since_start(&running));
        // A build rewrote the executable it runs from: stale, checkout or not.
        assert!(replaced_since_start(&RunningSource { started_at: now_ms() - 60_000, ..running }));
    }

    #[test]
    fn the_running_executable_is_a_file_that_was_not_replaced_since_it_started() {
        let entry = running_executable();
        assert!(entry.is_file());
        assert!(!replaced_since_start(&RunningSource { version: "0".into(), commit: None, root: None, entry, started_at: now_ms() }));
    }
}
