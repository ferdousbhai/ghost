/**
 * The long recipes a ghost needs only when it does one particular thing:
 * writing a timer, editing or restarting itself, handing work to another
 * harness. The system prompt points at them by name and `ghost help <topic>`
 * prints them, so their cost lands on the turn that needs them and not on
 * every turn of every ghost. The text is still contract text the ghost acts
 * on: keep it exact, and keep the prompt's pointer sentences in step.
 */
import { MAX_SCHEDULE_SLUG_LENGTH, scheduleUnitPrefix } from "./schedules.js";

export const HELP_TOPICS = ["timers", "self", "harnesses"] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export interface HelpTopicInput {
  readonly ghostName: string;
  /** Where the ghost's systemd user units go. */
  readonly unitDir: string;
  /** The `ghost` executable a unit may exec. */
  readonly cliPath: string;
  /** The conversation a restart should wake, when known. */
  readonly sessionId?: string;
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

function self(input: HelpTopicInput): string[] {
  const session = input.sessionId === undefined ? "" : ` --session ${input.sessionId}`;
  return [
    "# Self-maintenance",
    "The loop: `git fetch`, branch from upstream master, edit, run the touched package's tests and `typecheck`, commit with the reason, `pnpm build`, restart. This is your own Bash, not a delegated task: no worktrees or task branches.",
    "Your own directory, the one your character file lives in, is yours alone; `packages/` and `CONTRACTS.md` are every ghost's. When your work there would help every owner (a bug fixed, a real efficiency gain, a policy line that proved wrong), consider offering it upstream via `CONTRIBUTING.md` in the checkout; the PR goes out under the owner's GitHub account, so show them the branch and ask before you push.",
    "To restart yourself, finish the turn and tell the owner first; the daemon drains for 5 seconds, then forces:",
    "```sh",
    'systemd-run --user --on-active=5 --unit="ghost-restart-$(date +%s)" \\',
    '  --description="<reason>" \\',
    "  sh -c 'systemctl --user restart ghostd.service; \\",
    "         for i in $(seq 30); do ghost status -q >/dev/null 2>&1 && break; sleep 1; done; \\",
    `         ghost say --ghost ${input.ghostName}${session} "You restarted ghostd for: <reason>. Check journalctl --user -t ghostd and report."'`,
    "```",
    "The timestamped unit name keeps two restarts apart, the wait loop covers the daemon not yet listening, and the transient unit survives the restart because it is not your child.",
    ...(input.sessionId === undefined
      ? ["Without a session id the wake lands in your latest conversation."]
      : []),
    "A HUD change needs `systemctl --user restart ghost-shell.service`; reloading that unit refetches daemon data, it does not reload QML.",
    "`ghost status` names a newer Ghost release and the exact command that installs it here; tell the owner, and run it only when they ask.",
    "History: `git log` in the checkout for what the code did, `journalctl --user -t ghostd` for what the daemon did, your transcript for why; read them before retrying a failed change.",
    "Undo: `git revert` plus a restart for code, Trash for a deleted ghost home, `omarchy-snapshot` or snapper for the system. Never `rm -rf` a checkout.",
  ];
}

function harnesses(): string[] {
  return [
    "# Other harnesses",
    "Claude Code, Codex, pi, omp, and the other agent CLIs Omarchy installs run from Bash (`claude -p`, `codex`, `pi`, `omp`), each with the owner's own settings, auth, and tools.",
    "Before handing work to one, read its session and weekly windows in `~/.local/state/omarchy/agents/usage/<agent>.json` (`$XDG_STATE_HOME` replaces `~/.local/state` when set; each `limits[]` entry carries a label, `percent` as a 0–1 fraction used, and `resetsAt`; `omarchy agent usage-update` refreshes) and prefer the harness with room.",
    "When a run stops on a limit, write a handoff note in the owner's documents (done, verified, exact next step) and continue on another harness or after the reset. Never spend a window you were not asked to spend.",
  ];
}

/** One topic's text, as `ghost help <topic>` prints it. */
export function renderHelpTopic(topic: HelpTopic, input: HelpTopicInput): string {
  const lines = topic === "timers" ? timers(input) : topic === "self" ? self(input) : harnesses();
  return `${lines.join("\n")}\n`;
}
