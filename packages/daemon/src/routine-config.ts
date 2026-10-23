import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GhostError } from "./ghosts.js";
import { readPrivateFileText, writePrivateJsonAtomic, writePrivateTextAtomic } from "./private-file.js";
import { commandRunner, type CommandRunner } from "./tailscale-identity.js";
import { routineStem, scheduleCommand, unitProperties, type ScheduleOptions } from "./schedules.js";

const MAX_SOURCE_BYTES = 131072;
const RECOVERY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
type Sources = { timer: string | null; service: string | null };
export type RoutineConfig = Sources & { revision: string };
interface Checkpoint extends Sources {
  ghost: string;
  slug: string;
  createdAt: string;
  reason: string;
  expectedRevision: string;
}
export interface RoutineConfigOptions extends ScheduleOptions { verify?: CommandRunner }

function names(ghost: string, slug: string, options: ScheduleOptions) {
  const stem = routineStem(ghost, slug);
  return { timer: `${stem}.timer`, service: `${stem}.service`,
    timerPath: join(options.unitDir, `${stem}.timer`), servicePath: join(options.unitDir, `${stem}.service`) };
}
function revision(sources: Sources): string {
  return createHash("sha256").update(JSON.stringify([sources.timer, sources.service])).digest("hex");
}
function validateSource(source: unknown, empty = false): asserts source is string {
  if (typeof source !== "string" || (!empty && !source.trim()) || source.includes("\0") || Buffer.from(source).toString("utf8") !== source || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    throw new GhostError("invalid_routine", "Each unit source must be nonempty UTF-8 text of at most 128 KiB without NUL bytes.", 400);
  }
}
/** Too large, undecodable, or unreadable files are refusals the list can skip, not daemon faults. */
function readText(path: string): string | null {
  try { return readPrivateFileText(path); } catch (error) {
    throw new GhostError("invalid_routine", error instanceof Error ? error.message : String(error), 400);
  }
}
async function readSource(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) throw new GhostError("invalid_routine", "Use native tools for linked or non-regular unit files.", 400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const source = readText(path);
  validateSource(source, true);
  return source;
}
async function readSources(ghost: string, slug: string, options: ScheduleOptions): Promise<RoutineConfig> {
  const paths = names(ghost, slug, options);
  const timer = await readSource(paths.timerPath), service = await readSource(paths.servicePath);
  return { timer, service, revision: revision({ timer, service }) };
}
export async function readRoutineConfig(ghost: string, slug: string, options: ScheduleOptions): Promise<RoutineConfig> {
  const sources = await readSources(ghost, slug, options);
  if (sources.timer === null) throw new GhostError("not_found", "No such routine timer.", 404);
  return sources;
}
function recoveryDir(options: ScheduleOptions): string { return join(options.unitDir, ".ghost-routine-recovery"); }
async function readCheckpoint(ghost: string, id: string, options: ScheduleOptions): Promise<Checkpoint> {
  if (!RECOVERY_ID.test(id)) throw new GhostError("invalid_recovery", "Invalid recovery id.", 400);
  const text = readText(join(recoveryDir(options), `${id}.json`));
  if (text === null) throw new GhostError("not_found", "No such routine checkpoint.", 404);
  let saved: Checkpoint;
  try { saved = JSON.parse(text); } catch { throw new GhostError("invalid_recovery", "Malformed routine checkpoint.", 400); }
  if (!saved || saved.ghost !== ghost) throw new GhostError("not_found", "No such routine checkpoint for this ghost.", 404);
  if (typeof saved.slug !== "string") throw new GhostError("invalid_recovery", "Malformed routine checkpoint.", 400);
  names(ghost, saved.slug, options);
  for (const source of [saved.timer, saved.service]) if (source !== null) validateSource(source, true);
  if (typeof saved.expectedRevision !== "string" || typeof saved.createdAt !== "string" || typeof saved.reason !== "string") {
    throw new GhostError("invalid_recovery", "Malformed routine checkpoint.", 400);
  }
  return saved;
}
export async function listRoutineRecoveries(ghost: string, options: ScheduleOptions) {
  let files: string[];
  try { files = await readdir(recoveryDir(options)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json") || !RECOVERY_ID.test(file.slice(0, -5))) continue;
    // One unreadable checkpoint or unit hides only its own row, never the list.
    let checkpoint: Checkpoint;
    try { checkpoint = await readCheckpoint(ghost, file.slice(0, -5), options); } catch (error) {
      if (error instanceof GhostError) continue;
      throw error;
    }
    const current = await readSources(ghost, checkpoint.slug, options).catch((error: unknown) => {
      if (error instanceof GhostError) return null;
      throw error;
    });
    rows.push({ id: file.slice(0, -5), slug: checkpoint.slug, createdAt: checkpoint.createdAt,
      reason: checkpoint.reason, applicable: current?.revision === checkpoint.expectedRevision });
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function writeSources(ghost: string, slug: string, sources: Sources, options: ScheduleOptions) {
  const paths = names(ghost, slug, options);
  for (const [path, text] of [[paths.timerPath, sources.timer], [paths.servicePath, sources.service]] as const) {
    if (text !== null) await writePrivateTextAtomic(path, text);
    else await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
async function verifySources(ghost: string, slug: string, sources: Sources, options: RoutineConfigOptions) {
  if (sources.timer === null && sources.service === null) return;
  validateSource(sources.timer); validateSource(sources.service);
  const paths = names(ghost, slug, options);
  const temporary = await mkdtemp(join(options.unitDir, ".ghost-routine-verify-"));
  try {
    await writeFile(join(temporary, paths.timer), sources.timer, { mode: 0o600 });
    await writeFile(join(temporary, paths.service), sources.service, { mode: 0o600 });
    const result = await (options.verify ?? commandRunner("systemd-analyze"))([
      "--user", "verify", join(temporary, paths.timer), join(temporary, paths.service),
    ]);
    if (result.code !== 0) throw new GhostError("invalid_routine", result.stderr.trim() || "systemd rejected the unit sources.", 400);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function replaceRoutine(ghost: string, slug: string, expected: string, next: Sources, reason: string, options: RoutineConfigOptions, paused: boolean) {
  const current = await readSources(ghost, slug, options);
  if (reason !== "restore" && current.timer === null) throw new GhostError("not_found", "No such routine timer.", 404);
  if (current.revision !== expected) throw new GhostError("routine_conflict", "The unit sources changed. Reload before saving or restoring.", 409);
  const paths = names(ghost, slug, options), run = options.run ?? commandRunner("systemctl");
  // A restore puts back bytes that were already installed, so undo never depends on them verifying.
  if (reason !== "restore") await verifySources(ghost, slug, next, options);
  const inspect = async (includeService = true) => unitProperties(await scheduleCommand(run, [
    "show", "--all", "--property=Id,Unit,UnitFileState,ActiveState,DropInPaths", paths.timer, ...(includeService ? [paths.service] : []),
  ]));
  const requireDirect = (state: Map<string, Record<string, string>>, required = false) => {
    const target = state.get(paths.timer)?.Unit;
    if ((required ? target !== paths.service : target && target !== paths.service) || [...state.values()].some(unit => unit.DropInPaths)) {
      throw new GhostError("invalid_routine", "Use native tools for redirected timers or units with drop-ins.", 400);
    }
  };
  const state = current.timer === null ? new Map<string, Record<string, string>>() : await inspect(current.service !== null);
  if (current.timer !== null) requireDirect(state);
  const timer = state.get(paths.timer) ?? {};
  // Recheck after validation, which can take long enough for a native editor to save.
  if ((await readSources(ghost, slug, options)).revision !== expected) throw new GhostError("routine_conflict", "The unit sources changed during validation.", 409);
  const id = randomUUID(), checkpointPath = join(recoveryDir(options), `${id}.json`);
  await mkdir(recoveryDir(options), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(checkpointPath, { ghost, slug, timer: current.timer, service: current.service,
    createdAt: new Date().toISOString(), reason, expectedRevision: revision(next) } satisfies Checkpoint);
  const wasActive = timer.ActiveState === "active", enabled = timer.UnitFileState;
  let wroteSources = false;
  try {
    if (current.timer !== null) await scheduleCommand(run, [paused ? "disable" : "stop", ...(paused ? ["--now"] : []), paths.timer]);
    if ((await readSources(ghost, slug, options)).revision !== expected) throw new GhostError("routine_conflict", "The unit sources changed while stopping the timer.", 409);
    wroteSources = true;
    await writeSources(ghost, slug, next, options);
    await scheduleCommand(run, ["daemon-reload"]);
    if (next.timer !== null) requireDirect(await inspect(), true);
    if (paused && next.timer !== null) await scheduleCommand(run, ["disable", "--now", paths.timer]);
    if (!paused && wasActive) await scheduleCommand(run, ["start", paths.timer]);
  } catch (error) {
    try {
      if (wroteSources) {
        // A native save since our write wins; the checkpoint below keeps the original.
        // The timer is written first, so a write that failed midway leaves only the timer changed.
        const onDisk = (await readSources(ghost, slug, options)).revision;
        if (onDisk !== revision(next) && onDisk !== revision({ timer: next.timer, service: current.service })) throw new Error("native edit");
        await writeSources(ghost, slug, current, options);
        await scheduleCommand(run, ["daemon-reload"]);
      }
      if (paused && (enabled === "enabled" || enabled === "enabled-runtime")) {
        await scheduleCommand(run, ["enable", ...(enabled === "enabled-runtime" ? ["--runtime"] : []), paths.timer]);
      }
      if (wasActive) await scheduleCommand(run, ["start", paths.timer]);
      await unlink(checkpointPath);
    } catch {
      throw new GhostError("routine_recovery_required", `Routine change and rollback failed. Recover the original sources from ${checkpointPath}.`, 503);
    }
    throw error;
  }
  return { recovery: id };
}
export async function saveRoutineConfig(ghost: string, slug: string, config: RoutineConfig, options: RoutineConfigOptions) {
  return replaceRoutine(ghost, slug, config.revision, config, "edit", options, false);
}
export async function removeRoutine(ghost: string, slug: string, expected: string, options: RoutineConfigOptions) {
  return replaceRoutine(ghost, slug, expected, { timer: null, service: null }, "remove", options, true);
}
export async function restoreRoutine(ghost: string, id: string, options: RoutineConfigOptions) {
  const saved = await readCheckpoint(ghost, id, options);
  return replaceRoutine(ghost, saved.slug, saved.expectedRevision, saved, "restore", options, true);
}
/** Drop a retired ghost's checkpoints with its units, so a later ghost of that name inherits none. */
export async function discardRoutineRecoveries(ghost: string, options: ScheduleOptions) {
  let files: string[];
  try { files = await readdir(recoveryDir(options)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith(".json") || !RECOVERY_ID.test(file.slice(0, -5))) continue;
    const path = join(recoveryDir(options), file);
    let owner: unknown;
    try { owner = JSON.parse(readPrivateFileText(path) ?? "null")?.ghost; } catch { continue; }
    if (owner === ghost) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
