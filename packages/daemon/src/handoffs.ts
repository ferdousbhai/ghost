import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { LimitReachedEvent } from "./pi-messages.js";
import type { UsageWindow } from "./harnesses.js";

/** Past this size the log moves to `handoffs.jsonl.1`, replacing the previous one. */
export const HANDOFF_LOG_LIMIT_BYTES = 1024 * 1024;

export type HandoffOutcome =
  | { refused: string }
  | {
    exit: number | null;
    signal: string | null;
    /** The harness's own run time; the usage refresh and check before it are not counted. */
    durationMs: number;
    /** Set only for a failed run whose output names a limit. */
    limit: LimitReachedEvent["kind"] | null;
  };

/** One `ghost delegate` attempt. No prompt text is kept. */
export interface HandoffReceipt {
  v: 1;
  at: string;
  ghost: string | null;
  session: string | null;
  harness: string;
  cwd: string;
  /** The harnesses eligible when this one was checked. */
  eligible: string[];
  /** This harness's live usage windows at that check. */
  windows: UsageWindow[];
  outcome: HandoffOutcome;
}

export function handoffLogPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "ghost", "handoffs.jsonl");
}

export function appendHandoff(path: string, receipt: HandoffReceipt): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (statSync(path).size >= HANDOFF_LOG_LIMIT_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No log yet.
  }
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}
