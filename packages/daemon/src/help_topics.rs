//! The long recipes a ghost needs only when it does one particular thing:
//! editing or restarting itself, work that outlives a turn, its notes, a
//! website, the owner's products. The prompt's Ghost section
//! indexes them by name and `ghost help <topic>` prints them, so their cost
//! lands on the turn that needs them and not on every turn. The
//! text is still contract text the ghost acts on: keep it exact, and keep the
//! index in step (prompt_policy's tests check).
use crate::help_guides::{BROWSER_LINES, products_lines};

pub const HELP_TOPICS: [&str; 5] = ["self", "background", "memory", "browser", "products"];

pub fn is_help_topic(value: &str) -> bool {
    HELP_TOPICS.contains(&value)
}

/// One topic's text, as `ghost help <topic>` prints it; None for a name that is not a topic.
pub fn render_help_topic(topic: &str) -> Option<String> {
    let lines = match topic {
        "self" => SELF_LINES.join("\n"),
        "background" => BACKGROUND_LINES.join("\n"),
        "memory" => MEMORY_LINES.join("\n"),
        "browser" => BROWSER_LINES.join("\n"),
        "products" => products_lines().join("\n"),
        _ => return None,
    };
    Some(format!("{lines}\n"))
}

const SELF_LINES: &[&str] = &[
    r"# Self-maintenance",
    r#"Any part of your code is yours to change to fit the owner. `ghost status` says whether the daemon runs from the package (which you cannot write) or a checkout. From a packaged install, first run yourself from your own clone: `git clone https://github.com/ferdousbhai/ghost ~/src/ghost`, then `cargo build --release --locked` in it (without cargo, run `omarchy-launch-floating-terminal-with-presentation 'omarchy-pkg-add rust'` alone in the foreground and the owner types their password there), then switch over as /usr/share/doc/ghost/docs/self-maintenance.md shows; its "Back to the package" undoes it. Tell the owner before you switch."#,
    r"Read the checkout's AGENTS.md and CONTRACTS.md; follow its authorized branch, commit, and push workflow. Edit, test the affected package, run clippy, commit with the reason, build, and restart.",
    r"Commit your own changes; preserve other sessions' edits. Never restore, stash, or discard changes you did not make.",
    r"CONTRIBUTING.md describes upstream contributions; the owner's instructions decide whether to push directly or open a PR.",
    r"To restart yourself, finish the turn and tell the owner first; a restart aborts every running turn:",
    r"```sh",
    r#"systemd-run --user --on-active=5 --unit="ghost-restart-$(date +%s)" \"#,
    r#"  --description="<reason>" \"#,
    r"  systemctl --user restart ghostd.service",
    r"```",
    r"The transient unit survives the daemon. Verify afterward with `ghost status` (no `restart needed` line) and `journalctl --user -t ghostd`; a restart sends no model prompt.",
    r"Omarchy owns package updates; update a checkout only when the owner asks.",
    r"History: `git log` in the checkout for what the code did, `journalctl --user -t ghostd` for what the daemon did, your transcript for why; read them before retrying a failed change.",
    r"Undo: `git revert` plus a restart for code, Trash for a deleted ghost home, `omarchy-snapshot` or snapper for the system. Never `rm -rf` a checkout.",
];

const BACKGROUND_LINES: &[&str] = &[
    r"# Background work",
    r"A command you start ends when this turn does. Work that must outlive the turn runs detached, logs to a file, and wakes you when it ends:",
    r"```sh",
    r#"systemd-run --user --scope --quiet --unit="ghost-job-<name>-$(date +%s)" -p CPUWeight=20 \"#,
    r#"  setsid -f bash -c 'cmd > "$XDG_RUNTIME_DIR/<name>.log" 2>&1; ghost say --follow-up -q "Background job finished (exit $?), log $XDG_RUNTIME_DIR/<name>.log" >/dev/null 2>&1'"#,
    r"```",
    r"`$GHOST_SESSION` is set in your shell, so `ghost` verbs address this conversation without `-s`. `--follow-up` runs after your current turn, or starts your next one when the conversation is idle.",
    r"The job is its own low-priority unit: it yields the CPU to the owner's apps, survives a daemon restart (so its log is outside your private /tmp), and `systemctl --user stop <unit>` ends it. Nothing else watches it: read its log.",
    r"Later, not now: your own work for a later time is a timer, the way Omarchy's own reminders are kept, which wakes this conversation with what to do:",
    r"```sh",
    r#"systemd-run --user --quiet --on-calendar='YYYY-MM-DD HH:MM' --unit="ghost-later-<name>-$(date +%s)" \"#,
    r#"  ghost say --follow-up -q -s "$GHOST_SESSION" "<what to do then, with what you will need to know>""#,
    r"```",
    r#"`--on-active=2h` counts from now instead. `systemctl --user list-timers 'ghost-later-*'` lists them and `systemctl --user stop <unit>.timer` cancels one. A timer is forgotten by a reboot or a logout, so also write what is planned, and when, in the note that covers it; and the computer must be on at that time. To nudge the owner on this desktop instead, `omarchy reminder <minutes> "<text>"`."#,
];

const MEMORY_LINES: &[&str] = &[
    r"# Memory",
    r"Your durable memory is the `Notes` folder of the owner's documents directory (Owner context): Markdown notes that you and the owner both read and write, so write them for a person to read, and read a note again before changing it. `Reminders` beside it is the owner's to-do list, one checklist per list. Both are kept whether or not iCloud syncs them. Ghost injects and indexes none of it; look things up whenever a task needs them, from the first turn on.",
    r"Known names or terms: `rg -n -i '<term>'` in `Notes` and `Reminders`, widening to the whole directory only if that finds nothing.",
    r"Unknown wording or location: search by meaning with Recall through its `recall` skill (`ghost help products` gets it, with the owner's go-ahead); without it, use filenames and `rg`. Read the passages of the few relevant hits, then the source file itself before relying on one: an index can be stale.",
    r"Conflicting notes: read the current files; the source evidence settles it, then fix the stale note rather than adding another. If neither does, keep both claims and tell the owner which is uncertain; never pick one arbitrarily.",
    r"Never preload the directory, read it wholesale, or keep an index or memory store of your own. A Recall index over folders the owner chose, the whole directory included, is theirs to search.",
    r"Keeping them current is your job, unasked: notes are your state, not an archive. Before a task, read the note that covers it. In the same turn that the owner tells you something new, a task advances or ends, or you find a note wrong, update that note: rewrite the stale line in place; record a decision, correction, or dead end (what was tried, why it failed); start a note only when none covers it. Say which notes you changed.",
    r"Reminders are for the owner, not for you: what you need them to do (a decision you are waiting on, a sign-in, a payment, a call) is one line in `Reminders/<List>.md`, `- [ ] text 📅 YYYY-MM-DD` (indented lines under it are its notes); a new file is a new list. Add it in the turn you find you need it, and say so; tick `- [x]` what they tell you is done. You need no reminder yourself: your own pending work goes in the note, and work for a later time is a timer (`ghost help background`).",
    r#"Tidying as you go, unasked: when the notes on the subject at hand repeat or contradict each other, merge them into the one that covers it, keeping every claim and dead end (settle conflicts as above) and cutting repetition without changing meaning. Before merging or rewriting a note, keep its original restorable: `cp -p "$f" "$f~" && gio trash "$f~"`. Trash with `gio trash`, never `rm`, only an empty note or a duplicate you merged. A whole folder is yours to tidy too, unasked: when one you are working in has grown cluttered, tidy it once the task at hand is done, or set a timer for it (`ghost help background`). That is the one time you read a folder whole, one folder per pass. Report each changed and trashed path."#,
    r"A workflow you finished and will repeat is a note too: save its steps, commands, and pitfalls as a how-to.",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help_guides::products;

    fn topic(name: &str) -> String {
        render_help_topic(name).expect("a topic")
    }

    #[test]
    fn products_tables_every_product_but_ghost_and_each_section_it_points_at_exists() {
        let text = topic("products");
        for product in products() {
            if product.host {
                assert!(!text.contains(&format!("[{}](", product.name)), "{}", product.name);
                continue;
            }
            assert!(text.contains(&format!("[{}]({})", product.name, product.source)), "{}", product.name);
            assert!(product.install.is_some() || product.section.is_some(), "{}", product.name);
            if let Some(section) = &product.section {
                assert!(text.contains(&format!("\n## {section}\n")), "{}", product.name);
            }
        }
        // One row as the table renders it: a skill named apart from its CLI, an install command and a note.
        assert!(text.contains(
            "| Apple Notes, Reminders, Photos and Find My as native apps and iCloud Drive as a synced folder, on one iCloud sign in | [iCloud for Omarchy](https://github.com/ferdousbhai/icloud-for-omarchy) (`icloud-session`, skill `icloud`) | `curl -fsSL https://ferdousbhai.com/icloud/install.sh \\| sudo bash`; it also installs Cloudmail, Cloud Calendar and Cloud Contacts, with one sign in for all; [one app alone](https://ferdousbhai.com/icloud#notes) |\n"
        ));
        assert!(text.contains(
            "| AirDrop with nearby Apple devices | [Omdrop](https://github.com/brentkearney/omdrop-plugin) (`omdrop`) | see Omdrop below |\n"
        ));
    }

    #[test]
    fn knows_its_topics() {
        assert_eq!(HELP_TOPICS, ["self", "background", "memory", "browser", "products"]);
        assert!(is_help_topic("self"));
        assert!(!is_help_topic("status"));
        assert_eq!(render_help_topic("status"), None);
        for name in HELP_TOPICS {
            let text = topic(name);
            assert!(text.starts_with("# ") && text.ends_with('\n') && !text.ends_with("\n\n"), "{name}");
        }
    }

    #[test]
    fn self_follows_repository_rules_and_restarts_without_a_model_prompt() {
        let text = topic("self");
        for kept in
            ["AGENTS.md and CONTRACTS.md", "preserve other sessions' edits", "systemctl --user restart ghostd.service", "journalctl --user -t ghostd"]
        {
            assert!(text.contains(kept), "{kept}");
        }
        for gone in ["ghost say", "git restore", "branch from upstream master"] {
            assert!(!text.contains(gone), "{gone}");
        }
    }

    #[test]
    fn background_is_the_detached_recipe_that_wakes_the_conversation() {
        let text = topic("background");
        for kept in [
            "systemd-run --user --scope --quiet --unit=\"ghost-job-<name>-$(date +%s)\" -p CPUWeight=20",
            "setsid -f bash -c",
            "$XDG_RUNTIME_DIR/<name>.log",
            "`systemctl --user stop <unit>` ends it",
            "ghost say --follow-up",
            "`$GHOST_SESSION` is set",
            "A command you start ends when this turn does.",
            "--on-calendar='YYYY-MM-DD HH:MM' --unit=\"ghost-later-<name>-$(date +%s)\"",
            "ghost say --follow-up -q -s \"$GHOST_SESSION\"",
            "`systemctl --user stop <unit>.timer` cancels one",
            "A timer is forgotten by a reboot or a logout",
            "`omarchy reminder <minutes> \"<text>\"`",
        ] {
            assert!(text.contains(kept), "{kept}");
        }
        assert!(!text.contains("/tmp/job.log"));
    }

    #[test]
    fn memory_is_exact_search_first_recall_for_unknown_wording_and_the_source_file_over_any_index() {
        let text = topic("memory");
        for kept in [
            "`rg -n -i '<term>'` in `Notes` and `Reminders`",
            "Both are kept whether or not iCloud syncs them",
            "`Reminders/<List>.md`, `- [ ] text 📅 YYYY-MM-DD`",
            "Recall through its `recall` skill",
            "without it, use filenames and `rg`",
            "then the source file itself before relying on one",
            "whenever a task needs them, from the first turn on",
            "keep both claims and tell the owner which is uncertain",
            "dead end (what was tried, why it failed)",
            "notes are your state, not an archive",
            "In the same turn that the owner tells you something new, a task advances or ends",
            "rewrite the stale line in place; record a decision",
            "Say which notes you changed.",
            "Tidying as you go, unasked",
            "A whole folder is yours to tidy too, unasked",
            "That is the one time you read a folder whole, one folder per pass.",
            "Trash with `gio trash`, never `rm`",
            "keep its original restorable: `cp -p \"$f\" \"$f~\" && gio trash \"$f~\"`",
            "only an empty note or a duplicate you merged.",
            "Report each changed and trashed path.",
            "Never preload the directory, read it wholesale, or keep an index or memory store of your own",
            "A Recall index over folders the owner chose, the whole directory included, is theirs to search",
            "save its steps, commands, and pitfalls as a how-to",
        ] {
            assert!(text.contains(kept), "{kept}");
        }
        assert!(!text.contains("SKILL.md"));
    }

    /// The browser recipe's shell functions, run for real against a stand-in
    /// `agent-browser`: two tasks sharing the owner session select their tab
    /// and act under one lock, and a missing tab fails closed.
    #[test]
    fn browser_shared_owner_session_selects_and_acts_atomically_and_missing_tabs_fail_closed() {
        use crate::abort::Abort;
        use crate::process::run_command;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("ghost-browser-recipe-{}", crate::random::uuid()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let stub = bin.join("agent-browser");
        std::fs::write(
            &stub,
            r#"#!/bin/bash
set -eu
[[ ! -e /proc/$$/fd/9 ]]
[[ "$1 $2 $3 $4 $5" == "--session owner --cdp 9222 --pin-tab" ]]
shift 5
if [[ "$1" == tab ]]; then
  [[ "$2" != missing ]] || exit 7
  printf '%s' "$2" > "$XDG_RUNTIME_DIR/active"
  sleep 0.01
else
  sleep 0.01
  printf '%s:%s\n' "$BROWSER_TAB" "$(cat "$XDG_RUNTIME_DIR/active")" >> "$XDG_RUNTIME_DIR/actions"
fi
"#,
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let text = topic("browser");
        let from = text.find("```sh\n").expect("the recipe's fence") + "```sh\n".len();
        let recipe = &text[from..from + text[from..].find("\n```").expect("the fence's end")];
        let script = format!("{recipe}\nexport BROWSER_TAB=\"$TEST_TAB\"\nfor i in {{1..5}}; do browser fill '#email' \"$TEST_TAB\" || exit; done");
        let run = |tab: &str| {
            let env: crate::env::Env =
                [("PATH", format!("{}:/usr/bin:/bin", bin.display())), ("XDG_RUNTIME_DIR", dir.display().to_string()), ("TEST_TAB", tab.to_string())]
                    .into_iter()
                    .map(|(name, value)| (name.to_string(), value))
                    .collect();
            run_command("bash", &["-c", &script], &env, None, Duration::from_secs(60), &Abort::new()).expect("bash runs")
        };
        std::thread::scope(|scope| {
            let a = scope.spawn(|| run("a"));
            let b = scope.spawn(|| run("b"));
            assert_eq!((a.join().unwrap().code, b.join().unwrap().code), (0, 0));
        });
        let actions = || std::fs::read_to_string(dir.join("actions")).unwrap();
        let lines: Vec<String> = actions().trim().split('\n').map(str::to_string).collect();
        assert_eq!(lines.len(), 10);
        assert!(lines.iter().all(|line| line == "a:a" || line == "b:b"), "{lines:?}");
        assert_eq!(run("missing").code, 7);
        assert_eq!(actions().trim().split('\n').count(), 10);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
