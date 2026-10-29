import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArgsError, flagString, type ParsedCliArgs } from "./args.js";
import { ghostPath, resolveGhost } from "./common.js";
import { emit } from "./output.js";
import { EXIT_CODE } from "./client.js";
import type { CliContext } from "./types.js";
import { acceptedEventLine } from "../external-events.js";
import { alertPayload, compareSamples, parseWatchState, readMachineSample, renderReading, watchStep, type WatchAlert } from "../machine.js";
import { readPrivateFileText, writePrivateJsonAtomic } from "../private-file.js";
import { xdgBaseDir } from "../xdg-user-dirs.js";

/** Long enough to see who is busy, short enough to wait for. */
const REPORT_WINDOW_MS = 2000;

/** One ghost's watch state: the last sample and the conditions it is holding. */
export function machineStatePath(env: NodeJS.ProcessEnv, home: string, ghost: string): string {
  return join(xdgBaseDir(env, "XDG_STATE_HOME", home), "ghost", `machine-${ghost}.json`);
}

export interface MachineCheckInput {
  root: string;
  statePath: string;
  now: number;
  /** Delivers one alert as an event; throwing leaves it to be delivered by the next check. */
  deliver(alert: WatchAlert, payload: string): Promise<void>;
}

/** One timer step: sample, fold into the saved state, deliver what is due, save. Returns the alerts that failed. */
export async function runMachineCheck(input: MachineCheckInput): Promise<{ delivered: WatchAlert[]; failed: WatchAlert[] }> {
  const step = watchStep(parseWatchState(readPrivateFileText(input.statePath)), readMachineSample(input.root, input.now));
  const delivered: WatchAlert[] = [], failed: WatchAlert[] = [];
  for (const alert of step.alerts) {
    try {
      await input.deliver(alert, alertPayload(alert, input.root));
      delivered.push(alert);
    } catch {
      const condition = step.state.conditions[alert.key];
      if (condition) condition.alerted = null;
      failed.push(alert);
    }
  }
  await mkdir(dirname(input.statePath), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(input.statePath, step.state);
  return { delivered, failed };
}

export async function machineCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [action] = parsed.positionals;
  if (action === undefined) {
    const first = readMachineSample();
    await new Promise((resolve) => setTimeout(resolve, REPORT_WINDOW_MS));
    const reading = compareSamples(first, readMachineSample());
    emit(ctx, reading, renderReading);
    return EXIT_CODE.success;
  }
  if (action !== "check") throw new ArgsError("ghost machine takes no argument, or check --instructions <text>");
  const instructions = flagString(parsed, "instructions");
  if (!instructions) throw new ArgsError("ghost machine check needs --instructions");
  const ghost = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const lines: string[] = [];
  const result = await runMachineCheck({
    root: "/",
    statePath: machineStatePath(ctx.runtime.env, ctx.runtime.home, ghost),
    now: Date.now(),
    deliver: async (alert, payload) => {
      const accepted = (await ctx.client.request<{ sessionId: string; duplicate: boolean }>("POST", ghostPath(ghost, "/events"), {
        source: "machine", id: alert.id, instructions, payload,
      })).body;
      lines.push(`${alert.id}: ${acceptedEventLine(ghost, accepted.sessionId, accepted.duplicate)}`);
    },
  });
  for (const alert of result.failed) lines.push(`${alert.id}: not delivered; the next check retries it`);
  emit(ctx, { delivered: result.delivered.map((alert) => alert.id), failed: result.failed.map((alert) => alert.id) },
    () => lines.length ? `${lines.join("\n")}\n` : "");
  return result.failed.length ? EXIT_CODE.failure : EXIT_CODE.success;
}
