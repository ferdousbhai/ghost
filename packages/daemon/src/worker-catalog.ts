/**
 * The machine worker catalogue.
 *
 * A worker is an agent harness Ghost can delegate a task to. This catalogue
 * reports only machine facts and Omarchy's read-only usage projection; model
 * routing remains a separate Ghost concern, and task execution remains owned
 * by the task manager and worker adapters.
 */
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
} from "node:path";
import {
  CLAUDE_CODE_BINARY_ENV,
  ClaudeCodeProbe,
  isClaudePlanAuth,
} from "./claude-code.js";
import { CodexMissingError, CodexProbe } from "./codex-worker.js";
import { GhostError } from "./ghosts.js";
import { silentLogger, type Logger } from "./log.js";
import { PrivateReadError, readPrivateFileText } from "./private-file.js";
import { CODEX_BINARY_ENV } from "./worker-executable.js";
import type { WorkerId } from "./worker-identity.js";

export { CODEX_BINARY_ENV, resolveWorkerExecutable } from "./worker-executable.js";
export { WORKER_IDS, type WorkerId } from "./worker-identity.js";

export type WorkerAuthentication =
  | "authenticated"
  | "unauthenticated"
  | "unknown"
  | "ghost-model";

export type WorkerInstallation = "installed" | "missing" | "unknown";

export type WorkerUsageState = "ready" | "missing" | "invalid";

export interface WorkerUsageLimit {
  label: string;
  /** Fraction already used in the current window, in [0, 1]. */
  usedFraction: number;
  resetsAt: string | null;
}

export interface WorkerUsageToday {
  totalTokens: number;
  prompts: number;
  sessions: number;
}

export interface WorkerUsageView {
  source: "omarchy";
  state: WorkerUsageState;
  updatedAt: string | null;
  stale: boolean;
  tier: string | null;
  status: string | null;
  help: string | null;
  limits: WorkerUsageLimit[];
  today: WorkerUsageToday | null;
}

export interface WorkerStatus {
  id: WorkerId;
  name: string;
  kind: "native" | "builtin";
  nativeConfiguration: boolean;
  installation: WorkerInstallation;
  authentication: WorkerAuthentication;
  reason: string | null;
  usage: WorkerUsageView | null;
}

export interface WorkerCatalogView {
  workers: WorkerStatus[];
}

export interface WorkerCatalogOptions {
  ownerHome?: string;
  env?: NodeJS.ProcessEnv;
  usageDir?: string;
  now?: () => number;
  staleAfterMs?: number;
  claudeCodeProbe?: Pick<ClaudeCodeProbe, "read">;
  codexProbe?: Pick<CodexProbe, "read">;
  resolveCodexExecutable?: (configured: string) => Promise<string>;
  logger?: Logger;
}

const DEFAULT_USAGE_STALE_AFTER_MS = 30 * 60 * 1_000;
const MAX_USAGE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_USAGE_LIMITS = 16;
const MAX_LABEL_LENGTH = 160;
const MAX_STATUS_LENGTH = 500;
const CLAUDE_MISSING_REASON = "Install Claude Code, then run `claude auth login`.";
const CLAUDE_PROBE_FAILED_REASON =
  "Could not verify Claude Code. Run `claude auth status --json` to diagnose it.";
const CODEX_MISSING_REASON =
  "Codex is unavailable. Install it or check `GHOST_CODEX_BINARY`.";
const CODEX_PROBE_FAILED_REASON =
  "Could not verify Codex. Run `codex login status` to diagnose it.";

function compactText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.slice(0, maxLength);
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function emptyUsage(state: Exclude<WorkerUsageState, "ready">): WorkerUsageView {
  return {
    source: "omarchy",
    state,
    updatedAt: null,
    stale: true,
    tier: null,
    status: null,
    help: null,
    limits: [],
    today: null,
  };
}

function parseUsageRecord(
  raw: string,
  expectedId: "claude" | "codex",
  now: number,
  staleAfterMs: number,
): WorkerUsageView | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.id !== expectedId) return null;
  const updatedAt = isoTimestamp(record.updatedAt);
  if (!updatedAt) return null;
  const updatedAtMs = Date.parse(updatedAt);
  const age = now - updatedAtMs;

  const limits: WorkerUsageLimit[] = [];
  if (Array.isArray(record.limits)) {
    for (const candidate of record.limits.slice(0, MAX_USAGE_LIMITS)) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const limit = candidate as Record<string, unknown>;
      const label = compactText(limit.label, MAX_LABEL_LENGTH);
      const percent = limit.percent;
      if (!label || typeof percent !== "number" || !Number.isFinite(percent)
        || percent < 0 || percent > 1) continue;
      limits.push({
        label,
        usedFraction: percent,
        resetsAt: isoTimestamp(limit.resetsAt),
      });
    }
  }

  const hasToday = [
    record.todayTotalTokens,
    record.todayPrompts,
    record.todaySessions,
  ].some((entry) => typeof entry === "number" && Number.isFinite(entry));

  return {
    source: "omarchy",
    state: "ready",
    updatedAt,
    stale: age > staleAfterMs || age < -MAX_USAGE_CLOCK_SKEW_MS,
    tier: compactText(record.tierLabel, MAX_LABEL_LENGTH),
    status: compactText(record.usageStatusText, MAX_STATUS_LENGTH),
    help: compactText(record.authHelpText, MAX_STATUS_LENGTH),
    limits,
    today: hasToday
      ? {
          totalTokens: nonNegativeInteger(record.todayTotalTokens),
          prompts: nonNegativeInteger(record.todayPrompts),
          sessions: nonNegativeInteger(record.todaySessions),
        }
      : null,
  };
}

export function defaultOmarchyUsageDir(
  ownerHome = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.XDG_STATE_HOME?.trim();
  const stateHome = configured && isAbsolute(configured)
    ? configured
    : join(ownerHome, ".local", "state");
  return join(stateHome, "omarchy", "agents", "usage");
}

/** Read-only detection and usage status for the three code-owned worker ids. */
export class WorkerCatalog {
  private readonly usageDir: string;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly claudeCodeProbe: Pick<ClaudeCodeProbe, "read">;
  private readonly codexProbe: Pick<CodexProbe, "read">;
  private readonly logger: Logger;

  constructor(options: WorkerCatalogOptions = {}) {
    const ownerHome = options.ownerHome ?? homedir();
    const env = options.env ?? process.env;
    this.usageDir = options.usageDir ?? defaultOmarchyUsageDir(ownerHome, env);
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_USAGE_STALE_AFTER_MS;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs <= 0) {
      throw new RangeError("Worker usage staleAfterMs must be a positive finite number.");
    }
    this.claudeCodeProbe = options.claudeCodeProbe ?? new ClaudeCodeProbe({
      binaryPath: env[CLAUDE_CODE_BINARY_ENV] ?? "claude",
    });
    this.codexProbe = options.codexProbe ?? new CodexProbe({
      env,
      binaryPath: env[CODEX_BINARY_ENV]?.trim() || "codex",
      ...(options.resolveCodexExecutable
        ? { resolveExecutable: options.resolveCodexExecutable }
        : {}),
    });
    this.logger = options.logger ?? silentLogger;
  }

  async list(): Promise<WorkerCatalogView> {
    const [claude, codex, claudeUsage, codexUsage] = await Promise.all([
      this.claudeStatus(),
      this.codexStatus(),
      this.readUsage("claude"),
      this.readUsage("codex"),
    ]);
    return {
      workers: [
        { ...claude, usage: claudeUsage },
        { ...codex, usage: codexUsage },
        {
          id: "pi-worker",
          name: "Pi worker",
          kind: "builtin",
          nativeConfiguration: false,
          installation: "installed",
          authentication: "ghost-model",
          reason: null,
          usage: null,
        },
      ],
    };
  }

  private async claudeStatus(): Promise<Omit<WorkerStatus, "usage">> {
    try {
      const result = await this.claudeCodeProbe.read();
      const authenticated = isClaudePlanAuth(result.authStatus);
      return {
        id: "claude-code",
        name: "Claude Code",
        kind: "native",
        nativeConfiguration: true,
        installation: "installed",
        authentication: authenticated ? "authenticated" : "unauthenticated",
        reason: authenticated
          ? null
          : "Run `claude auth login` to use the owner's Claude plan.",
      };
    } catch (error) {
      const installation = error instanceof GhostError && error.code === "claude_code_missing"
        ? "missing"
        : "unknown";
      return {
        id: "claude-code",
        name: "Claude Code",
        kind: "native",
        nativeConfiguration: true,
        installation,
        authentication: "unknown",
        reason: installation === "missing" ? CLAUDE_MISSING_REASON : CLAUDE_PROBE_FAILED_REASON,
      };
    }
  }

  private async codexStatus(): Promise<Omit<WorkerStatus, "usage">> {
    try {
      const result = await this.codexProbe.read();
      const authentication = result.account.accountPresent
        ? "authenticated"
        : result.account.requiresOpenaiAuth
        ? "unauthenticated"
        : "unknown";
      return {
        id: "codex",
        name: "Codex",
        kind: "native",
        nativeConfiguration: true,
        installation: "installed",
        authentication,
        reason: authentication === "unauthenticated"
          ? "Run `codex login` to use the owner's Codex account."
          : null,
      };
    } catch (error) {
      const installation = error instanceof CodexMissingError ? "missing" : "unknown";
      return {
        id: "codex",
        name: "Codex",
        kind: "native",
        nativeConfiguration: true,
        installation,
        authentication: "unknown",
        reason: installation === "missing" ? CODEX_MISSING_REASON : CODEX_PROBE_FAILED_REASON,
      };
    }
  }

  private async readUsage(id: "claude" | "codex"): Promise<WorkerUsageView> {
    let raw: string;
    try {
      raw = readPrivateFileText(join(this.usageDir, `${id}.json`));
    } catch (error) {
      const openCause = error instanceof PrivateReadError && error.refusal === "open"
        ? error.cause as NodeJS.ErrnoException | undefined
        : undefined;
      if (openCause?.code !== "ENOENT") {
        this.logger.warn("worker usage record was refused", {
          worker: id,
          reason: error instanceof PrivateReadError ? error.refusal : "read_failed",
        });
        return emptyUsage("invalid");
      }
      return emptyUsage("missing");
    }
    const usage = parseUsageRecord(raw, id, this.now(), this.staleAfterMs);
    if (usage) return usage;
    this.logger.warn("worker usage record was invalid", { worker: id });
    return emptyUsage("invalid");
  }
}
