import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { ProjectDeclarativeSnapshot } from "./project-resources.js";

export const OMARCHY_COMPUTER_USE_POLICY = [
  "## Computer use",
  "For laptop, shell, and Omarchy-system actions, first inspect `omarchy commands --json` or the relevant `omarchy <group> --help`, then use the stable `omarchy <group> <action>` route through Bash.",
  "Use `ghost_desktop` and `ghost_screen` only when Omarchy has no route, a tried CLI route fails, or the task must manipulate content inside an arbitrary application. Use `ghost_browser` for browser pages.",
].join("\n");

/**
 * Where finished work goes. A ghost's `docs/` is its own notebook; a file it
 * authored *for the owner* is a write-once artifact and belongs in the owner's
 * tree, the same rule screenshots already follow.
 */
export const OWNER_DELIVERABLE_POLICY = [
  "## Finished work",
  "A file you write for the owner — a report, an export, a generated image — goes in their Documents tree or the working directory you were asked about, not in your own `docs/`.",
  "Your `docs/` is your notebook: what you wrote for yourself. Documents are the owner's, shared with them and with every other ghost, so leaving deliverables in `docs/` hides them from the person who asked.",
].join("\n");

/**
 * How a ghost gives itself a schedule. Deliberately a prompt section rather than
 * a daemon API: the unit file is the whole record, so the ghost writes one the
 * way any Arch user would, and the owner reads, disables, and edits it with
 * `systemctl`. Ghost owns only the naming, so a deleted ghost's timers can be
 * found and swept.
 */
export const SCHEDULED_WORK_POLICY = [
  "## Scheduled work",
  "To do something on a clock, write a systemd **user timer** through Bash — Ghost has no scheduler of its own, and a timer is something the owner can see in `systemctl --user list-timers`, stop with `systemctl --user disable --now`, and edit in a text file.",
  "Name both units `ghost-timer-<your-ghost-name>-<slug>` in `~/.config/systemd/user/`. That exact prefix is how your timers are found and removed if your ghost is deleted; a differently named unit is left behind forever.",
  "The service runs the `ghost` CLI, which authenticates itself:",
  "```ini",
  "# ghost-timer-<ghost>-<slug>.service",
  "[Service]",
  "Type=oneshot",
  "# Without this the turn is SIGTERMed after ~90s and dies mid-answer.",
  "TimeoutStartSec=infinity",
  "ExecStart=/usr/bin/ghost say --new --ghost <ghost> \"<the prompt>\"",
  "```",
  "```ini",
  "# ghost-timer-<ghost>-<slug>.timer",
  "[Timer]",
  "OnCalendar=Mon..Fri 09:00 America/New_York",
  "# Catch up after the laptop was asleep or off at the scheduled moment.",
  "Persistent=true",
  "[Install]",
  "WantedBy=timers.target",
  "```",
  "Then `systemctl --user daemon-reload && systemctl --user enable --now <unit>.timer`, and confirm with `systemctl --user list-timers`.",
  "Timers only fire while the owner is logged in, because the daemon runs with their graphical session. Do not promise check-ins overnight or while they are away.",
].join("\n");

export interface MachineSkillOptions {
  /** Complete path override shared with pi's native resource loader. */
  paths?: readonly string[];
}

/** The standard owner-trusted machine roots shared by agent skill installers. */
export function machineSkillPaths(
  ownerHome: string,
  options: MachineSkillOptions = {},
): string[] {
  if (options.paths) return [...options.paths];
  return [
    join(ownerHome, ".agents", "skills"),
    join(ownerHome, ".pi", "agent", "skills"),
  ];
}

function diagnosticMessage(diagnostic: ReturnType<typeof loadSkills>["diagnostics"][number]): string {
  return [diagnostic.path, diagnostic.message].filter(Boolean).join(": ");
}

/** Snapshot every skill pi admits from the owner-trusted machine paths. */
export async function loadMachineSkills(
  ownerHome: string,
  options: MachineSkillOptions = {},
): Promise<ProjectDeclarativeSnapshot | null> {
  const paths = machineSkillPaths(ownerHome, options).filter((path) => existsSync(path));
  if (paths.length === 0) return null;
  const loaded = loadSkills({
    cwd: ownerHome,
    agentDir: join(ownerHome, ".pi", "agent"),
    skillPaths: paths,
    includeDefaults: false,
  });
  const warnings = loaded.diagnostics.map(diagnosticMessage);
  const skills = loaded.skills.flatMap((skill) => {
    try {
      return [{
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        source: "via Ghost machine",
        snapshotContent: readFileSync(skill.filePath, "utf8"),
        hide: skill.disableModelInvocation,
        _source: {
          provider: "ghost-machine",
          providerName: "Ghost machine",
          path: skill.filePath,
          level: "native" as const,
        },
      }];
    } catch (error) {
      warnings.push(`${skill.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  if (skills.length === 0) return null;
  return {
    contextFiles: [],
    skills,
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    mcp: { claimedNames: [], servers: [], skipped: [] },
    mcpWarnings: [],
    resources: {
      instructions: 0,
      skills: skills.length,
      rules: 0,
      prompts: 0,
      commands: 0,
      agents: 0,
      mcpServers: 0,
      ignoredExecutable: 0,
    },
    warnings,
    truncated: false,
  };
}
