/**
 * Slash commands as Ghost understands them. The catalog is Ghost's own: a
 * small set of headless builtins it can answer without a model, the
 * conversation's pinned Markdown commands and prompt templates, and the
 * builtins other harnesses taught people that Ghost deliberately does not
 * run. A known command that is not admitted is still consumed, so it can never
 * be mistaken for an ordinary model prompt.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { formatJobList, type GhostJobManager } from "./jobs.js";

export type GhostCommandAvailability = "available" | "partial" | "unsupported";

export interface GhostAvailableSlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  input?: { hint: string };
  subcommands?: string[];
  source: "builtin" | "file" | "extension";
  availability: GhostCommandAvailability;
  unavailableReason?: string;
}

interface BuiltinSpec {
  name: string;
  description: string;
  availability: GhostCommandAvailability;
  hint?: string;
  reason?: string;
}

const BUILTINS: readonly BuiltinSpec[] = [
  { name: "model", description: "Show the model this conversation answers on", availability: "partial", hint: "[provider/model]" },
  { name: "session", description: "Show this conversation's transcript path and id", availability: "partial", hint: "[info]" },
  { name: "usage", description: "Show token usage and cost for this conversation", availability: "partial", hint: "[show]" },
  { name: "context", description: "Show how much of the model's context window is used", availability: "available" },
  { name: "tools", description: "List the tools active in this conversation", availability: "available" },
  { name: "dirs", description: "Show the directories this conversation works in", availability: "available" },
  { name: "jobs", description: "List this conversation's background jobs", availability: "available" },
  { name: "todo", description: "Show the plan's to-do list", availability: "unsupported", reason: "Plan mode returns with Ghost's own plan and to-do surface." },
  { name: "compact", description: "Summarize older history to free context", availability: "available", hint: "[instructions]" },
  { name: "browser", description: "Browser mode", availability: "unsupported", reason: "Ghost's browser tools own this surface." },
  { name: "computer", description: "Computer use mode", availability: "unsupported", reason: "Ghost's desktop tools own this surface." },
  { name: "memory", description: "Memory backends", availability: "unsupported", reason: "Ghost memory is plain files in this ghost home." },
  { name: "mcp", description: "MCP servers", availability: "unsupported", reason: "Use Ghost MCP management." },
  { name: "move", description: "Move the conversation to another project", availability: "unsupported", reason: "A Ghost conversation stays rooted in its ghost home." },
  { name: "add-dir", description: "Add a directory to the conversation", availability: "unsupported", reason: "Ghost does not extend a conversation outside its fixed ghost-home scope." },
  { name: "remove-dir", description: "Remove a directory from the conversation", availability: "unsupported", reason: "Ghost does not change a conversation's fixed ghost-home scope." },
  { name: "pin", description: "Pin the conversation", availability: "unsupported", reason: "Use Ghost's conversation pin API or UI." },
  { name: "rename", description: "Rename the conversation", availability: "unsupported", reason: "Use Ghost's conversation rename API or UI so its title contract is preserved." },
  { name: "name", description: "Name the session", availability: "unsupported", reason: "Use Ghost's conversation rename API or UI so its title contract is preserved." },
  { name: "fork", description: "Fork the session", availability: "unsupported", reason: "Use Ghost's conversation fork API or UI." },
  { name: "clone", description: "Clone the session", availability: "unsupported", reason: "Use Ghost's conversation fork API or UI." },
  { name: "share", description: "Share a snapshot", availability: "unsupported", reason: "Ghost does not publish conversation snapshots; use Remote collaboration for deliberate live access." },
  { name: "export", description: "Export the conversation", availability: "unsupported", reason: "Filesystem export is not enabled through the Ghost daemon." },
  { name: "dump", description: "Dump the raw request", availability: "unsupported", reason: "A raw request sidecar would contain context and secrets, so it is not exposed here." },
  { name: "stats", description: "Open the stats dashboard", availability: "unsupported", reason: "Ghost does not manage a separate dashboard server." },
  ...[
    ["plan", "Plan mode"],
    ["help", "Show command help"],
    ["clear", "Clear the terminal"],
    ["new", "Start a new session"],
    ["resume", "Resume a session"],
    ["exit", "Exit"],
    ["quit", "Quit"],
    ["settings", "Open settings"],
    ["theme", "Choose a theme"],
    ["keybindings", "Edit keybindings"],
    ["login", "Sign in to a provider"],
    ["logout", "Sign out of a provider"],
    ["tree", "Browse the session tree"],
    ["thinking", "Choose a thinking level"],
    ["scoped-models", "Scope models"],
    ["import", "Import a session"],
    ["copy", "Copy the last response"],
    ["changelog", "Show the changelog"],
    ["hotkeys", "Show hotkeys"],
    ["trust", "Trust a project"],
    ["reload", "Reload the session"],
  ].map(([name = "", description = ""]): BuiltinSpec => ({
    name,
    description,
    availability: "unsupported",
    reason: "This command drives an interactive terminal UI; Ghost runs headless.",
  })),
];

const BUILTIN_BY_NAME = new Map(BUILTINS.map((spec) => [spec.name, spec]));

const PARTIAL_INVOCATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  model: new Set([""]),
  session: new Set(["", "info"]),
  usage: new Set(["", "show"]),
};

const PARTIAL_REASON = "Only the informational forms of this command are available in Ghost.";

/** A Markdown command or prompt template admitted for this conversation. */
export interface GhostFileCommand {
  name: string;
  description: string;
  content: string;
  source: string;
}

export function buildGhostAvailableSlashCommands(
  commands: readonly GhostFileCommand[],
): GhostAvailableSlashCommand[] {
  const builtins = BUILTINS.map((spec): GhostAvailableSlashCommand => ({
    name: spec.name,
    description: spec.description,
    ...(spec.hint ? { input: { hint: spec.hint } } : {}),
    source: "builtin",
    availability: spec.availability,
    ...(spec.availability === "partial"
      ? { unavailableReason: PARTIAL_REASON }
      : spec.reason
        ? { unavailableReason: spec.reason }
        : {}),
  }));
  const seen = new Set(builtins.map((command) => command.name));
  const dynamic: GhostAvailableSlashCommand[] = [];
  for (const command of commands) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    dynamic.push({
      name: command.name,
      description: command.description,
      source: "file",
      availability: "available",
    });
  }
  return [...builtins, ...dynamic];
}

export interface ParsedSlashCommand {
  name: string;
  args: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

export type GhostBuiltinDispatch =
  | { kind: "not_builtin" }
  | { kind: "execute"; command: string; args: string }
  | { kind: "unsupported"; command: string; reason: string };

export function classifyGhostBuiltin(text: string): GhostBuiltinDispatch {
  const parsed = parseSlashCommand(text);
  if (!parsed) return { kind: "not_builtin" };
  const spec = BUILTIN_BY_NAME.get(parsed.name);
  if (!spec) return { kind: "not_builtin" };
  const command = `/${spec.name}`;
  if (spec.availability === "unsupported") {
    return { kind: "unsupported", command, reason: spec.reason ?? `${command} is not available in Ghost.` };
  }
  const args = parsed.args.toLowerCase().replace(/\s+/g, " ");
  if (spec.availability === "available") return { kind: "execute", command, args: parsed.args };
  if (PARTIAL_INVOCATIONS[spec.name]?.has(args)) return { kind: "execute", command, args: parsed.args };
  return { kind: "unsupported", command, reason: PARTIAL_REASON };
}

export interface GhostBuiltinContext {
  session: AgentSession;
  jobs: GhostJobManager;
  cwd: string;
  projectRoot: string | null;
  ghostHome: string;
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** Answer an admitted builtin without a model; returns the text to show. */
export async function executeGhostBuiltin(
  dispatch: Extract<GhostBuiltinDispatch, { kind: "execute" }>,
  context: GhostBuiltinContext,
): Promise<string> {
  const { session } = context;
  switch (dispatch.command) {
    case "/model": {
      const model = session.model;
      return model ? `${model.provider}/${model.id} (thinking: ${session.thinkingLevel})` : "No model is bound.";
    }
    case "/session":
      return [`id: ${session.sessionId}`, `file: ${session.sessionFile ?? "(not persisted)"}`].join("\n");
    case "/usage": {
      const stats = session.getSessionStats();
      return [
        `messages: ${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolCalls} tool calls`,
        `tokens: ${formatTokens(stats.tokens.input)} in, ${formatTokens(stats.tokens.output)} out, ${formatTokens(stats.tokens.cacheRead)} cache read`,
        `cost: $${stats.cost.toFixed(4)}`,
      ].join("\n");
    }
    case "/context": {
      const usage = session.getContextUsage();
      if (!usage) return "Context usage is unknown until the first turn.";
      const window = usage.contextWindow ?? 0;
      const percent = window > 0 ? Math.round(((usage.tokens ?? 0) / window) * 100) : 0;
      return `${formatTokens(usage.tokens ?? 0)} of ${formatTokens(window)} tokens (${percent}%)`;
    }
    case "/tools":
      return session.getActiveToolNames().map((name) => `- ${name}`).join("\n") || "No tools are active.";
    case "/jobs":
      return formatJobList(context.jobs.list());
    case "/dirs":
      return [
        `cwd: ${context.cwd}`,
        `ghost home: ${context.ghostHome}`,
        ...(context.projectRoot ? [`project: ${context.projectRoot}`] : []),
      ].join("\n");
    case "/compact": {
      const result = await session.compact(dispatch.args || undefined);
      return `Compacted ${formatTokens(result.tokensBefore)} tokens of history into a summary.`;
    }
    default:
      throw new Error(`Unknown admitted builtin ${dispatch.command}.`);
  }
}
