import { isAbsolute } from "node:path";
import type {
  ClaudeAgentDiscovery,
  ClaudeAgentInventory,
} from "./claude-agent-discovery.js";
import type {
  HarnessCatalog,
  HarnessCatalogView,
  HarnessStatus,
  HarnessUsageView,
} from "./harness-catalog.js";

export const CODING_RESOURCES_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_CACHED_CWDS = 32;

export interface CodingResourcesView extends HarnessCatalogView {
  claudeAgents: ClaudeAgentInventory;
}

export interface CodingResourcesOptions {
  harnesses: Pick<HarnessCatalog, "list">;
  claudeAgents: Pick<ClaudeAgentDiscovery, "list">;
  now?: () => number;
  ttlMs?: number;
}

function harnessState(harness: HarnessStatus): string {
  if (harness.installation !== "installed") return harness.installation;
  if (harness.authentication === "authenticated") return "ready";
  if (harness.authentication === "unauthenticated") return "login";
  return "installed";
}

function resetTimestamp(value: string | null): string {
  if (value === null) return "?";
  return value.replace(/\.\d{3}Z$/u, "Z");
}

function limitLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function usageSummary(harness: HarnessStatus, usage: HarnessUsageView | null): string {
  if (usage === null) return `${harness.id}=unavailable`;
  if (usage.state !== "ready") return `${harness.id}=${usage.state}`;
  if (usage.limits.length === 0) return `${harness.id}=none`;
  const limits = usage.limits.map((limit) => {
    const remaining = Math.round((1 - limit.usedFraction) * 100);
    return `${limitLabel(limit.label)} ${remaining}% left→${resetTimestamp(limit.resetsAt)}`;
  });
  return `${harness.id} ${limits.join("; ")}${usage.stale ? " [stale]" : ""}`;
}

export function renderCodingResources(view: CodingResourcesView): string {
  const harnesses = view.harnesses
    .map((harness) => `${harness.id}=${harnessState(harness)}`)
    .join(", ");
  const agents = view.claudeAgents.state === "ready"
    ? view.claudeAgents.agents.length === 0
      ? "(none)"
      : view.claudeAgents.agents.map((agent) => (
          `${JSON.stringify(agent.name)}${agent.model ? `@${JSON.stringify(agent.model)}` : ""}`
        )).join(", ") + (view.claudeAgents.truncated ? ", …" : "")
    : "unavailable";
  const limits = view.harnesses
    .filter((harness) => harness.id === "claude-code" || harness.id === "codex")
    .map((harness) => usageSummary(harness, harness.usage))
    .join(" | ");
  return [
    "# Coding resources",
    `Harnesses: ${harnesses}`,
    `Claude agents here: ${agents}`,
    `Limits: ${limits}`,
  ].join("\n");
}

/** Short-lived per-cwd snapshot used by both principal runtimes and their status tool. */
export class CodingResources {
  private readonly harnesses: Pick<HarnessCatalog, "list">;
  private readonly claudeAgents: Pick<ClaudeAgentDiscovery, "list">;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, {
    expiresAt: number;
    value: Promise<CodingResourcesView>;
  }>();

  constructor(options: CodingResourcesOptions) {
    this.harnesses = options.harnesses;
    this.claudeAgents = options.claudeAgents;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CODING_RESOURCES_CACHE_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("Coding resources ttlMs must be a positive finite number.");
    }
  }

  view(cwd: string, fresh = false): Promise<CodingResourcesView> {
    if (!isAbsolute(cwd)) throw new TypeError("Coding resources cwd must be absolute.");
    const now = this.now();
    const cached = this.cache.get(cwd);
    if (!fresh && cached && now < cached.expiresAt) return cached.value;

    const value = this.load(cwd, fresh);
    this.cache.delete(cwd);
    this.cache.set(cwd, { expiresAt: now + this.ttlMs, value });
    while (this.cache.size > MAX_CACHED_CWDS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }

  private async load(cwd: string, fresh: boolean): Promise<CodingResourcesView> {
    const [catalog, claudeAgents] = await Promise.all([
      this.harnesses.list(),
      this.claudeAgents.list(cwd, fresh),
    ]);
    return { ...catalog, claudeAgents };
  }
}
