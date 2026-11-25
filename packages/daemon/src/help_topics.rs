//! The long recipes a ghost needs only when it does one particular thing:
//! editing or restarting itself, handing work to a coding
//! agent, finding a note, transcribing audio. The prompt's Ghost section
//! indexes them by name and `ghost help <topic>` prints them, so their cost
//! lands on the turn that needs them and not on every turn. The
//! text is still contract text the ghost acts on: keep it exact, and keep the
//! index in step (prompt_policy's tests check).
use crate::help_guides::{BROWSER_LINES, products_lines};

pub const HELP_TOPICS: [&str; 7] = ["self", "background", "memory", "dictation", "notifications", "browser", "products"];

pub fn is_help_topic(value: &str) -> bool {
    HELP_TOPICS.contains(&value)
}

/// One topic's text, as `ghost help <topic>` prints it; None for a name that is not a topic.
pub fn render_help_topic(topic: &str) -> Option<String> {
    let lines = match topic {
        "self" => SELF_LINES.join("\n"),
        "background" => BACKGROUND_LINES.join("\n"),
        "memory" => MEMORY_LINES.join("\n"),
        "dictation" => DICTATION_LINES.join("\n"),
        "notifications" => NOTIFICATIONS_LINES.join("\n"),
        "browser" => BROWSER_LINES.join("\n"),
        "products" => products_lines().join("\n"),
        _ => return None,
    };
    Some(format!("{lines}\n"))
}

const SELF_LINES: &[&str] = &[
    r"# Self-maintenance",
    r#"Any part of your code is yours to change to fit the owner. `ghost status` says whether the daemon runs from the package (which you cannot write) or a checkout. From a packaged install, first run yourself from your own clone: `git clone https://github.com/ferdousbhai/ghost ~/src/ghost`, then `pnpm install && pnpm build` in it (without pnpm, run `omarchy-launch-floating-terminal-with-presentation 'omarchy-pkg-add pnpm'` alone in the foreground and the owner types their password there), then switch over as /usr/share/doc/ghost/docs/self-maintenance.md shows; its "Back to the package" undoes it. Tell the owner before you switch."#,
    r"Read the checkout's AGENTS.md and CONTRACTS.md; follow its authorized branch, commit, and push workflow. Edit, test the affected package, typecheck, commit with the reason, build, and restart.",
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
];

const MEMORY_LINES: &[&str] = &[
    r"# Memory",
    r"Your durable memory is the `Notes` and `Reminders` folders of the owner's documents directory (Owner context): Markdown notes, and one checklist per list. They are yours to keep whether or not iCloud syncs them. Ghost injects and indexes none of it; look things up whenever a task needs them, from the first turn on.",
    r"Known names or terms: `rg -n -i '<term>'` in `Notes` and `Reminders`, widening to the whole directory only if that finds nothing.",
    r"Unknown wording or location: search by meaning with Recall through its `recall` skill (`ghost help products` gets it, with the owner's go-ahead); without it, use filenames and `rg`. Read the passages of the few relevant hits, then the source file itself before relying on one: an index can be stale.",
    r"Conflicting notes: read the current files; a later dated correction or the source evidence settles it, then fix the stale note rather than adding another. If neither does, keep both claims and tell the owner which is uncertain; never pick one arbitrarily.",
    r"Never preload the directory, read it wholesale, or keep an index or memory store of your own. A Recall index over folders the owner chose, the whole directory included, is theirs to search.",
    r"Saving: put a stable fact, decision, correction, or dead end (what was tried, why it failed) in the note under `Notes` that covers it, dating what you add; start a note only when none does. A thing to do is one line in `Reminders/<List>.md`, `- [ ] text 📅 YYYY-MM-DD` (indented lines under it are its notes), ticked `- [x]` when done; a new file is a new list.",
    r#"Tidying, only when the owner asks, is the one time you read a folder whole: one folder per pass, the one the owner named or else the most cluttered. Before changing a note, keep its original restorable: `cp -p "$f" "$f~" && gio trash "$f~"`. Merge notes on one subject into the one that covers it, keeping every dated claim and dead end; mark a superseded fact with what replaced it and when (settle conflicts as above); cut repetition without changing meaning. Trash with `gio trash`, never `rm`, only an empty note or a duplicate you merged. Then report each changed and trashed path."#,
    r"A workflow you finished and will repeat is a note too: save its steps, commands, and pitfalls as a how-to.",
];

const NOTIFICATIONS_LINES: &[&str] = &[
    r"# Mobile completion notifications",
    r"Delivery is opt-in: an existing notification service receives a turn_end command hook. Ghost runs locally; host sleep, lost connectivity, or delivery failure can lose an alert. There is no retry queue. The summonghost.com app need not stay open.",
    r"For ntfy, subscribe the phone app to your chosen private topic on an existing server. Follow https://docs.ntfy.sh/publish/ for authentication. Keep the server's root URL (not the topic URL; the JSON body names the topic) and Authorization header in a mode-600 curl config at ~/.config/ghost/ntfy.curl; keep credentials out of hooks.json. Test the destination deliberately before enabling alerts.",
    r"Create an executable script at an absolute path, replacing YOUR_PRIVATE_TOPIC:",
    r"```sh",
    r"#!/bin/bash",
    r"set -euo pipefail",
    r#"jq '{topic: "YOUR_PRIVATE_TOPIC", title: (.ghost_name + ": " + .title), message: (.outcome + ": " + .excerpt), click: (.url // "")}' |"#,
    r#"  curl --fail --silent --show-error --connect-timeout 5 --max-time 10 --config "$HOME/.config/ghost/ntfy.curl" -H "Content-Type: application/json" --data-binary @-"#,
    r"```",
    r#"Add {"hooks":[{"type":"command","command":"/absolute/path/to/script","timeout":15}]} to the hooks.turn_end array of the current document (`ghost hooks show | jq .document > hooks.json`); preserve existing handlers and apply with `ghost hooks set hooks.json`. Remove that handler to opt out; no restart is needed."#,
    r"Each final successful or failed turn supplies outcome, title, a 280-character excerpt, and the conversation's app link (summonghost.com by default) while remote access is on (otherwise null). Cancelled turns stay quiet. Delivery is awaited within the hook timeout, fails open, and cannot ask for another pass. See /usr/share/doc/ghost/docs/hooks.md (docs/hooks.md in a checkout) for the wire protocol.",
    r"The link opens the conversation in the app on a device that has added this machine. Enable remote access with `ghost remote on`; work cannot run while the host is asleep or off.",
];

const DICTATION_LINES: &[&str] = &[
    r"# Dictation and audio files",
    r"Speech is Omarchy's Voxtype (`command -v voxtype`); Ghost adds no speech stack, voice loop, or text-to-speech. Check `voxtype transcribe --help` before relying on a flag.",
    r"Transcribe an audio file: `voxtype transcribe` takes 16 kHz mono WAV, so convert anything else first:",
    r"```sh",
    r"ffmpeg -i <input> -ar 16000 -ac 1 /tmp/<name>.wav",
    r"voxtype -q transcribe /tmp/<name>.wav",
    r"```",
    r"Read the output before using it: not every line is transcript.",
    r#"Only when the owner asks, turn spoken "submit" on with `voxtype config set text.smart_auto_submit true` or off with `voxtype config set text.smart_auto_submit false`, then `systemctl --user restart voxtype`."#,
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
        assert_eq!(HELP_TOPICS, ["self", "background", "memory", "dictation", "notifications", "browser", "products"]);
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
            "They are yours to keep whether or not iCloud syncs them",
            "`Reminders/<List>.md`, `- [ ] text 📅 YYYY-MM-DD`",
            "Recall through its `recall` skill",
            "without it, use filenames and `rg`",
            "then the source file itself before relying on one",
            "whenever a task needs them, from the first turn on",
            "keep both claims and tell the owner which is uncertain",
            "dead end (what was tried, why it failed)",
            "dating what you add",
            "Tidying, only when the owner asks, is the one time you read a folder whole",
            "Trash with `gio trash`, never `rm`",
            "keep its original restorable: `cp -p \"$f\" \"$f~\" && gio trash \"$f~\"`",
            "mark a superseded fact with what replaced it and when",
            "only an empty note or a duplicate you merged. Then report each changed and trashed path",
            "Never preload the directory, read it wholesale, or keep an index or memory store of your own",
            "A Recall index over folders the owner chose, the whole directory included, is theirs to search",
            "save its steps, commands, and pitfalls as a how-to",
        ] {
            assert!(text.contains(kept), "{kept}");
        }
        assert!(!text.contains("SKILL.md"));
    }

    #[test]
    fn dictation_transcribes_audio_with_the_installed_voxtype_and_toggles_spoken_submit_only_on_request() {
        let text = topic("dictation");
        for kept in [
            "ffmpeg -i <input> -ar 16000 -ac 1 /tmp/<name>.wav",
            "voxtype -q transcribe /tmp/<name>.wav",
            "Read the output before using it",
            "Only when the owner asks",
            "`voxtype config set text.smart_auto_submit true`",
            "`voxtype config set text.smart_auto_submit false`",
            "`systemctl --user restart voxtype`",
        ] {
            assert!(text.contains(kept), "{kept}");
        }
        assert!(!text.contains("Processing"));
        assert!(!text.to_lowercase().contains("video"));
    }

    #[test]
    fn notifications_keeps_the_hook_document_and_the_script_as_written() {
        let text = topic("notifications");
        assert!(text.contains(r#"Add {"hooks":[{"type":"command","command":"/absolute/path/to/script","timeout":15}]} to the hooks.turn_end array"#));
        assert!(text.contains(
            r#"jq '{topic: "YOUR_PRIVATE_TOPIC", title: (.ghost_name + ": " + .title), message: (.outcome + ": " + .excerpt), click: (.url // "")}' |"#
        ));
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
