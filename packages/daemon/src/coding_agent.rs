//! Which of the owner's coding agents a turn's prompt names: Omarchy's default
//! agent when it is one Ghost has a command for and is installed, else the
//! first of those installed. Ghost runs none of them itself; the local model
//! runs the one named from its shell (CONTRACTS.md "Local model").
use crate::abort::Abort;
use crate::env::{Env, which};
use crate::process::run_command;
use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

/// The one-shot command of each coding agent the prompt can name, in the
/// order they are tried: run with a task, it works without asking and prints
/// its steps, then its answer. A model is likely to know these already; Ghost
/// teaches it no command of its own. Claude prints only its answer unless it
/// streams JSON, which `jq` turns back into lines: each text it writes, and
/// each tool it uses with its input.
pub const CODING_AGENT_COMMANDS: [(&str, &str); 3] = [
    (
        "claude",
        r#"claude -p "<task>" --verbose --output-format stream-json | jq --unbuffered -r '.message.content[]?|.text//(select(.name)|"\(.name) \(.input)")'"#,
    ),
    ("codex", r#"codex exec "<task>""#),
    ("agy", r#"agy -p "<task>""#),
];

/// The command of the agent `id`, or None when Ghost has none for it.
pub fn coding_agent_command(id: &str) -> Option<&'static str> {
    CODING_AGENT_COMMANDS.iter().find(|(known, _)| *known == id).map(|(_, command)| *command)
}

fn succeeds(file: &str, args: &[&str], env: &Env) -> bool {
    run_command(file, args, env, None, Duration::from_secs(10), &Abort::new()).is_ok_and(|result| result.code == 0)
}

/// The package a first-run mise stub installs, when the file at `path` is one.
fn stub_package(path: &Path) -> Option<String> {
    static STUB: OnceLock<Regex> = OnceLock::new();
    // A stub is a short script; a large file is a real binary and is never read.
    let info = std::fs::symlink_metadata(path).ok()?;
    if !info.is_file() || info.len() > 64 * 1024 {
        return None;
    }
    let script = std::fs::read(path).ok()?;
    let stub = STUB.get_or_init(|| Regex::new(r#"(?m)^mise use -g(?:\s+--?[A-Za-z0-9_-]+)*\s+"?([^"\s]+)"?"#).expect("a valid pattern"));
    Some(stub.captures(&String::from_utf8_lossy(&script))?[1].to_string())
}

/// Omarchy's own test (`agent_present` in `omarchy-default-agent`): an agent with
/// an `omarchy-install-<id>-cli` installer is installed when its `--check` says
/// so; a first-run mise stub (a regular file with a `mise use -g "<package>"`
/// line) only once `mise where <package>` finds some installed version, so a
/// pending update is not a cold install; anything else on PATH is the owner's own.
fn is_installed(id: &str, env: &Env) -> bool {
    let Some(path) = which(id, env) else { return false };
    if let Some(installer) = which(&format!("omarchy-install-{id}-cli"), env) {
        return succeeds(&installer.to_string_lossy(), &["--check"], env);
    }
    // Unreadable: treat it as the owner's own install.
    match stub_package(&path) {
        Some(package) => succeeds("mise", &["where", &package], env),
        None => true,
    }
}

/// Omarchy's default agent (`omarchy default agent`), or None when none is chosen.
fn omarchy_default_agent(env: &Env) -> Option<String> {
    let chosen = run_command("omarchy-default-agent", &[], env, None, Duration::from_secs(5), &Abort::new()).ok()?;
    let name = crate::js_text::trim(&chosen.stdout);
    (chosen.code == 0 && !name.is_empty()).then(|| name.to_string())
}

/// The coding agent to name, or None with none of them installed.
pub fn choose_coding_agent(env: &Env) -> Option<String> {
    let chosen = omarchy_default_agent(env).filter(|chosen| coding_agent_command(chosen).is_some());
    let ids = CODING_AGENT_COMMANDS.iter().map(|(id, _)| *id);
    let ordered: Vec<&str> = match chosen.as_deref() {
        Some(chosen) => std::iter::once(chosen).chain(ids.filter(|other| *other != chosen)).collect(),
        None => ids.collect(),
    };
    ordered.into_iter().find(|id| is_installed(id, env)).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    /// A PATH holding only these commands, each a script with this body.
    fn path(commands: &[(&str, &str)]) -> (PathBuf, Env) {
        let bin = std::env::temp_dir().join(format!("ghost-coding-agent-{}", crate::random::uuid()));
        std::fs::create_dir_all(&bin).unwrap();
        for (name, body) in commands {
            std::fs::write(bin.join(name), format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(bin.join(name), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let env = Env::from([("PATH".to_string(), bin.display().to_string())]);
        (bin, env)
    }

    fn chosen(commands: &[(&str, &str)]) -> Option<String> {
        let (bin, env) = path(commands);
        let agent = choose_coding_agent(&env);
        std::fs::remove_dir_all(bin).unwrap();
        agent
    }

    #[test]
    fn names_omarchys_default_agent_when_it_is_installed_and_has_a_command() {
        assert_eq!(chosen(&[("omarchy-default-agent", "echo codex"), ("claude", ""), ("codex", "")]).as_deref(), Some("codex"));
    }

    #[test]
    fn names_the_first_installed_one_when_the_default_is_another_agent_or_none_is_chosen() {
        assert_eq!(chosen(&[("omarchy-default-agent", "echo pi"), ("pi", ""), ("codex", ""), ("agy", "")]).as_deref(), Some("codex"));
        assert_eq!(chosen(&[("agy", "")]).as_deref(), Some("agy"));
    }

    #[test]
    fn passes_over_one_omarchys_installer_says_is_not_installed_and_names_none_when_none_is() {
        assert_eq!(chosen(&[("claude", ""), ("omarchy-install-claude-cli", "exit 1"), ("codex", "")]).as_deref(), Some("codex"));
        assert_eq!(chosen(&[("omarchy-default-agent", "echo claude")]), None);
    }

    #[test]
    fn a_mise_stub_counts_only_once_mise_has_a_version_of_its_package() {
        let stub = "mise use -g --quiet \"npm:@openai/codex\"\nexec codex \"$@\"";
        assert_eq!(chosen(&[("codex", stub), ("agy", "")]).as_deref(), Some("agy"));
        assert_eq!(chosen(&[("codex", stub), ("mise", "[ \"$1 $2\" = \"where npm:@openai/codex\" ]"), ("agy", "")]).as_deref(), Some("codex"));
    }

    #[test]
    fn every_agent_has_its_one_shot_command() {
        assert_eq!(coding_agent_command("codex"), Some("codex exec \"<task>\""));
        assert_eq!(coding_agent_command("agy"), Some("agy -p \"<task>\""));
        assert!(coding_agent_command("claude").unwrap().ends_with(r#"'.message.content[]?|.text//(select(.name)|"\(.name) \(.input)")'"#));
        assert_eq!(coding_agent_command("pi"), None);
    }
}
