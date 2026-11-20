/**
 * The long recipes a ghost needs only when it does one particular thing:
 * editing or restarting itself, handing work to another
 * harness, finding a note, transcribing audio. The prompt's Ghost section
 * indexes them by name and `ghost help <topic>` prints them, so their cost
 * lands on the turn that needs them and not on every turn. The
 * text is still contract text the ghost acts on: keep it exact, and keep the
 * index in step (prompt-policy.test.ts checks).
 */
import { BROWSER_LINES, productsLines } from "./help-guides.js";

export const HELP_TOPICS = ["self", "harnesses", "background", "memory", "dictation", "notifications", "browser", "products"] as const;
type HelpTopic = (typeof HELP_TOPICS)[number];

export function isHelpTopic(value: string): value is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(value);
}

function self(): string[] {
  return [
    "# Self-maintenance",
    "Any part of your code is yours to change to fit the owner. `ghost status` says whether the daemon runs from the package (which you cannot write) or a checkout. From a packaged install, first run yourself from your own clone: `git clone https://github.com/ferdousbhai/ghost ~/src/ghost`, then `pnpm install && pnpm build` in it (without pnpm, run `omarchy-launch-floating-terminal-with-presentation 'omarchy-pkg-add pnpm'` alone in the foreground and the owner types their password there), then switch over as /usr/share/doc/ghost/docs/self-maintenance.md shows; its \"Back to the package\" undoes it. Tell the owner before you switch.",
    "Read the checkout's AGENTS.md and CONTRACTS.md; follow its authorized branch, commit, and push workflow. Edit, test the affected package, typecheck, commit with the reason, build, and restart.",
    "Commit your own changes; preserve other sessions' edits. Never restore, stash, or discard changes you did not make.",
    "CONTRIBUTING.md describes upstream contributions; the owner's instructions decide whether to push directly or open a PR.",
    "To restart yourself, finish the turn and tell the owner first; a restart aborts every running turn:",
    "```sh",
    'systemd-run --user --on-active=5 --unit="ghost-restart-$(date +%s)" \\',
    '  --description="<reason>" \\',
    "  systemctl --user restart ghostd.service",
    "```",
    "The transient unit survives the daemon. Verify afterward with `ghost status` (no `restart needed` line) and `journalctl --user -t ghostd`; a restart sends no model prompt.",
    "A HUD change needs `omarchy-restart-shell`: the HUD is an omarchy-shell plugin, not a unit of yours, and a rescan leaves QML the shell already loaded in place.",
    "Omarchy owns package updates; update a checkout only when the owner asks.",
    "History: `git log` in the checkout for what the code did, `journalctl --user -t ghostd` for what the daemon did, your transcript for why; read them before retrying a failed change.",
    "Undo: `git revert` plus a restart for code, Trash for a deleted ghost home, `omarchy-snapshot` or snapper for the system. Never `rm -rf` a checkout.",
  ];
}

function harnesses(): string[] {
  return [
    "# Other harnesses",
    "Your turns run in this conversation's own directory, which holds only Ghost's files; no project's instructions, settings, or MCP servers load into them. Hand a task to an agent run in the project only when it needs those; otherwise do it yourself.",
    "Claude Code, Codex, pi, omp, and the other agent CLIs Omarchy installs run from Bash (`claude -p`, `codex`, `pi`, `omp`), each with the owner's own settings, auth, and tools.",
    "Run each handoff with the project directory as its cwd, `cd <project-dir> && ghost delegate <harness> -- <args>` (e.g. `ghost delegate claude -- -p \"<task>\"`), so the headless harness respects that project's settings exactly as the owner running it there by hand.",
    "`claude -p` edits files only with `--permission-mode acceptEdits` and runs commands (tests) only with `--allowedTools Bash`; put the task right after `-p`, since `--allowedTools`, `--add-dir`, and other list flags would swallow a task after them.",
    "`ghost delegate` refuses an uninstalled harness (exit 5), else runs it here, streams its output, and exits with its status. `ghost harnesses` lists installed agents and informational usage. Every attempt is recorded for the owner.",
    "Browser automation uses agent-browser through Bash.",
    "When the owner named the harness (\"have codex do it\"), pass `--owner-named` before it: `ghost delegate --owner-named codex -- exec \"<task>\"`. The receipts record who picked.",
    "Your own turns run on one of these agents too. `ghost harness` shows which this ghost prefers; `ghost harness <agent>` sets it (`--none`: automatic); `ghost switch <agent>` runs this conversation's next turn on another agent, handed the conversation so far. Do either only when the owner asks.",
    "When a run stops on a limit, write a handoff note in the owner's documents (done, verified, exact next step) and continue on another harness or after the reset. Never spend a window you were not asked to spend.",
    "",
    "## Long-lived sessions in herdr",
    "When the owner wants a harness to keep running interactively (to watch, steer, or resume after a restart), run it in herdr instead, after `ghost harnesses` confirms it is installed. Use your own session, never the owner's: every command takes `--session ghost`. If `herdr session list` does not show it running, start it with `systemd-run --user --unit=herdr-ghost herdr --session ghost server`; a fresh server resumes the agents it had.",
    "Install only harnesses the owner names, with `mise use -g <package>`, as `omarchy default agent` installs them (claude, codex, pi, opencode, crush, copilot; `github:can1357/oh-my-pi` for omp, `github:OpenRouterLabs/ori-releases` for ori, `npm:@xai-official/grok` for grok, `antigravity-cli` for agy). Each uses the owner's own account: start it, ask the owner to sign in, and never read, type, or store a credential. Then `herdr integration install <harness>` lets herdr resume it; tell the owner you did.",
    "`herdr --session ghost workspace create --cwd <project-dir> --label <label>` returns a root pane; `herdr --session ghost agent start <name> --kind <harness> --pane <id>` starts the harness there; `agent prompt <name> \"<task>\"` hands it work. Confirm submission and read results with `agent read <name> --source recent-unwrapped`: `--wait` alone is not proof. `blocked` means it is asking something: read it, and ask the owner unless the answer is plainly within the task they gave. `agent send-keys <name> ctrl+c` stops it. To be woken when it settles, detach `herdr --session ghost agent wait <name>` with the `ghost help background` recipe. The owner can watch with `herdr session attach ghost`.",
  ];
}

function background(): string[] {
  return [
    "# Background work",
    "Your harness's own background jobs end when this turn's headless run does. Work that must outlive the turn runs detached, logs to a file, and wakes you when it ends:",
    "```sh",
    "systemd-run --user --scope --quiet --unit=\"ghost-job-<name>-$(date +%s)\" -p CPUWeight=20 \\",
    "  setsid -f bash -c 'cmd > \"$XDG_RUNTIME_DIR/<name>.log\" 2>&1; ghost say --follow-up -q \"Background job finished (exit $?), log $XDG_RUNTIME_DIR/<name>.log\" >/dev/null 2>&1'",
    "```",
    "`$GHOST` and `$GHOST_SESSION` are set in your shell, so `ghost` verbs address this conversation without `-s`. `--follow-up` runs after your current turn, or starts your next one when the conversation is idle.",
    "The job is its own low-priority unit: it yields the CPU to the owner's apps, survives a daemon restart (so its log is outside your private /tmp), and `systemctl --user stop <unit>` ends it. Nothing else watches it: read its log.",
  ];
}

function memory(): string[] {
  return [
    "# Memory",
    "Your durable memory is the `Notes` and `Reminders` folders of the owner's documents directory (Owner context): Markdown notes, and one checklist per list. They are yours to keep whether or not iCloud syncs them. Ghost injects and indexes none of it; look things up whenever a task needs them, from the first turn on.",
    "Known names or terms: `rg -n -i '<term>'` in `Notes` and `Reminders`, widening to the whole directory only if that finds nothing.",
    "Unknown wording or location: search by meaning with Recall through its `recall` skill (`ghost help products` gets it, with the owner's go-ahead); without it, use filenames and `rg`. Read the passages of the few relevant hits, then the source file itself before relying on one: an index can be stale.",
    "Conflicting notes: read the current files; a later dated correction or the source evidence settles it, then fix the stale note rather than adding another. If neither does, keep both claims and tell the owner which is uncertain; never pick one arbitrarily.",
    "Never preload the directory, read it wholesale, or keep an index or memory store of your own. A Recall index over folders the owner chose, the whole directory included, is theirs to search.",
    "Saving: put a stable fact, decision, correction, or dead end (what was tried, why it failed) in the note under `Notes` that covers it, dating what you add; start a note only when none does. A thing to do is one line in `Reminders/<List>.md`, `- [ ] text 📅 YYYY-MM-DD` (indented lines under it are its notes), ticked `- [x]` when done; a new file is a new list.",
    "Tidying, only when the owner asks, is the one time you read a folder whole: one folder per pass, the one the owner named or else the most cluttered. Before changing a note, keep its original restorable: `cp -p \"$f\" \"$f~\" && gio trash \"$f~\"`. Merge notes on one subject into the one that covers it, keeping every dated claim and dead end; mark a superseded fact with what replaced it and when (settle conflicts as above); cut repetition without changing meaning. Trash with `gio trash`, never `rm`, only an empty note or a duplicate you merged. Then report each changed and trashed path.",
    "A workflow you finished and will repeat is a note too: save its steps, commands, and pitfalls as a how-to.",
  ];
}

function notifications(): string[] {
  return [
    "# Mobile completion notifications",
    "Delivery is opt-in: an existing notification service receives a turn_end command hook. Ghost runs locally; host sleep, lost connectivity, or delivery failure can lose an alert. There is no retry queue. The summonghost.com app need not stay open.",
    "For ntfy, subscribe the phone app to your chosen private topic on an existing server. Follow https://docs.ntfy.sh/publish/ for authentication. Keep the server's root URL (not the topic URL; the JSON body names the topic) and Authorization header in a mode-600 curl config at ~/.config/ghost/ntfy.curl; keep credentials out of hooks.json. Test the destination deliberately before enabling alerts.",
    "Create an executable script at an absolute path, replacing YOUR_PRIVATE_TOPIC:",
    "```sh",
    "#!/bin/bash",
    "set -euo pipefail",
    `jq '{topic: "YOUR_PRIVATE_TOPIC", title: (.ghost_name + ": " + .title), message: (.outcome + ": " + .excerpt), click: (.url // "")}' |`,
    '  curl --fail --silent --show-error --connect-timeout 5 --max-time 10 --config "$HOME/.config/ghost/ntfy.curl" -H "Content-Type: application/json" --data-binary @-',
    "```",
    'Add {"hooks":[{"type":"command","command":"/absolute/path/to/script","timeout":15}]} to the hooks.turn_end array of the current document (`ghost hooks show | jq .document > hooks.json`); preserve existing handlers and apply with `ghost hooks set hooks.json`. Remove that handler to opt out; no restart is needed.',
    "Each final successful or failed turn supplies outcome, title, a 280-character excerpt, and the conversation's app link (summonghost.com by default) while remote access is on (otherwise null). Cancelled turns stay quiet. Delivery is awaited within the hook timeout, fails open, and cannot ask for another pass. See /usr/share/doc/ghost/docs/hooks.md (docs/hooks.md in a checkout) for the wire protocol.",
    "The link opens the conversation in the app on a device that has added this machine. Enable remote access with `ghost remote on`; work cannot run while the host is asleep or off.",
  ];
}

function dictation(): string[] {
  return [
    "# Dictation and audio files",
    "Speech is Omarchy's Voxtype (`command -v voxtype`); Ghost adds no speech stack, voice loop, or text-to-speech. Check `voxtype transcribe --help` before relying on a flag.",
    "Transcribe an audio file: `voxtype transcribe` takes 16 kHz mono WAV, so convert anything else first:",
    "```sh",
    "ffmpeg -i <input> -ar 16000 -ac 1 /tmp/<name>.wav",
    "voxtype -q transcribe /tmp/<name>.wav",
    "```",
    "Read the output before using it: not every line is transcript.",
    "The summon prompt starts the owner's dictation when it opens; it and the HUD composer start, stop, and cancel it (`voxtype record start|stop|cancel`; Esc cancels). Only when the owner asks, turn spoken \"submit\" on with `voxtype config set text.smart_auto_submit true` or off with `voxtype config set text.smart_auto_submit false`, then `systemctl --user restart voxtype`.",
  ];
}

/** One topic's text, as `ghost help <topic>` prints it. */
export function renderHelpTopic(topic: HelpTopic): string {
  const lines = { self, harnesses, background, memory, dictation, notifications, browser: () => [...BROWSER_LINES], products: productsLines }[topic]();
  return `${lines.join("\n")}\n`;
}
