import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A window at or past this fraction used leaves its harness ineligible. */
export const WINDOW_CEILING = 0.9;
/** A usage record older than this is reported stale; nothing refreshes it implicitly. */
export const STALE_AFTER_MS = 15 * 60_000;
export const REFRESH_COMMAND = "omarchy agent usage update";

export interface UsageWindow {
  label: string;
  /** Fraction used, 0–1. */
  percent: number;
  resetsAt: string | null;
}

export interface HarnessUsage {
  updatedAt: string | null;
  stale: boolean;
  /** Omarchy's note when it could not measure the harness, e.g. "Codex limits unavailable". */
  status: string | null;
  windows: UsageWindow[];
}

export interface Harness {
  id: string;
  eligible: boolean;
  reason: string | null;
  /** Null when Omarchy keeps no usage record for this harness. */
  usage: HarnessUsage | null;
}

export interface HarnessReport {
  harnesses: Harness[];
  refresh: string;
}

/**
 * Omarchy's agent ids, in its order, from the `omarchy default agent` route's
 * argument list. Each id is also the agent's executable name.
 */
export function parseOmarchyAgents(commandsJson: string): string[] {
  const parsed = JSON.parse(commandsJson) as { commands?: Array<{ route?: unknown; args?: unknown }> };
  const route = parsed.commands?.find((command) => command.route === "omarchy default agent");
  const match = typeof route?.args === "string" ? /^\[(.+)\]$/u.exec(route.args.trim()) : null;
  if (!match?.[1]) throw new Error("omarchy commands --json names no default-agent choices");
  return match[1].split("|").map((id) => id.trim()).filter(Boolean);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** One harness's eligibility from its Omarchy usage record (or none). */
export function assessHarness(id: string, record: unknown, now: number): Harness {
  if (!record || typeof record !== "object") {
    return { id, eligible: true, reason: null, usage: null };
  }
  const row = record as Record<string, unknown>;
  const updatedAt = text(row.updatedAt);
  const updated = updatedAt === null ? Number.NaN : Date.parse(updatedAt);
  const windows = (Array.isArray(row.limits) ? row.limits : []).flatMap((limit): UsageWindow[] => {
    if (!limit || typeof limit !== "object") return [];
    const entry = limit as Record<string, unknown>;
    const label = text(entry.label);
    const percent = entry.percent;
    if (label === null || typeof percent !== "number" || !Number.isFinite(percent)) return [];
    const resetsAt = text(entry.resetsAt);
    // A window whose reset has passed no longer measures anything.
    if (resetsAt !== null && Date.parse(resetsAt) <= now) return [];
    return [{ label, percent, resetsAt }];
  });
  const usage: HarnessUsage = {
    updatedAt,
    stale: !Number.isFinite(updated) || now - updated > STALE_AFTER_MS,
    status: text(row.usageStatusText),
    windows,
  };
  const full = windows.find((window) => window.percent >= WINDOW_CEILING);
  if (full) {
    const resets = full.resetsAt === null ? "" : `, resets ${full.resetsAt}`;
    return { id, eligible: false, reason: `${full.label} ${Math.round(full.percent * 100)}% used${resets}`, usage };
  }
  return { id, eligible: true, reason: null, usage };
}

function which(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

async function succeeds(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec(file, args, { env, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Omarchy's own test (`agent_present` in `omarchy-default-agent`): an agent with
 * an `omarchy-install-<id>-cli` installer is installed when its `--check` says
 * so; a first-run mise stub (a regular file with a `mise use -g` line) only once
 * mise has the tool; anything else on PATH is the owner's own install.
 */
export async function isInstalled(id: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = which(id, env);
  if (path === null) return false;
  const installer = which(`omarchy-install-${id}-cli`, env);
  if (installer !== null) return succeeds(installer, ["--check"], env);
  let stub = false;
  try {
    // A stub is a short script; a large file is a real binary and is never read.
    const stat = lstatSync(path);
    stub = stat.isFile() && stat.size <= 64 * 1024 && /^mise use -g/mu.test(readFileSync(path, "utf8"));
  } catch {
    // Unreadable: treat it as the owner's own install.
  }
  return stub ? succeeds("mise", ["which", id], env) : true;
}

/** `$XDG_STATE_HOME/omarchy/agents/usage`, falling back to `~/.local/state`. */
export function omarchyUsageDirectory(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "omarchy", "agents", "usage");
}

function readRecord(directory: string, id: string): unknown {
  try {
    return JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The agent CLIs Omarchy knows that are installed, each with its usage record
 * and eligibility. `omarchy`, `mise`, and every harness resolve through `env.PATH`.
 */
export async function readHarnessReport(
  env: NodeJS.ProcessEnv,
  home: string,
  now = Date.now(),
): Promise<HarnessReport> {
  const { stdout } = await exec("omarchy", ["commands", "--json"], { env, maxBuffer: 16 * 1024 * 1024 });
  const directory = omarchyUsageDirectory(env, home);
  const ids = parseOmarchyAgents(stdout);
  const installed = await Promise.all(ids.map((id) => isInstalled(id, env)));
  const harnesses = ids
    .filter((_, index) => installed[index])
    .map((id) => assessHarness(id, readRecord(directory, id), now));
  return { harnesses, refresh: REFRESH_COMMAND };
}
