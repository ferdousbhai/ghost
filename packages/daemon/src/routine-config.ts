import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GhostError } from "./ghosts.js";
import { readPrivateFileText, writePrivateJsonAtomic, writePrivateTextAtomic } from "./private-file.js";
import { commandRunner, type CommandRunner } from "./tailscale-identity.js";
import { isValidScheduleSlug, scheduleCommand, scheduleUnitPrefix, unitProperties, type ScheduleOptions } from "./schedules.js";

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
  if (!isValidScheduleSlug(slug)) throw new GhostError("invalid_routine", "Invalid routine slug.", 400);
  const stem = `${scheduleUnitPrefix(ghost)}${slug}`;
  return { timer: `${stem}.timer`, service: `${stem}.service`,
    timerPath: join(options.unitDir, `${stem}.timer`), servicePath: join(options.unitDir, `${stem}.service`) };
}
function revision(sources: Sources): string {
  return createHash("sha256").update(JSON.stringify([sources.timer, sources.service])).digest("hex");
}
function validateSource(source: unknown): asserts source is string {
  if (typeof source !== "string" || !source.trim() || source.includes("\0") || Buffer.from(source).toString("utf8") !== source || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    throw new GhostError("invalid_routine", "Each unit source must be nonempty UTF-8 text of at most 128 KiB without NUL bytes.", 400);
  }
}
async function readSource(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) throw new GhostError("invalid_routine", "Use native tools for linked or non-regular unit files.", 400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const source = readPrivateFileText(path);
  validateSource(source);
  return source;
}
async function readSources(ghost: string, slug: string, options: ScheduleOptions): Promise<RoutineConfig> {
  const paths = names(ghost, slug, options);
  const timer = await readSource(paths.timerPath), service = await readSource(paths.servicePath);
  return { timer, service, revision: revision({ timer, service }) };
}
export async function readRoutineConfig(ghost: string, slug: string, options: ScheduleOptions): Promise<RoutineConfig> {
  const sources = await readSources(ghost, slug, options);
  if (sources.timer === null) throw new GhostError("not_found", "A same-name timer/service pair is required.", 404);
  return sources;
}
function recoveryDir(options: ScheduleOptions): string { return join(options.unitDir, ".ghost-routine-recovery"); }
async function readCheckpoint(ghost: string, id: string, options: ScheduleOptions): Promise<Checkpoint> {
  if (!RECOVERY_ID.test(id)) throw new GhostError("invalid_recovery", "Invalid recovery id.", 400);
  const text = readPrivateFileText(join(recoveryDir(options), `${id}.json`));
  if (text === null) throw new GhostError("not_found", "No such routine checkpoint.", 404);
  let saved: Checkpoint;
  try { saved = JSON.parse(text); } catch { throw new GhostError("invalid_recovery", "Malformed routine checkpoint.", 400); }
  if (!saved || saved.ghost !== ghost) throw new GhostError("not_found", "No such routine checkpoint for this ghost.", 404);
  if (typeof saved.slug !== "string") throw new GhostError("invalid_recovery", "Malformed routine checkpoint.", 400);
  names(ghost, saved.slug, options);
  for (const source of [saved.timer, saved.service]) if (source !== null) validateSource(source);
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
    let checkpoint: Checkpoint;
    try { checkpoint = await readCheckpoint(ghost, file.slice(0, -5), options); } catch (error) {
      if (error instanceof GhostError && error.status === 404) continue;
      throw error;
    }
    const current = await readSources(ghost, checkpoint.slug, options);
    rows.push({ id: file.slice(0, -5), slug: checkpoint.slug, createdAt: checkpoint.createdAt,
      reason: checkpoint.reason, applicable: current.revision === checkpoint.expectedRevision });
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
  for (const line of sources.timer.split("\n")) {
    const target = /^\s*Unit\s*=(.*)$/u.exec(line);
    if (target && target[1]?.trim() !== paths.service) throw new GhostError("invalid_routine", "The timer must target its same-name service.", 400);
  }
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
  if (current.revision !== expected) throw new GhostError("routine_conflict", "The unit sources changed. Reload before saving or restoring.", 409);
  const paths = names(ghost, slug, options), run = options.run ?? commandRunner("systemctl");
  await verifySources(ghost, slug, next, options);
  const state = current.timer === null ? new Map<string, Record<string, string>>() : unitProperties(await scheduleCommand(run, [
    "show", "--all", "--property=Id,Unit,UnitFileState,ActiveState,DropInPaths", paths.timer, ...(current.service === null ? [] : [paths.service]),
  ]));
  const timer = state.get(paths.timer) ?? {};
  if ((timer.Unit && timer.Unit !== paths.service) || [...state.values()].some((unit) => unit.DropInPaths)) {
    throw new GhostError("invalid_routine", "Use native tools for redirected timers or units with drop-ins.", 400);
  }
  // Recheck after validation, which can take long enough for a native editor to save.
  if ((await readSources(ghost, slug, options)).revision !== expected) throw new GhostError("routine_conflict", "The unit sources changed during validation.", 409);
  const id = randomUUID(), checkpointPath = join(recoveryDir(options), `${id}.json`);
  await mkdir(recoveryDir(options), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(checkpointPath, { ghost, slug, timer: current.timer, service: current.service,
    createdAt: new Date().toISOString(), reason, expectedRevision: revision(next) } satisfies Checkpoint);
  const wasActive = timer.ActiveState === "active", enabled = timer.UnitFileState;
  try {
    if (current.timer !== null) await scheduleCommand(run, [paused ? "disable" : "stop", ...(paused ? ["--now"] : []), paths.timer]);
    await writeSources(ghost, slug, next, options);
    await scheduleCommand(run, ["daemon-reload"]);
    if (paused && next.timer !== null) await scheduleCommand(run, ["disable", "--now", paths.timer]);
    if (!paused && wasActive) await scheduleCommand(run, ["start", paths.timer]);
  } catch (error) {
    try {
      await writeSources(ghost, slug, current, options);
      await scheduleCommand(run, ["daemon-reload"]);
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
  await readRoutineConfig(ghost, slug, options);
  validateSource(config.timer); validateSource(config.service);
  return replaceRoutine(ghost, slug, config.revision, config, "edit", options, false);
}
export async function removeRoutine(ghost: string, slug: string, expected: string, options: RoutineConfigOptions) {
  await readRoutineConfig(ghost, slug, options);
  return replaceRoutine(ghost, slug, expected, { timer: null, service: null }, "remove", options, true);
}
export async function restoreRoutine(ghost: string, id: string, options: RoutineConfigOptions) {
  const saved = await readCheckpoint(ghost, id, options);
  return replaceRoutine(ghost, saved.slug, saved.expectedRevision, saved, "restore", options, true);
}
