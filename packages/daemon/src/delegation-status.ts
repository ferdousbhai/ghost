import type { ClaudeAgentInventory } from "./claude-agent-discovery.js";
import type {
  HarnessCatalogView,
  HarnessStatus,
  HarnessUsageView,
} from "./harness-catalog.js";

export interface DelegationStatusView extends HarnessCatalogView {
  claudeAgents: ClaudeAgentInventory;
}

function harnessState(harness: HarnessStatus): string {
  if (harness.installation !== "installed") return harness.installation;
  if (harness.authentication === "authenticated") return "ready";
  if (harness.authentication === "unauthenticated") return "login";
  return "installed";
}

function resetDuration(value: string | null, now: number): string {
  if (value === null) return "?";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "?";
  const minutes = Math.max(0, Math.floor((timestamp - now) / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${remainingMinutes}m`;
  return `${minutes}m`;
}

function limitLabel(value: string): string {
  return value
    .replace(/\s*\([^)]*\)\s*$/u, "")
    .replace(/\s+/gu, "-")
    .toLowerCase();
}

function usageId(harness: HarnessStatus): string {
  return harness.id === "claude-code" ? "claude" : harness.id;
}

function usageSummary(harness: HarnessStatus, usage: HarnessUsageView | null, now: number): string {
  const id = usageId(harness);
  if (usage === null) return `${id}=unavailable`;
  if (usage.state !== "ready") return `${id}=${usage.state}`;
  if (usage.limits.length === 0) return `${id}=none`;
  const limits = usage.limits.map((limit) => {
    const remaining = Math.round((1 - limit.usedFraction) * 100);
    return `${limitLabel(limit.label)}=${remaining}%→${resetDuration(limit.resetsAt, now)}`;
  });
  return `${id} ${limits.join(" ")}${usage.stale ? " !stale" : ""}`;
}

export function renderDelegationStatus(view: DelegationStatusView, now = Date.now()): string {
  const harnesses = view.harnesses
    .map((harness) => `${harness.id}=${harnessState(harness)}`)
    .join(" ");
  const agents = view.claudeAgents.state === "ready"
    ? view.claudeAgents.agents.length === 0
      ? "(none)"
      : view.claudeAgents.agents.map((agent) => (
          `${JSON.stringify(agent.name)}${agent.model ? `@${JSON.stringify(agent.model)}` : ""}`
        )).join(", ") + (view.claudeAgents.truncated ? ", …" : "")
    : "unavailable";
  const limits = view.harnesses
    .filter((harness) => harness.id === "claude-code" || harness.id === "codex")
    .map((harness) => usageSummary(harness, harness.usage, now))
    .join(" | ");
  return [
    "# Delegation",
    `harnesses ${harnesses}`,
    `limits ${limits}`,
    `claude-agents ${agents}`,
  ].join("\n");
}
