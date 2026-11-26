//! Which coding agent a turn's prompt names: Omarchy's default agent, when it
//! is one Ghost has a one-shot command for. Ghost runs none of them itself; the local model
//! runs the one named from its shell (CONTRACTS.md "Local model").
use crate::abort::Abort;
use crate::env::{Env, which};
use crate::process::run_command;
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

/// Omarchy's default agent (`omarchy default agent`), or None when none is chosen.
fn omarchy_default_agent(env: &Env) -> Option<String> {
    let chosen = run_command("omarchy-default-agent", &[], env, None, Duration::from_secs(5), &Abort::new()).ok()?;
    let name = chosen.stdout.trim();
    (chosen.code == 0 && !name.is_empty()).then(|| name.to_string())
}

/// The coding agent to name: Omarchy's default, when Ghost has a one-shot
/// command for it and it is on PATH. Which agent is the owner's is Omarchy's to
/// say; with no default chosen there, none is named.
pub fn choose_coding_agent(env: &Env) -> Option<String> {
    omarchy_default_agent(env).filter(|chosen| coding_agent_command(chosen).is_some() && which(chosen, env).is_some())
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
    fn names_omarchys_default_agent_when_it_is_on_path_and_has_a_command() {
        assert_eq!(chosen(&[("omarchy-default-agent", "echo codex"), ("claude", ""), ("codex", "")]).as_deref(), Some("codex"));
    }

    #[test]
    fn names_none_when_the_default_is_another_agent_is_missing_or_is_not_chosen() {
        assert_eq!(chosen(&[("omarchy-default-agent", "echo pi"), ("pi", ""), ("codex", "")]), None);
        assert_eq!(chosen(&[("omarchy-default-agent", "echo claude")]), None);
        assert_eq!(chosen(&[("omarchy-default-agent", "true"), ("codex", "")]), None);
        assert_eq!(chosen(&[("agy", "")]), None);
    }

    #[test]
    fn every_agent_has_its_one_shot_command() {
        assert_eq!(coding_agent_command("codex"), Some("codex exec \"<task>\""));
        assert_eq!(coding_agent_command("agy"), Some("agy -p \"<task>\""));
        assert!(coding_agent_command("claude").unwrap().ends_with(r#"'.message.content[]?|.text//(select(.name)|"\(.name) \(.input)")'"#));
        assert_eq!(coding_agent_command("pi"), None);
    }
}
