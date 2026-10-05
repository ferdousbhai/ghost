import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { xdgBaseDir } from "@ghost/extensions";

const exec = promisify(execFile);

/** A window at or past this fraction used leaves its harness ineligible. */
export const WINDOW_CEILING = 0.9;
/**
 * A weekly window may run this far ahead of pace — the fraction of its week
 * elapsed since the reset — before its harness is ineligible: one day's share.
 */
export const WEEKLY_PACE_SLACK = 1 / 7;
const WEEK_MS = 7 * 24 * 3_600_000;
const WEEKLY_LABEL = /week|7-day/iu;
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
    return { id, eligible: false, reason: `${full.label} ${percentText(full.percent)} used${resets}`, usage };
  }
  for (const window of windows) {
    const allowed = weeklyAllowance(window, now);
    if (allowed !== null && window.percent > allowed) {
      const reason = `${window.label} ${percentText(window.percent)} used, ahead of weekly pace `
        + `(${percentText(allowed)} by now), resets ${window.resetsAt}`;
      return { id, eligible: false, reason, usage };
    }
  }
  return { id, eligible: true, reason: null, usage };
}

function percentText(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * The most a weekly window may have used by `now`: the elapsed fraction of the
 * week that ends at its (future) reset, plus the slack. Null for a window
 * that is not weekly, or whose reset is missing or more than a week off; only
 * the ceiling judges those.
 */
function weeklyAllowance(window: UsageWindow, now: number): number | null {
  if (window.resetsAt === null || !WEEKLY_LABEL.test(window.label)) return null;
  const left = Date.parse(window.resetsAt) - now;
  if (!(left <= WEEK_MS)) return null;
  return 1 - left / WEEK_MS + WEEKLY_PACE_SLACK;
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
 * so; a first-run mise stub (a regular file with a `mise use -g "<package>"`
 * line) only once `mise where <package>` finds some installed version, so a
 * pending update is not a cold install; anything else on PATH is the owner's own.
 */
export async function isInstalled(id: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = which(id, env);
  if (path === null) return false;
  const installer = which(`omarchy-install-${id}-cli`, env);
  if (installer !== null) return succeeds(installer, ["--check"], env);
  let stubPackage: string | null = null;
  try {
    // A stub is a short script; a large file is a real binary and is never read.
    const stat = lstatSync(path);
    if (stat.isFile() && stat.size <= 64 * 1024) {
      stubPackage = /^mise use -g(?:\s+--?[\w-]+)*\s+"?([^"\s]+)"?/mu.exec(readFileSync(path, "utf8"))?.[1] ?? null;
    }
  } catch {
    // Unreadable: treat it as the owner's own install.
  }
  return stubPackage === null ? true : succeeds("mise", ["where", stubPackage], env);
}

/** `$XDG_STATE_HOME/omarchy/agents/usage`, falling back to `~/.local/state`. */
export function omarchyUsageDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return join(xdgBaseDir(env, "XDG_STATE_HOME", home), "omarchy", "agents", "usage");
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

/** Omarchy's default agent (`omarchy default agent`), or null when none is chosen. */
export async function omarchyDefaultAgent(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await exec("omarchy-default-agent", [], { env, timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The order a ghost tries harnesses in: the `preferred` ids that are eligible,
 * in the order given (the conversation's own, the ghost's `harness` setting,
 * Omarchy's default), then every other eligible one, in Omarchy's order.
 */
export function orderHarnesses(eligible: readonly string[], preferred: readonly (string | null)[]): string[] {
  const ordered: string[] = [];
  for (const id of [...preferred, ...eligible]) {
    if (id && eligible.includes(id) && !ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}
