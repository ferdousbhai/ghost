import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { descriptorPath, openDirectoryNoFollow, redactMemorySecrets } from "@ghost/extensions";
import type { ConversationIdentity } from "./conversation-identity.js";
import { parseConversationIdentity } from "./conversation-identity.js";
import { GhostError } from "./ghosts.js";
import { readPrivateFile, recoverPrivateJsonAtomicCas, writePrivateJsonAtomicCas, type PrivateFileIdentity } from "./private-file.js";

export const TASK_RECORD_VERSION = 1;
export const TASK_BINDING_VERSION = 1;
export const TASKS_DIRNAME = ".tasks";
export const MAX_TASK_TEXT = 32_768;
export const MAX_TASK_RESULT = 65_536;
export const MAX_TASK_EVENTS = 64;
export const MAX_TASK_EVENT_MESSAGE = 1_024;

export type TaskState = "queued" | "starting" | "running" | "cancelling"
  | "completed" | "failed" | "cancelled" | "interrupted";
export interface TaskBindingReceipt {
  version: 1;
  root: string | null;
  rootIdentity: string | null;
  cwd: string;
  cwdIdentity: string;
  generation: number;
}
export interface TaskEvent { sequence: number; at: string; code: string; message: string }
export interface TaskFailure { code: string; message: string }
export interface TaskRecord {
  version: 1;
  id: string;
  generation: number;
  parent: ConversationIdentity;
  harness: string;
  task: string;
  binding: TaskBindingReceipt;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  events: TaskEvent[];
  eventCursor: { nextSequence: number; dropped: number };
  result: string | null;
  resultTruncated: boolean;
  error: TaskFailure | null;
}
export interface TaskBindingAuthority {
  revalidate(receipt: TaskBindingReceipt): Promise<TaskBindingReceipt>;
}
export interface TaskAdapterControl { force(): Promise<void>; quiescence: Promise<void> }
export interface TaskAdapterContext {
  signal: AbortSignal;
  register(control: TaskAdapterControl): void;
  emit(event: Readonly<{ code: string; message: string }>): Promise<void>;
}
export interface TaskAdapterHandle { result: Promise<string>; followUp(message: string): Promise<void> }
export interface TaskAdapter {
  start(input: Readonly<{ id: string; task: string; cwd: string; binding: TaskBindingReceipt }>, context: TaskAdapterContext): Promise<TaskAdapterHandle>;
}

const STATES = new Set<TaskState>(["queued", "starting", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"]);
const TERMINAL = new Set<TaskState>(["completed", "failed", "cancelled", "interrupted"]);
const ID_SOURCE = "task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ID = new RegExp(`^${ID_SOURCE}$`, "u");
const FILE = new RegExp(`^(${ID_SOURCE})\\.json$`, "u");
const CAS_SIDECAR = new RegExp(`^(${ID_SOURCE}\\.json)\\.ghost-migration-(?:cas|next)$`, "u");
const CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
const HARNESS = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_COUNTER = 2_147_483_647;

function fail(code: string, message: string, status = 400): never { throw new GhostError(code, message, status); }
function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function safeText(value: string, maximum: number): { text: string; truncated: boolean } {
  const clean = [...value].map((character) => {
    const point = character.codePointAt(0) ?? 0;
    return (point < 32 && !"\t\n\r".includes(character)) || point === 127 ? "�" : character;
  }).join("");
  const redacted = redactMemorySecrets(clean);
  return redacted.length <= maximum ? { text: redacted, truncated: false } : { text: redacted.slice(0, maximum), truncated: true };
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function validBinding(value: unknown): value is TaskBindingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, ["version", "root", "rootIdentity", "cwd", "cwdIdentity", "generation"])
    && row.version === 1 && (row.root === null || typeof row.root === "string")
    && (row.rootIdentity === null || typeof row.rootIdentity === "string")
    && typeof row.cwd === "string" && isAbsolute(row.cwd) && resolve(row.cwd) === row.cwd && row.cwd.length <= 4096
    && typeof row.cwdIdentity === "string" && row.cwdIdentity.length > 0 && row.cwdIdentity.length <= 256
    && Number.isSafeInteger(row.generation) && Number(row.generation) >= 0 && Number(row.generation) <= MAX_COUNTER
    && ((row.root === null && row.rootIdentity === null)
      || (typeof row.root === "string" && row.root.length <= 4096 && isAbsolute(row.root) && resolve(row.root) === row.root
        && typeof row.rootIdentity === "string" && row.rootIdentity.length > 0 && row.rootIdentity.length <= 256));
}
function sameBinding(left: TaskBindingReceipt, right: TaskBindingReceipt): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function validParent(value: unknown): value is ConversationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ["id", "conversationId", "runtime"]) || typeof row.id !== "string") return false;
  const parsed = parseConversationIdentity(row.id);
  return !!parsed && parsed.conversationId === row.conversationId && parsed.runtime === row.runtime;
}
function parseRecord(value: unknown): TaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_task_record", "The task record is invalid.");
  const row = value as Record<string, unknown>;
  const keys = ["version", "id", "generation", "parent", "harness", "task", "binding", "state", "createdAt", "updatedAt", "events", "eventCursor", "result", "resultTruncated", "error"];
  if (!exactKeys(row, keys) || row.version !== 1 || typeof row.id !== "string" || !ID.test(row.id)
    || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1 || Number(row.generation) > MAX_COUNTER || !validParent(row.parent)
    || typeof row.harness !== "string" || !HARNESS.test(row.harness)
    || typeof row.task !== "string" || row.task.length < 1 || row.task.length > MAX_TASK_TEXT
    || !validBinding(row.binding) || typeof row.state !== "string" || !STATES.has(row.state as TaskState)
    || !canonicalTimestamp(row.createdAt) || !canonicalTimestamp(row.updatedAt)
    || !Array.isArray(row.events) || row.events.length > MAX_TASK_EVENTS
    || typeof row.resultTruncated !== "boolean" || !(row.result === null || (typeof row.result === "string" && row.result.length <= MAX_TASK_RESULT))) fail("invalid_task_record", "The task record is invalid.");
  const cursor = row.eventCursor;
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
    || !exactKeys(cursor as Record<string, unknown>, ["nextSequence", "dropped"])
    || !Number.isSafeInteger((cursor as { nextSequence?: unknown }).nextSequence)
    || !Number.isSafeInteger((cursor as { dropped?: unknown }).dropped)
    || Number((cursor as { nextSequence: number }).nextSequence) < 1 || Number((cursor as { nextSequence: number }).nextSequence) > MAX_COUNTER
    || Number((cursor as { dropped: number }).dropped) < 0 || Number((cursor as { dropped: number }).dropped) > MAX_COUNTER) fail("invalid_task_record", "The task event cursor is invalid.");
  let prior = 0;
  for (const raw of row.events) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_task_record", "The task event is invalid.");
    const event = raw as Record<string, unknown>;
    if (!exactKeys(event, ["sequence", "at", "code", "message"]) || !Number.isSafeInteger(event.sequence)
      || Number(event.sequence) <= prior || !canonicalTimestamp(event.at) || typeof event.code !== "string" || !CODE.test(event.code)
      || typeof event.message !== "string" || event.message.length > MAX_TASK_EVENT_MESSAGE) fail("invalid_task_record", "The task event is invalid.");
    prior = Number(event.sequence);
  }
  const next = Number((cursor as { nextSequence: number }).nextSequence);
  if (next <= prior || Number((cursor as { dropped: number }).dropped) + row.events.length !== next - 1) fail("invalid_task_record", "The task event cursor is inconsistent.");
  const error = row.error;
  if (!(error === null || (typeof error === "object" && !Array.isArray(error)
    && exactKeys(error as Record<string, unknown>, ["code", "message"])
    && typeof (error as TaskFailure).code === "string" && CODE.test((error as TaskFailure).code)
    && typeof (error as TaskFailure).message === "string" && (error as TaskFailure).message.length <= 512))) fail("invalid_task_record", "The task error is invalid.");
  const state = row.state as TaskState; const hasResult = typeof row.result === "string"; const hasError = error !== null;
  const created = Date.parse(row.createdAt as string); const updated = Date.parse(row.updatedAt as string);
  if (updated < created || (row.events as TaskEvent[]).some((event) => Date.parse(event.at) < created || Date.parse(event.at) > updated)) fail("invalid_task_record", "The task timestamps are inconsistent.");
  if ((state === "completed" && (!hasResult || hasError))
    || ((state === "failed" || state === "interrupted") && (hasResult || !hasError))
    || (state !== "completed" && row.resultTruncated === true)
    || ((state !== "completed" && state !== "failed" && state !== "interrupted") && (hasResult || hasError))) fail("invalid_task_record", "The task terminal fields do not match its state.");
  return row as unknown as TaskRecord;
}

export class TaskStore {
  readonly #ghostHome: string;
  #home?: FileHandle;
  #directory?: FileHandle;
  readonly #identities = new WeakMap<TaskRecord, PrivateFileIdentity>();
  constructor(ghostHome: string) {
    if (!isAbsolute(ghostHome) || resolve(ghostHome) !== ghostHome) fail("invalid_task_store", "The ghost home must be canonical.");
    this.#ghostHome = ghostHome;
  }
  async initialize(): Promise<void> {
    if (this.#directory) return;
    try {
      this.#home = await openDirectoryNoFollow(this.#ghostHome, "Ghost home");
      const child = descriptorPath(this.#home, TASKS_DIRNAME);
      try { await mkdir(child, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      this.#directory = await openDirectoryNoFollow(child, "Task store");
      const stats = await this.#directory.stat({ bigint: true });
      if ((stats.mode & 0o777n) !== 0o700n) fail("unsafe_task_store", "The task directory must be mode 0700.");
      await this.#directory.sync(); await this.#home.sync();
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
  async dispose(): Promise<void> { await this.#directory?.close(); await this.#home?.close(); this.#directory = undefined; this.#home = undefined; }
  #require(): { home: FileHandle; directory: FileHandle } {
    if (!this.#directory || !this.#home) fail("task_store_uninitialized", "The task store is not initialized.", 500);
    return { home: this.#home, directory: this.#directory };
  }
  async #verifyDirectory(): Promise<FileHandle> {
    const { home, directory } = this.#require();
    const live = await lstat(descriptorPath(home, TASKS_DIRNAME), { bigint: true }); const admitted = await directory.stat({ bigint: true });
    if (!live.isDirectory() || live.isSymbolicLink() || live.dev !== admitted.dev || live.ino !== admitted.ino || (live.mode & 0o777n) !== 0o700n) fail("unsafe_task_store", "The task directory changed.");
    return directory;
  }
  async read(id: string): Promise<TaskRecord> {
    if (!ID.test(id)) fail("invalid_task_id", "The task id is invalid.");
    const path = descriptorPath(await this.#verifyDirectory(), `${id}.json`);
    const stats = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("task_not_found", "Task not found.", 404);
      throw error;
    });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || (stats.mode & 0o777n) !== 0o600n) fail("unsafe_task_record", "The task record is not a private regular file.");
    try {
      const source = readPrivateFile(path);
      const live = await lstat(path, { bigint: true });
      if (live.dev !== source.identity.device || live.ino !== source.identity.inode || live.nlink !== 1n || (live.mode & 0o777n) !== 0o600n) fail("unsafe_task_record", "The task record changed.");
      const record = parseRecord(JSON.parse(source.text)); this.#identities.set(record, source.identity); return record;
    } catch (error) { if (error instanceof GhostError) throw error; fail("invalid_task_record", "The task record is invalid."); }
  }
  async write(record: TaskRecord): Promise<void> {
    parseRecord(record);
    const path = descriptorPath(await this.#verifyDirectory(), `${record.id}.json`);
    writePrivateJsonAtomicCas(path, record, this.#identities.get(record) ?? null);
  }
  async list(): Promise<TaskRecord[]> {
    const directory = await this.#verifyDirectory(); const records: TaskRecord[] = [];
    const initial = await readdir(descriptorPath(directory));
    for (const name of initial) {
      const base = CAS_SIDECAR.exec(name)?.[1];
      if (base) recoverPrivateJsonAtomicCas(descriptorPath(directory, base));
    }
    for (const name of (await readdir(descriptorPath(directory))).sort()) {
      const id = FILE.exec(name)?.[1];
      if (id) records.push(await this.read(id));
    }
    return records;
  }
  async recover(at: string): Promise<TaskRecord[]> {
    const records = await this.list();
    for (const record of records) if (!TERMINAL.has(record.state)) {
      record.generation += 1; record.state = "interrupted"; record.updatedAt = at; record.result = null; record.resultTruncated = false;
      record.error = { code: "daemon_restarted", message: "The daemon restarted before the task became quiescent." }; await this.write(record);
    }
    return records;
  }
}

interface LiveTask { generation: number; abort: AbortController; control: TaskAdapterControl; handle: Promise<TaskAdapterHandle> }

export class TaskController {
  readonly #actors = new Map<string, Promise<void>>();
  readonly #live = new Map<string, LiveTask>();
  readonly #stops = new Map<string, Promise<TaskRecord>>();
  #initialized = false;
  #shuttingDown = false;
  constructor(readonly store: TaskStore, readonly adapters: ReadonlyMap<string, TaskAdapter>, readonly authority: TaskBindingAuthority, readonly now = () => new Date()) {}
  async initialize(): Promise<TaskRecord[]> { await this.store.initialize(); const rows = await this.store.recover(this.now().toISOString()); this.#initialized = true; return rows; }
  #ready(): void { if (!this.#initialized) fail("tasks_uninitialized", "Tasks are not initialized.", 503); }
  #actor<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.#actors.get(id) ?? Promise.resolve(); const result = prior.catch(() => {}).then(action);
    const tail = result.then(() => undefined, () => undefined); this.#actors.set(id, tail);
    void tail.finally(() => { if (this.#actors.get(id) === tail) this.#actors.delete(id); }); return result;
  }
  async #update(id: string, change: (record: TaskRecord) => void): Promise<TaskRecord> {
    const record = await this.store.read(id); change(record); record.updatedAt = this.now().toISOString(); await this.store.write(record); return record;
  }
  #appendEvent(record: TaskRecord, code: string, message: string): void {
    const sequence = record.eventCursor.nextSequence++;
    record.events.push({ sequence, at: this.now().toISOString(), code, message: safeText(message, MAX_TASK_EVENT_MESSAGE).text });
    if (record.events.length > MAX_TASK_EVENTS) { record.events.shift(); record.eventCursor.dropped += 1; }
  }
  async start(input: { parent: ConversationIdentity; harness: string; task: string; binding: TaskBindingReceipt }): Promise<TaskRecord> {
    this.#ready(); if (this.#shuttingDown) fail("tasks_shutting_down", "Tasks are shutting down.", 503);
    if (!validParent(input.parent) || !HARNESS.test(input.harness) || !input.task || input.task.length > MAX_TASK_TEXT || !validBinding(input.binding)) fail("invalid_task", "The task request is invalid.");
    if (!this.adapters.has(input.harness)) fail("task_harness_unavailable", "That task harness is unavailable.", 409);
    const at = this.now().toISOString(); const id = `task-${randomUUID()}`;
    const record: TaskRecord = { version: 1, id, generation: 1, parent: input.parent, harness: input.harness,
      task: safeText(input.task, MAX_TASK_TEXT).text, binding: input.binding, state: "queued", createdAt: at, updatedAt: at,
      events: [], eventCursor: { nextSequence: 1, dropped: 0 }, result: null, resultTruncated: false, error: null };
    await this.store.write(record); void this.#launch(id, record.generation); return record;
  }
  async #launch(id: string, generation: number): Promise<void> {
    try {
      const record = await this.#actor(id, () => this.#update(id, (row) => { if (row.generation === generation && row.state === "queued") row.state = "starting"; }));
      if (record.generation !== generation || record.state !== "starting") return;
      const binding = await this.authority.revalidate(record.binding); if (!sameBinding(binding, record.binding)) throw new Error("binding changed");
      let live: LiveTask | undefined;
      const running = await this.#actor(id, async () => {
        const current = await this.store.read(id);
        if (current.generation !== generation || current.state !== "starting") return current;
        const adapter = this.adapters.get(current.harness); if (!adapter) throw new Error("adapter disappeared");
        const abort = new AbortController(); let control: TaskAdapterControl | undefined;
        const handle = adapter.start({ id, task: current.task, cwd: binding.cwd, binding }, {
          signal: abort.signal,
          register(value) { if (control) throw new Error("control registered twice"); control = value; },
          emit: (event) => this.#emit(id, generation, event),
        });
        if (!control || typeof control.force !== "function" || !(control.quiescence instanceof Promise)) { abort.abort(); void handle.catch(() => {}); throw new Error("missing control registration"); }
        live = { generation, abort, control, handle }; this.#live.set(id, live);
        return this.#update(id, (row) => { if (row.generation === generation && row.state === "starting") row.state = "running"; });
      });
      if (!live || running.state !== "running") return;
      const native = await live.handle; const result = await native.result; await live.control.quiescence;
      await this.#actor(id, () => this.#update(id, (row) => {
        if (row.generation !== generation || TERMINAL.has(row.state)) return;
        if (row.state === "cancelling") { row.state = "cancelled"; return; }
        const safe = safeText(result, MAX_TASK_RESULT); row.state = "completed"; row.result = safe.text; row.resultTruncated = safe.truncated;
      }));
      this.#live.delete(id);
    } catch {
      const live = this.#live.get(id);
      if (live?.generation === generation) {
        try { await live.control.quiescence; }
        catch {
          await this.#actor(id, () => this.#update(id, (row) => {
            if (row.generation === generation && !TERMINAL.has(row.state)) { row.state = "cancelling"; this.#appendEvent(row, "quiescence_failed", "The native task has not confirmed quiescence."); }
          })).catch(() => {});
          return;
        }
      }
      await this.#actor(id, async () => {
        const row = await this.store.read(id); if (row.generation !== generation || TERMINAL.has(row.state)) return;
        await this.#update(id, (current) => { current.state = "failed"; current.error = { code: "task_failed", message: "The native task failed safely." }; });
      }).catch(() => {});
      if (this.#live.get(id)?.generation === generation) this.#live.delete(id);
    }
  }
  async #quiesce(live: LiveTask): Promise<void> { live.abort.abort(); await live.control.force().catch(() => {}); await live.control.quiescence; }
  async #emit(id: string, generation: number, event: { code: string; message: string }): Promise<void> {
    if (!CODE.test(event.code)) return;
    await this.#actor(id, async () => {
      const current = await this.store.read(id); if (current.generation !== generation || TERMINAL.has(current.state)) return;
      await this.#update(id, (row) => { this.#appendEvent(row, event.code, event.message); });
    });
  }
  followUp(id: string, message: string): Promise<TaskRecord> {
    this.#ready(); return this.#actor(id, async () => {
      const row = await this.store.read(id); if (row.state !== "running" || !message || message.length > MAX_TASK_TEXT) fail("task_not_running", "Follow-up requires a running task.", 409);
      const live = this.#live.get(id); if (!live || live.generation !== row.generation) fail("task_not_running", "The native task is not running.", 409);
      try { const native = await live.handle; await native.followUp(safeText(message, MAX_TASK_TEXT).text); }
      catch {
        await this.#update(id, (current) => { this.#appendEvent(current, "follow_up_failed", "The native task rejected a follow-up."); });
        fail("task_follow_up_failed", "The native task rejected the follow-up.", 502);
      }
      return this.store.read(id);
    });
  }
  cancel(id: string): Promise<TaskRecord> { this.#ready(); return this.#sharedStop(id, "cancelled"); }
  #sharedStop(id: string, final: "cancelled" | "interrupted"): Promise<TaskRecord> {
    const existing = this.#stops.get(id); if (existing) return existing;
    const stop = this.#stop(id, final); this.#stops.set(id, stop);
    void stop.finally(() => { if (this.#stops.get(id) === stop) this.#stops.delete(id); }).catch(() => {});
    return stop;
  }
  async #stop(id: string, final: "cancelled" | "interrupted"): Promise<TaskRecord> {
    const prepared = await this.#actor(id, async () => {
      const row = await this.store.read(id); if (TERMINAL.has(row.state)) return { row };
      const next = await this.#update(id, (current) => { current.state = "cancelling"; }); return { row: next, live: this.#live.get(id) };
    });
    if (!prepared.live) return this.#actor(id, () => this.#update(id, (row) => { if (!TERMINAL.has(row.state)) row.state = final; }));
    try { await this.#quiesce(prepared.live); }
    catch {
      await this.#actor(id, () => this.#update(id, (row) => { if (!TERMINAL.has(row.state)) this.#appendEvent(row, "cancel_failed", "The native task did not confirm quiescence."); }));
      throw new GhostError("task_cancel_failed", "The native task did not confirm quiescence.", 502);
    }
    const settled = await this.#actor(id, () => this.#update(id, (row) => { if (row.generation === prepared.row.generation && !TERMINAL.has(row.state)) row.state = final; }));
    if (this.#live.get(id)?.generation === prepared.row.generation) this.#live.delete(id);
    return settled;
  }
  async beginShutdown(): Promise<void> { this.#ready(); this.#shuttingDown = true; const rows = await this.store.list(); await Promise.all(rows.filter((row) => !TERMINAL.has(row.state)).map((row) => this.#sharedStop(row.id, "interrupted"))); }
  async forceAll(): Promise<void> { this.#ready(); await Promise.all([...this.#live.keys()].map((id) => this.#sharedStop(id, "interrupted"))); }
  async dispose(): Promise<void> { await this.beginShutdown(); await this.forceAll(); await this.store.dispose(); this.#initialized = false; }
}
