import {
  query,
  type AgentInfo,
  type Options as ClaudeQueryOptions,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute } from "node:path";
import { ClaudeCodeProbe } from "./claude-code.js";
import { silentLogger, type Logger } from "./log.js";
import { MAX_NATIVE_AGENT_NAME_LENGTH } from "./tasks.js";

export const CLAUDE_AGENT_DISCOVERY_TTL_MS = 5 * 60 * 1_000;
export const CLAUDE_AGENT_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DISCOVERED_AGENTS = 64;
const MAX_AGENT_MODEL_LENGTH = 160;
const MAX_CACHED_CWDS = 32;

export interface ClaudeAgentSelection {
  name: string;
  model: string | null;
}

export interface ClaudeAgentInventory {
  state: "ready" | "unavailable";
  agents: ClaudeAgentSelection[];
  truncated: boolean;
}

export interface ClaudeAgentDiscoveryQueryInput {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
}

export type ClaudeAgentDiscoveryQuery = Pick<Query, "supportedAgents" | "close">;
export type ClaudeAgentDiscoveryQueryFactory = (
  input: ClaudeAgentDiscoveryQueryInput,
) => ClaudeAgentDiscoveryQuery;

export interface ClaudeAgentDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  probe?: Pick<ClaudeCodeProbe, "read">;
  createQuery?: ClaudeAgentDiscoveryQueryFactory;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  logger?: Logger;
}

async function* emptyInput(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function boundedModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact ? compact.slice(0, MAX_AGENT_MODEL_LENGTH) : null;
}

function safeAgentName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_NATIVE_AGENT_NAME_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function normalizeAgents(values: readonly AgentInfo[]): {
  agents: ClaudeAgentSelection[];
  truncated: boolean;
} {
  const agents: ClaudeAgentSelection[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const value of values) {
    if (!safeAgentName(value.name) || seen.has(value.name)) continue;
    seen.add(value.name);
    if (agents.length >= MAX_DISCOVERED_AGENTS) {
      truncated = true;
      break;
    }
    agents.push({ name: value.name, model: boundedModel(value.model) });
  }
  return { agents, truncated };
}

class ClaudeAgentDiscoveryTimeoutError extends Error {}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ClaudeAgentDiscoveryTimeoutError());
          abortController.abort();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Cwd-scoped native Claude agent names without importing agent definitions. */
export class ClaudeAgentDiscovery {
  private readonly env: NodeJS.ProcessEnv;
  private readonly probe: Pick<ClaudeCodeProbe, "read">;
  private readonly createQuery: ClaudeAgentDiscoveryQueryFactory;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly cache = new Map<string, {
    expiresAt: number;
    value: Promise<ClaudeAgentInventory>;
  }>();

  constructor(options: ClaudeAgentDiscoveryOptions = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.probe = options.probe ?? new ClaudeCodeProbe({ env: this.env });
    this.createQuery = options.createQuery ?? ((input) => query(input));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CLAUDE_AGENT_DISCOVERY_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? CLAUDE_AGENT_DISCOVERY_TIMEOUT_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("Claude agent discovery ttlMs must be a positive finite number.");
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("Claude agent discovery timeoutMs must be a positive finite number.");
    }
    this.logger = options.logger ?? silentLogger;
  }

  list(cwd: string, fresh = false): Promise<ClaudeAgentInventory> {
    if (!isAbsolute(cwd)) {
      return Promise.resolve({ state: "unavailable", agents: [], truncated: false });
    }
    const now = this.now();
    const cached = this.cache.get(cwd);
    if (!fresh && cached && now < cached.expiresAt) return cached.value;

    const value = this.discover(cwd);
    this.cache.delete(cwd);
    this.cache.set(cwd, { expiresAt: now + this.ttlMs, value });
    while (this.cache.size > MAX_CACHED_CWDS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }

  private async discover(cwd: string): Promise<ClaudeAgentInventory> {
    const abortController = new AbortController();
    let runtime: ClaudeAgentDiscoveryQuery | undefined;
    try {
      const inventory = normalizeAgents(
        await withTimeout((async () => {
          const { binaryPath } = await this.probe.read();
          if (abortController.signal.aborted) throw new ClaudeAgentDiscoveryTimeoutError();
          runtime = this.createQuery({
            prompt: emptyInput(abortController.signal),
            options: {
              abortController,
              cwd,
              env: this.env,
              pathToClaudeCodeExecutable: binaryPath,
              persistSession: false,
            },
          });
          return runtime.supportedAgents();
        })(), this.timeoutMs, abortController),
      );
      return { state: "ready", ...inventory };
    } catch (error) {
      this.logger.warn("Claude Code agent discovery failed", {
        reason: error instanceof ClaudeAgentDiscoveryTimeoutError
          ? "timeout"
          : "native_discovery_failed",
      });
      return { state: "unavailable", agents: [], truncated: false };
    } finally {
      abortController.abort();
      runtime?.close();
    }
  }
}
