import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import {
  exportFlywheelDataset,
  FLYWHEEL_SKIP_REASONS,
  type FlywheelSystemPrompt,
} from "../flywheel-export.js";
import { GhostRegistry } from "../ghosts.js";
import { ArgsError, flagString, type ArgsSpec, type ParsedCliArgs } from "./args.js";
import { preferredGhostName, soleGhostName } from "./common.js";
import { notFound } from "./client.js";
import { emit, table } from "./output.js";
import type { CliContext, CliRuntime } from "./types.js";

export const FLYWHEEL_ARGS: ArgsSpec = {
  value: ["out", "since", "holdout", "system", "context-turns", "max-tool-result-chars"],
};

function number(parsed: ParsedCliArgs, name: string, bounds: { min: number; max: number }): number | undefined {
  const raw = flagString(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw new ArgsError(`--${name} must be a number between ${bounds.min} and ${bounds.max}.`);
  }
  return value;
}

function integer(parsed: ParsedCliArgs, name: string, bounds: { min: number; max: number }): number | undefined {
  const value = number(parsed, name, bounds);
  if (value !== undefined && !Number.isSafeInteger(value)) {
    throw new ArgsError(`--${name} must be a whole number.`);
  }
  return value;
}

/** One option entry when the owner typed the flag, and nothing when they did not. */
function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<Key, Value>;
}

function systemFlag(parsed: ParsedCliArgs): FlywheelSystemPrompt | undefined {
  const raw = flagString(parsed, "system");
  if (raw === undefined) return undefined;
  if (raw !== "full" && raw !== "character") {
    throw new ArgsError("--system must be full or character.");
  }
  return raw;
}

function sinceFlag(parsed: ParsedCliArgs): string | undefined {
  const raw = flagString(parsed, "since");
  if (raw === undefined) return undefined;
  const parsedDate = Date.parse(raw);
  if (!Number.isFinite(parsedDate)) throw new ArgsError("--since must be an ISO timestamp.");
  return new Date(parsedDate).toISOString();
}

/** The same addressing order as every other verb, read off the local registry. */
function resolveGhostHome(
  runtime: CliRuntime,
  requested: string | undefined,
): { name: string; home: string } {
  const registry = new GhostRegistry(loadConfig({ env: runtime.env, home: runtime.home }).ghostsRoot);
  const name = preferredGhostName(runtime, requested)
    ?? soleGhostName(registry.list().map((ghost) => ghost.name));
  const ghost = registry.find(name);
  if (!ghost) throw notFound(`ghost ${JSON.stringify(name)}`);
  return { name: ghost.name, home: ghost.dir };
}

/**
 * Export the fruitful part of this ghost's review journals as Fireworks
 * training files. Daemon-free on purpose: training data must be exportable
 * while ghostd is stopped, and no HTTP route carries a transcript.
 */
export async function flywheelCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  if (parsed.positionals[0] !== "export") {
    throw new ArgsError("Usage: ghost flywheel export --out <dir>");
  }
  const out = flagString(parsed, "out");
  if (!out) throw new ArgsError("ghost flywheel export requires --out <dir>.");
  // Every flag is validated before a ghost home is opened, so a typo costs a
  // usage error and no disk read. Only what the owner typed is passed on; the
  // exporter is the single place the defaults live.
  const typed = {
    ...defined("since", sinceFlag(parsed)),
    ...defined("holdout", number(parsed, "holdout", { min: 0, max: 1 })),
    ...defined("system", systemFlag(parsed)),
    ...defined("contextTurns", integer(parsed, "context-turns", { min: 0, max: 1_000 })),
    ...defined(
      "maxToolResultChars",
      integer(parsed, "max-tool-result-chars", { min: 0, max: 1_000_000 }),
    ),
  };
  const { name, home } = resolveGhostHome(ctx.runtime, flagString(parsed, "ghost"));
  const manifest = await exportFlywheelDataset({
    ghost: name,
    home,
    outDir: resolve(out),
    ...typed,
    env: ctx.runtime.env,
  });

  emit(ctx, manifest, (body) => {
    const samples = Object.entries(body.files).map(([file, count]) => [file, String(count)]);
    const skips = FLYWHEEL_SKIP_REASONS
      .filter((reason) => body.skipped[reason] > 0)
      .map((reason) => [`skipped ${reason}`, String(body.skipped[reason])]);
    return {
      human: `${table([
        ...samples,
        ...skips,
        ["entries", String(body.entries)],
        ["next --since", body.newestRecordedAt ?? "—"],
      ])}\n`,
      quiet: `${samples.reduce((total, [, count]) => total + Number(count), 0)} samples\n`,
    };
  });
  return 0;
}
