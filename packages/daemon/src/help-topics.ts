/**
 * The long recipes a ghost needs only when it does one particular thing:
 * writing a timer, editing or restarting itself, handing work to another
 * harness, finding a note, transcribing audio. The system prompt points at
 * them by name and `ghost help <topic>` prints them, so their cost lands on the turn that needs them and not on
 * every turn of every ghost. The text is still contract text the ghost acts
 * on: keep it exact, and keep the prompt's pointer sentences in step.
 */
import { MAX_SCHEDULE_SLUG_LENGTH, scheduleUnitPrefix } from "./schedules.js";

export const HELP_TOPICS = ["timers", "self", "harnesses", "background", "memory", "dictation"] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export interface HelpTopicInput {
  readonly ghostName: string;
  /** Where the ghost's systemd user units go. */
  readonly unitDir: string;
  /** The `ghost` executable a unit may exec. */
  readonly cliPath: string;
}

export function isHelpTopic(value: string): value is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(value);
}

function timers(input: HelpTopicInput): string[] {
  const unit = `${scheduleUnitPrefix(input.ghostName)}<slug>`;
  return [
    "# Timers",
    "Clock work is a systemd user timer: a text file the owner can edit and stop with `systemctl --user disable --now`. Ghost has no scheduler.",
    `Write both units in ${JSON.stringify(input.unitDir)}, named \`${unit}\`, \`<slug>\` 1–${MAX_SCHEDULE_SLUG_LENGTH} characters matching \`[a-z0-9]+(?:-[a-z0-9]+)*\`; that versioned prefix is what is swept when your ghost is deleted or renamed, nothing else.`,
    "The `ghost` CLI authenticates itself:",
    "```ini",
    `# ${unit}.service`,
    "[Service]",
    "Type=oneshot",
    "# Or the turn is SIGTERMed after ~90s, mid-answer.",
    "TimeoutStartSec=infinity",
    `ExecStart=${input.cliPath} say --new --ghost ${input.ghostName} "<the prompt>"`,
    "```",
    "```ini",
    `# ${unit}.timer`,
    "[Timer]",
    "OnCalendar=Mon..Fri 09:00 America/New_York",
    "# Catch up after sleep or downtime.",
    "Persistent=true",
    "[Install]",
    "WantedBy=timers.target",
    "```",
    "`Persistent=true` runs one catch-up however many slots were missed; `Persistent=false` drops them. Running every missed slot is not a timer primitive; the service would have to track its own watermark.",
    "Then `systemctl --user daemon-reload && systemctl --user enable --now <unit>.timer`; confirm with `systemctl --user list-timers`.",
    "Timers fire only while the owner is logged in (the daemon runs in their graphical session).",
  ];
}

function self(): string[] {
  return [
    "# Self-maintenance",
    "Read the checkout's AGENTS.md and CONTRACTS.md; follow its authorized branch, commit, and push workflow. Edit, test the affected package, typecheck, commit with the reason, build, and restart.",
    "Commit your own changes; preserve other sessions' edits. Never restore, stash, or discard changes you did not make.",
    "The checkout is shared by every ghost. CONTRIBUTING.md describes upstream contributions; the owner's instructions decide whether to push directly or open a PR.",
    "To restart yourself, finish the turn and tell the owner first; a restart aborts every running turn:",
    "```sh",
    'systemd-run --user --on-active=5 --unit="ghost-restart-$(date +%s)" \\',
    '  --description="<reason>" \\',
    "  systemctl --user restart ghostd.service",
    "```",
    "The transient unit survives the daemon. Verify afterward with `ghost status` and `journalctl --user -t ghostd`; restart never sends a model prompt.",
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
    "`ghost delegate` gives claude and codex runs your desktop tools; browser automation uses agent-browser through Bash.",
    "When the owner named the harness (\"have codex do it\"), pass `--owner-named` before it: `ghost delegate --owner-named codex -- exec \"<task>\"`. The receipts record who picked.",
    "Your own turns run on one of these agents too. `ghost harness` shows which this ghost prefers; `ghost harness <agent>` sets it (`--none`: automatic); `ghost switch <agent>` runs this conversation's next turn on another agent, handed the conversation so far. Do either only when the owner asks.",
    "When a run stops on a limit, write a handoff note in the owner's documents (done, verified, exact next step) and continue on another harness or after the reset. Never spend a window you were not asked to spend.",
    "",
    "## Long-lived sessions in herdr",
    "When the owner wants a harness to keep running interactively (to watch, steer, or resume after a restart), run it in herdr instead, after `ghost harnesses` confirms it is installed. Use your own session, never the owner's: every command takes `--session ghost`. If `herdr session list` does not show it running, start it with `systemd-run --user --unit=herdr-ghost herdr --session ghost server`; a fresh server resumes the agents it had.",
    "Install only harnesses the owner names, with `mise use -g <harness>` (mise registry names: claude, codex, grok, muse, pi, omp, opencode, crush, copilot, cursor-agent). Each uses the owner's own account: start it, ask the owner to sign in, and never read, type, or store a credential. Then `herdr integration install <harness>` lets herdr resume it; tell the owner you did.",
    "`herdr --session ghost workspace create --cwd <project-dir> --label <label>` returns a root pane; `herdr --session ghost agent start <name> --kind <harness> --pane <id>` starts the harness there; `agent prompt <name> \"<task>\"` hands it work. Confirm submission and read results with `agent read <name> --source recent-unwrapped`: `--wait` alone is not proof. `blocked` means it is asking something: read it, and ask the owner unless the answer is plainly within the task they gave. `agent send-keys <name> ctrl+c` stops it. To be woken when it settles, detach `herdr --session ghost agent wait <name>` with the `ghost help background` recipe. The owner can watch with `herdr session attach ghost`.",
  ];
}

function background(): string[] {
  return [
    "# Background work",
    "Your harness's own background jobs end when this turn's headless run does. Work that must outlive the turn runs detached, logs to a file, and wakes you when it ends:",
    "```sh",
    "setsid -f bash -c 'cmd > /tmp/job.log 2>&1; ghost say --follow-up -q \"Background job finished (exit $?), log /tmp/job.log\" >/dev/null 2>&1'",
    "```",
    "`$GHOST` and `$GHOST_SESSION` are set in your shell, so `ghost` verbs address this conversation without `-g`/`-s`. `--follow-up` runs after your current turn, or starts your next one when the conversation is idle.",
    "Nothing else watches the job: read its log, and keep its PID if you may need to stop it.",
  ];
}

function memory(): string[] {
  return [
    "# Memory",
    "Your durable memory is the owner's documents directory (Owner context): Markdown in its existing project and topic folders, with `board.md` at its root. Ghost injects and indexes none of it; look things up whenever a task needs them, from the first turn on.",
    "Known names or terms: guess the folder from its name, then `rg -n -i '<term>' <folder>`, widening to the whole directory only if that finds nothing.",
    "Unknown wording or location: search by meaning with Recall through its `recall` skill (the `ghost-products` skill gets it, with the owner's go-ahead); without it, use filenames and `rg`. Read the passages of the few relevant hits, then the source file itself before relying on one: an index can be stale.",
    "Conflicting notes: read the current files; a later dated correction or the source evidence settles it, then fix the stale note rather than adding another. If neither does, keep both claims and tell the owner which is uncertain; never pick one arbitrarily.",
    "Never preload the directory, read it wholesale, or keep an index or memory store of your own. A Recall index over folders the owner chose, the whole directory included, is theirs to search.",
    "Saving: put a stable fact, decision, correction, or dead end (what was tried, why it failed) in the existing folder it belongs to, updating the note that covers it and dating what you add; start a folder only for a new project or topic.",
    "Tidying, only when the owner asks or a timer they approved runs it, is the one time you read a folder whole: one folder per pass, the one the owner named or else the most cluttered. Merge notes on one subject into the one that covers it, keeping every dated claim and dead end; rewrite superseded facts as what is current (settle conflicts as above); cut repetition without changing meaning. Trash with `gio trash`, never `rm`, only an empty note, a duplicate you merged, or a finished task. Then report each merged, rewritten, and trashed path.",
    "A recurring tidy is a daily timer (`ghost help timers`, `OnCalendar=daily`) whose prompt is `Tidy my notes (ghost help memory).`: when the owner has none, offer one once; never install it unasked.",
    "A workflow you finished and will repeat (its steps, commands, and pitfalls) is a skill, not a note: write `skills/<name>/SKILL.md`, with `name` and `description` frontmatter, beside your character file; it is available from your next turn.",
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
    "The HUD composer starts, stops, and cancels the owner's dictation (`voxtype record start|stop|cancel`; Esc cancels). Only when the owner asks, turn spoken \"submit\" on with `voxtype config set text.smart_auto_submit true` or off with `voxtype config set text.smart_auto_submit false`, then `systemctl --user restart voxtype`.",
  ];
}

/** One topic's text, as `ghost help <topic>` prints it. */
export function renderHelpTopic(topic: HelpTopic, input: HelpTopicInput): string {
  const lines = { timers: () => timers(input), self, harnesses, background, memory, dictation }[topic]();
  return `${lines.join("\n")}\n`;
}
