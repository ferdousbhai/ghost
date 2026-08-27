/**
 * OMP slash-command discovery plus Ghost's headless execution boundary.
 *
 * Catalog composition stays upstream-owned, but file commands come from the
 * conversation's pinned snapshot rather than being rediscovered from live cwd.
 * Execution is deliberately narrower: a builtin must be explicitly admitted
 * here before its OMP text handler runs. A known command that is not admitted
 * is still consumed, so it can never be mistaken for an ordinary model prompt.
 */
import {
  buildAvailableSlashCommands,
  type InternalAvailableSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import {
  BUILTIN_SLASH_COMMANDS_INTERNAL,
  lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

export type GhostCommandAvailability = "available" | "partial" | "unsupported";

export interface GhostAvailableSlashCommand extends InternalAvailableSlashCommand {
  availability: GhostCommandAvailability;
  unavailableReason?: string;
}

const FULLY_AVAILABLE_BUILTINS = new Set(["jobs", "tools", "context", "dirs"]);

const PARTIALLY_AVAILABLE_BUILTINS = new Set([
  "advisor",
  "changelog",
  "extended-context",
  "fast",
  "model",
  "session",
  "todo",
  "usage",
  "vision",
]);

const PARTIAL_INVOCATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  advisor: new Set(["status", "dump", "dump raw"]),
  changelog: new Set(["", "full"]),
  "extended-context": new Set(["status"]),
  fast: new Set(["status"]),
  model: new Set([""]),
  session: new Set(["", "info"]),
  todo: new Set(["", "copy", "help", "?"]),
  usage: new Set(["", "show"]),
  vision: new Set(["status"]),
};

const COMMAND_REASONS: Readonly<Record<string, string>> = {
  browser: "Ghost's browser tools own this surface; OMP browser mode is disabled.",
  computer: "Ghost's desktop tools own this surface; OMP computer use is disabled.",
  memory: "Ghost memory is plain files in this ghost home; OMP memory backends are disabled.",
  mcp: "Use Ghost MCP management; OMP's ambient user/global MCP manager is not mounted.",
  move: "A Ghost conversation stays rooted in its ghost home and cannot be moved to another project.",
  "add-dir": "Ghost does not extend a conversation outside its fixed ghost-home scope.",
  "remove-dir": "Ghost does not change a conversation's fixed ghost-home scope.",
  pin: "Use Ghost's conversation pin API or UI; OMP's global session pins are not used.",
  rename: "Use Ghost's conversation rename API or UI so its title contract is preserved.",
  share: "Ghost does not publish conversation snapshots; use Remote collaboration for deliberate live access.",
  export: "OMP's filesystem export command is not enabled through the Ghost daemon.",
  dump: "OMP dump writes a raw request sidecar containing context and secrets, so it is not exposed here.",
  stats: "OMP's command launches a separate dashboard server, which the Ghost daemon does not manage.",
};

function unsupportedReason(name: string, hasHeadlessHandler: boolean): string {
  const specific = COMMAND_REASONS[name];
  if (specific) return specific;
  if (!hasHeadlessHandler) {
    return `/${name} requires OMP's interactive terminal UI and is not available in Ghost yet.`;
  }
  return `/${name} is not enabled in Ghost's safe headless command set yet.`;
}

function availabilityFor(command: InternalAvailableSlashCommand): Pick<
  GhostAvailableSlashCommand,
  "availability" | "unavailableReason"
> {
  if (command.source !== "builtin") return { availability: "available" };
  if (FULLY_AVAILABLE_BUILTINS.has(command.name)) return { availability: "available" };
  if (PARTIALLY_AVAILABLE_BUILTINS.has(command.name)) {
    return {
      availability: "partial",
      unavailableReason: "Only the informational forms of this command are available in Ghost.",
    };
  }
  return {
    availability: "unsupported",
    unavailableReason: unsupportedReason(command.name, true),
  };
}

/** Build the session-specific command palette with OMP's own discovery rules. */
export async function buildGhostAvailableSlashCommands(
  session: AgentSession,
): Promise<GhostAvailableSlashCommand[]> {
  const pinnedFileCommands = [...session.slashCommands];
  const discovered = await buildAvailableSlashCommands(
    session,
    async () => pinnedFileCommands,
  );
  const discoveredBuiltins = new Map(
    discovered
      .filter((command) => command.source === "builtin")
      .map((command) => [command.name, command] as const),
  );
  const builtins = BUILTIN_SLASH_COMMANDS_INTERNAL.map((spec): GhostAvailableSlashCommand => {
    const discoveredCommand = discoveredBuiltins.get(spec.name);
    if (discoveredCommand) {
      return { ...discoveredCommand, ...availabilityFor(discoveredCommand) };
    }
    const hint = spec.acpInputHint ?? spec.inlineHint;
    return {
      name: spec.name,
      ...(spec.aliases ? { aliases: [...spec.aliases] } : {}),
      description: spec.description,
      ...(hint ? { input: { hint } } : {}),
      ...(spec.subcommands ? { subcommands: [...spec.subcommands] } : {}),
      source: "builtin",
      availability: "unsupported",
      unavailableReason: unsupportedReason(spec.name, false),
    };
  });
  const dynamic = discovered
    .filter((command) => command.source !== "builtin")
    .map((command) => ({ ...command, ...availabilityFor(command) }));
  const seen = new Set([...builtins, ...dynamic].map((command) => command.name));
  for (const template of session.promptTemplates) {
    if (seen.has(template.name)) continue;
    seen.add(template.name);
    dynamic.push({
      name: template.name,
      description: template.description,
      source: "file",
      availability: "available",
    });
  }
  return [...builtins, ...dynamic];
}

export type GhostBuiltinDispatch =
  | { kind: "not_builtin" }
  | { kind: "execute"; command: string }
  | { kind: "unsupported"; command: string; reason: string };

/** Classify before `AgentSession.prompt()` so known builtins never reach the model. */
export function classifyGhostBuiltin(text: string): GhostBuiltinDispatch {
  const parsed = parseSlashCommand(text);
  if (!parsed) return { kind: "not_builtin" };
  const builtin = lookupBuiltinSlashCommand(parsed.name);
  if (!builtin) return { kind: "not_builtin" };

  const command = `/${builtin.name}`;
  if (!builtin.handle) {
    return { kind: "unsupported", command, reason: unsupportedReason(builtin.name, false) };
  }
  const args = parsed.args.trim().toLowerCase().replace(/\s+/g, " ");
  if (FULLY_AVAILABLE_BUILTINS.has(builtin.name) && !args) {
    return { kind: "execute", command };
  }
  if (PARTIAL_INVOCATIONS[builtin.name]?.has(args)) {
    return { kind: "execute", command };
  }
  return { kind: "unsupported", command, reason: unsupportedReason(builtin.name, true) };
}

/** Execute a command already admitted by `classifyGhostBuiltin`. */
export async function executeGhostBuiltin(
  text: string,
  runtime: SlashCommandRuntime,
): Promise<void> {
  const result = await executeAcpBuiltinSlashCommand(text, runtime);
  if (result === false) throw new Error("The admitted OMP builtin no longer has a headless handler.");
  if ("prompt" in result) {
    throw new Error("A read-only Ghost builtin unexpectedly requested a model turn.");
  }
}
