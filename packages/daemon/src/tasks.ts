import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { descriptorPath, openDirectoryNoFollow, REDACTED_MEMORY_SECRET, redactMemorySecrets } from "@ghost/extensions";
import type { ConversationIdentity } from "./conversation-identity.js";
import { parseConversationIdentity } from "./conversation-identity.js";
import { GhostError } from "./ghosts.js";
import { readPrivateFile, recoverPrivateJsonAtomicCas, writePrivateJsonAtomicCas, type PrivateFileIdentity } from "./private-file.js";

export const TASK_RECORD_VERSION = 1;
export const TASK_BINDING_VERSION = 1;
export const TASKS_DIRNAME = ".tasks";
export const MAX_TASK_TEXT = 32_768;
export const MAX_TASK_AGENT = 256;
export const MAX_TASK_RESULT = 65_536;
export const MAX_TASK_EVENTS = 64;
export const MAX_TASK_EVENT_MESSAGE = 1_024;

export type TaskState = "queued" | "starting" | "running" | "cancelling"
  | "completed" | "failed" | "cancelled" | "interrupted";
export interface TaskBindingReceipt {
  version: 1;
  root: string;
  rootIdentity: string;
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
  agent: string | null;
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
  revalidate(receipt: TaskBindingReceipt, signal: AbortSignal, parent: ConversationIdentity): Promise<TaskBindingReceipt>;
}
export interface TaskAdapterControl { force(): Promise<void>; quiescence: Promise<void> }
export interface TaskAdapterContext {
  signal: AbortSignal;
  register(control: TaskAdapterControl): void;
  emit(event: Readonly<{ code: string; message: string }>): Promise<void>;
}
export interface TaskAdapterHandle { result: Promise<string>; followUp(message: string): Promise<void> }
export interface TaskAdapter {
  start(input: Readonly<{ id: string; task: string; agent: string | null; cwd: string; binding: TaskBindingReceipt }>, context: TaskAdapterContext): Promise<TaskAdapterHandle>;
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
  const inspection = value.slice(0, Math.max(maximum * 2, maximum + 4096));
  const clean = [...inspection].map((character) => {
    const point = character.codePointAt(0) ?? 0;
    return (point < 32 && !"\t\n\r".includes(character)) || point === 127 ? "�" : character;
  }).join("");
  const redacted = redactMemorySecrets(clean).replace(
    /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*$/gu,
    REDACTED_MEMORY_SECRET,
  );
  return { text: redacted.slice(0, maximum), truncated: value.length > maximum || redacted.length > maximum };
}
function bindingCopy(value: TaskBindingReceipt): Readonly<TaskBindingReceipt> {
  return Object.freeze({
    version: value.version,
    root: value.root,
    rootIdentity: value.rootIdentity,
    cwd: value.cwd,
    cwdIdentity: value.cwdIdentity,
    generation: value.generation,
  });
}
function highWaterTimestamp(record: Pick<TaskRecord, "createdAt" | "updatedAt" | "events">, proposed: string): string {
  const latestEvent = record.events.at(-1)?.at ?? record.createdAt;
  return new Date(Math.max(Date.parse(record.createdAt), Date.parse(record.updatedAt), Date.parse(latestEvent), Date.parse(proposed))).toISOString();
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function validBinding(value: unknown): value is TaskBindingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const valid = exactKeys(row, ["version", "root", "rootIdentity", "cwd", "cwdIdentity", "generation"])
    && row.version === 1
    && typeof row.root === "string" && row.root.length > 0 && row.root.length <= 4096
    && Buffer.byteLength(row.root, "utf8") <= 4096 && isAbsolute(row.root) && resolve(row.root) === row.root
    && typeof row.rootIdentity === "string" && row.rootIdentity.length > 0 && row.rootIdentity.length <= 256
    && typeof row.cwd === "string" && row.cwd.length <= 4096 && Buffer.byteLength(row.cwd, "utf8") <= 4096 && isAbsolute(row.cwd) && resolve(row.cwd) === row.cwd
    && typeof row.cwdIdentity === "string" && row.cwdIdentity.length > 0 && row.cwdIdentity.length <= 256
    && Number.isSafeInteger(row.generation) && Number(row.generation) >= 0 && Number(row.generation) <= MAX_COUNTER;
  return valid && cwdWithinRoot(row as unknown as TaskBindingReceipt);
}
function sameBinding(left: TaskBindingReceipt, right: TaskBindingReceipt): boolean {
  return left.version === right.version && left.root === right.root && left.rootIdentity === right.rootIdentity
    && left.cwd === right.cwd && left.cwdIdentity === right.cwdIdentity && left.generation === right.generation;
}
function cwdWithinRoot(binding: TaskBindingReceipt): boolean {
  const child = relative(binding.root, binding.cwd);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function validParent(value: unknown): value is ConversationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ["id", "conversationId", "runtime"]) || typeof row.id !== "string") return false;
  const parsed = parseConversationIdentity(row.id);
  return !!parsed && parsed.conversationId === row.conversationId && parsed.runtime === row.runtime;
}
function sameParent(left: ConversationIdentity, right: ConversationIdentity): boolean {
  return left.id === right.id
    && left.runtime === right.runtime
    && left.conversationId === right.conversationId;
}
function parseRecord(value: unknown): TaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_task_record", "The task record is invalid.");
  const row = value as Record<string, unknown>;
  const keys = ["version", "id", "generation", "parent", "harness", "agent", "task", "binding", "state", "createdAt", "updatedAt", "events", "eventCursor", "result", "resultTruncated", "error"];
  if (!exactKeys(row, keys) || row.version !== 1 || typeof row.id !== "string" || !ID.test(row.id)
    || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1 || Number(row.generation) > MAX_COUNTER || !validParent(row.parent)
    || typeof row.harness !== "string" || !HARNESS.test(row.harness)
    || !(row.agent === null || (typeof row.agent === "string" && row.agent.length > 0
      && row.agent.length <= MAX_TASK_AGENT && Buffer.byteLength(row.agent, "utf8") <= MAX_TASK_AGENT * 4))
    || (row.agent !== null && row.harness !== "claude-code")
    || typeof row.task !== "string" || row.task.trim() === "" || row.task.length > MAX_TASK_TEXT
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
  let priorTime = Date.parse(row.createdAt as string);
  const dropped = Number((cursor as { dropped: number }).dropped);
  for (const [index, raw] of row.events.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_task_record", "The task event is invalid.");
    const event = raw as Record<string, unknown>;
    if (!exactKeys(event, ["sequence", "at", "code", "message"]) || !Number.isSafeInteger(event.sequence)
      || Number(event.sequence) !== dropped + index + 1 || !canonicalTimestamp(event.at) || Date.parse(event.at as string) < priorTime
      || typeof event.code !== "string" || !CODE.test(event.code)
      || typeof event.message !== "string" || event.message.length > MAX_TASK_EVENT_MESSAGE) fail("invalid_task_record", "The task event is invalid.");
    priorTime = Date.parse(event.at as string);
  }
  const next = Number((cursor as { nextSequence: number }).nextSequence);
  if (dropped + row.events.length !== next - 1) fail("invalid_task_record", "The task event cursor is inconsistent.");
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
      record.generation += 1; record.state = "interrupted"; record.updatedAt = highWaterTimestamp(record, at); record.result = null; record.resultTruncated = false;
      record.error = { code: "daemon_restarted", message: "The daemon restarted before the task became quiescent." }; await this.write(record);
    }
    return records;
  }
}

class TaskAborted extends Error {}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new TaskAborted());
  return new Promise<T>((resolveValue, rejectValue) => {
    const abort = () => rejectValue(new TaskAborted());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolveValue(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); rejectValue(error); },
    );
  });
}
interface LiveTask { generation: number; abort: AbortController; control: TaskAdapterControl; handle: Promise<TaskAdapterHandle> }
interface TrackedLaunch { generation: number; abort: AbortController; persisted: Promise<void>; promise: Promise<void> }

export class TaskController {
  readonly #actors = new Map<string, Promise<void>>();
  readonly #live = new Map<string, LiveTask>();
  readonly #launches = new Map<string, TrackedLaunch>();
  readonly #stops = new Map<string, Promise<TaskRecord>>();
  readonly #stopTargets = new Map<string, "cancelled" | "interrupted">();
  readonly #followUps = new Map<string, Promise<void>>();
  readonly #controlCleanups = new WeakMap<TaskAdapterControl, Promise<void>>();
  #initialization?: Promise<TaskRecord[]>;
  #initialized = false;
  #shuttingDown = false;
  constructor(readonly store: TaskStore, readonly adapters: ReadonlyMap<string, TaskAdapter>, readonly authority: TaskBindingAuthority, readonly now = () => new Date()) {}
  initialize(): Promise<TaskRecord[]> {
    if (this.#initialization) return this.#initialization;
    this.#initialization = (async () => {
      await this.store.initialize(); const rows = await this.store.recover(this.now().toISOString()); this.#initialized = true; return rows;
    })();
    void this.#initialization.catch(() => { this.#initialization = undefined; });
    return this.#initialization;
  }
  #ready(): void { if (!this.#initialized) fail("tasks_uninitialized", "Tasks are not initialized.", 503); }
  get(id: string): Promise<TaskRecord> { this.#ready(); return this.store.read(id); }
  list(): Promise<TaskRecord[]> { this.#ready(); return this.store.list(); }
  #actor<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.#actors.get(id) ?? Promise.resolve(); const result = prior.catch(() => {}).then(action);
    const tail = result.then(() => undefined, () => undefined); this.#actors.set(id, tail);
    void tail.finally(() => { if (this.#actors.get(id) === tail) this.#actors.delete(id); }); return result;
  }
  async #update(id: string, change: (record: TaskRecord) => boolean): Promise<TaskRecord> {
    const record = await this.store.read(id);
    if (!change(record)) return record;
    record.updatedAt = highWaterTimestamp(record, this.now().toISOString()); await this.store.write(record); return record;
  }
  #appendEvent(record: TaskRecord, code: string, message: string): void {
    const sequence = record.eventCursor.nextSequence++;
    record.events.push({ sequence, at: highWaterTimestamp(record, this.now().toISOString()), code, message: safeText(message, MAX_TASK_EVENT_MESSAGE).text });
    if (record.events.length > MAX_TASK_EVENTS) { record.events.shift(); record.eventCursor.dropped += 1; }
  }
  async start(input: { parent: ConversationIdentity; harness: string; agent?: string; task: string; binding: TaskBindingReceipt }): Promise<TaskRecord> {
    this.#ready(); if (this.#shuttingDown) fail("tasks_shutting_down", "Tasks are shutting down.", 503);
    if (!validParent(input.parent) || typeof input.harness !== "string"
      || !HARNESS.test(input.harness) || typeof input.task !== "string"
      || input.task.trim() === "" || input.task.length > MAX_TASK_TEXT
      || (input.agent !== undefined && (input.harness !== "claude-code"
        || typeof input.agent !== "string" || input.agent.length < 1
        || input.agent.length > MAX_TASK_AGENT
        || Buffer.byteLength(input.agent, "utf8") > MAX_TASK_AGENT * 4))
      || !validBinding(input.binding)) fail("invalid_task", "The task request is invalid.");
    if (!this.adapters.has(input.harness)) fail("task_harness_unavailable", "That task harness is unavailable.", 409);
    const at = this.now().toISOString(); const id = `task-${randomUUID()}`;
    const expectedBinding = bindingCopy(input.binding);
    const record: TaskRecord = { version: 1, id, generation: 1, parent: { ...input.parent }, harness: input.harness, agent: input.agent ?? null,
      task: safeText(input.task, MAX_TASK_TEXT).text, binding: expectedBinding, state: "queued", createdAt: at, updatedAt: at,
      events: [], eventCursor: { nextSequence: 1, dropped: 0 }, result: null, resultTruncated: false, error: null };
    const abort = new AbortController();
    const persisted = this.store.write(record);
    const tracked: TrackedLaunch = { generation: record.generation, abort, persisted, promise: Promise.resolve() };
    tracked.promise = (async () => {
      await persisted;
      if (this.#shuttingDown) abort.abort();
      if (!abort.signal.aborted) await this.#launch(id, record.generation, abort);
    })().finally(() => {
      if (this.#launches.get(id) === tracked) this.#launches.delete(id);
    });
    this.#launches.set(id, tracked); void tracked.promise.catch(() => {});
    await persisted;
    if (this.#shuttingDown) abort.abort();
    if (abort.signal.aborted) fail("tasks_shutting_down", "Task admission was interrupted by shutdown.", 503);
    return record;
  }
  async #launch(id: string, generation: number, abort: AbortController): Promise<void> {
    try {
      const record = await this.#actor(id, () => this.#update(id, (row) => {
        if (row.generation !== generation || row.state !== "queued") return false;
        row.state = "starting"; return true;
      }));
      if (record.generation !== generation || record.state !== "starting") return;
      const expected = bindingCopy(record.binding);
      const authorityInput = bindingCopy(expected);
      const authorityResult = await abortable(this.authority.revalidate(authorityInput, abort.signal, { ...record.parent }), abort.signal);
      if (!validBinding(authorityResult)) throw new Error("binding changed");
      const binding = bindingCopy(authorityResult);
      if (!sameBinding(binding, expected)) throw new Error("binding changed");
      let live: LiveTask | undefined;
      const running = await this.#actor(id, async () => {
        const current = await this.store.read(id);
        if (current.generation !== generation || current.state !== "starting") return current;
        const adapter = this.adapters.get(current.harness); if (!adapter) throw new Error("adapter disappeared");
        let control: TaskAdapterControl | undefined;
        let handle: Promise<TaskAdapterHandle>;
        try {
          handle = Promise.resolve(adapter.start({ id, task: current.task, agent: current.agent, cwd: binding.cwd, binding: bindingCopy(binding) }, {
            signal: abort.signal,
            register(value) { if (control) throw new Error("control registered twice"); control = value; },
            emit: (event) => this.#emit(id, generation, event),
          }));
        } catch (error) {
          handle = Promise.reject(error);
        }
        void handle.catch(() => {});
        void handle.then((native) => native.result.catch(() => {}), () => {});
        if (!control || typeof control.force !== "function" || !(control.quiescence instanceof Promise)) { abort.abort(); void handle.catch(() => {}); throw new Error("missing control registration"); }
        live = { generation, abort, control, handle }; this.#live.set(id, live);
        return this.#update(id, (row) => {
          if (row.generation !== generation || row.state !== "starting") return false;
          row.state = "running"; return true;
        });
      });
      if (!live || running.state !== "running") return;
      const native = await abortable(live.handle, abort.signal);
      const result = await abortable(native.result, abort.signal);
      await abortable(live.control.quiescence, abort.signal);
      await this.#actor(id, () => this.#update(id, (row) => {
        if (row.generation !== generation || TERMINAL.has(row.state)) return false;
        if (row.state === "cancelling") { row.state = "cancelled"; return true; }
        const safe = safeText(result, MAX_TASK_RESULT); row.state = "completed"; row.result = safe.text; row.resultTruncated = safe.truncated; return true;
      }));
      this.#live.delete(id);
    } catch (error) {
      if (!(error instanceof TaskAborted)) abort.abort();
      if (error instanceof TaskAborted) return;
      const live = this.#live.get(id);
      if (live?.generation === generation) {
        try {
          await this.#cleanup(live);
        }
        catch {
          await this.#actor(id, () => this.#update(id, (row) => {
            if (row.generation !== generation || TERMINAL.has(row.state)) return false;
            row.state = "cancelling"; this.#appendEvent(row, "quiescence_failed", "The native task has not confirmed quiescence."); return true;
          })).catch(() => {});
          return;
        }
      }
      await this.#actor(id, async () => {
        const row = await this.store.read(id); if (row.generation !== generation || TERMINAL.has(row.state)) return;
        await this.#update(id, (current) => {
          if (current.generation !== generation || TERMINAL.has(current.state)) return false;
          current.state = "failed"; current.error = { code: "task_failed", message: "The native task failed safely." }; return true;
        });
      }).catch(() => {});
      if (this.#live.get(id)?.generation === generation) this.#live.delete(id);
    }
  }
  #cleanup(live: LiveTask): Promise<void> {
    const existing = this.#controlCleanups.get(live.control); if (existing) return existing;
    live.abort.abort();
    const cleanup = (async () => { try { await live.control.force(); } catch {} await live.control.quiescence; })();
    this.#controlCleanups.set(live.control, cleanup); return cleanup;
  }
  async #emit(id: string, generation: number, event: { code: string; message: string }): Promise<void> {
    if (!CODE.test(event.code)) return;
    await this.#actor(id, async () => {
      const current = await this.store.read(id); if (current.generation !== generation || TERMINAL.has(current.state)) return;
      await this.#update(id, (row) => {
        if (row.generation !== generation || TERMINAL.has(row.state)) return false;
        this.#appendEvent(row, event.code, event.message); return true;
      });
    });
  }
  #serializeFollowUp<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.#followUps.get(id) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(action); const tail = result.then(() => undefined, () => undefined);
    this.#followUps.set(id, tail);
    void tail.finally(() => { if (this.#followUps.get(id) === tail) this.#followUps.delete(id); });
    return result;
  }
  followUp(id: string, message: string, parent?: ConversationIdentity): Promise<TaskRecord> {
    this.#ready(); return this.#serializeFollowUp(id, async () => {
      const admitted = await this.#actor(id, async () => {
        const row = await this.store.read(id);
        if (parent && !sameParent(row.parent, parent)) {
          fail("task_not_found", "Task not found.", 404);
        }
        if (typeof message !== "string" || message.trim() === ""
          || message.length > MAX_TASK_TEXT) {
          fail("invalid_task", "The task follow-up is invalid.");
        }
        if (row.state !== "running") fail("task_not_running", "Follow-up requires a running task.", 409);
        const live = this.#live.get(id);
        if (!live || live.generation !== row.generation) fail("task_not_running", "The native task is not running.", 409);
        return { generation: row.generation, live };
      });
      try {
        const native = await abortable(admitted.live.handle, admitted.live.abort.signal);
        await abortable(Promise.resolve(native.followUp(safeText(message, MAX_TASK_TEXT).text)), admitted.live.abort.signal);
      } catch (error) {
        if (error instanceof TaskAborted) fail("task_not_running", "The task stopped before the follow-up settled.", 409);
        await this.#actor(id, () => this.#update(id, (current) => {
          if (current.generation !== admitted.generation || current.state !== "running") return false;
          this.#appendEvent(current, "follow_up_failed", "The native task rejected a follow-up."); return true;
        }));
        fail("task_follow_up_failed", "The native task rejected the follow-up.", 502);
      }
      return this.store.read(id);
    });
  }
  async cancel(id: string, parent?: ConversationIdentity): Promise<TaskRecord> {
    this.#ready();
    if (parent && !sameParent((await this.store.read(id)).parent, parent)) {
      fail("task_not_found", "Task not found.", 404);
    }
    return this.#sharedStop(id, "cancelled");
  }
  #sharedStop(id: string, final: "cancelled" | "interrupted"): Promise<TaskRecord> {
    if (final === "interrupted" || !this.#stopTargets.has(id)) this.#stopTargets.set(id, final);
    const launch = this.#launches.get(id); launch?.abort.abort();
    const live = this.#live.get(id); const cleanup = live ? this.#cleanup(live) : undefined;
    const existing = this.#stops.get(id); if (existing) return existing;
    const stop = this.#stop(id, cleanup).catch((error: unknown) => {
      if (error instanceof GhostError) throw error;
      throw new GhostError("task_storage_failed", "Task state could not be settled after native quiescence.", 500);
    });
    this.#stops.set(id, stop);
    void stop.finally(() => {
      if (this.#stops.get(id) === stop) { this.#stops.delete(id); this.#stopTargets.delete(id); }
    }).catch(() => {});
    return stop;
  }
  async #stop(id: string, cleanup: Promise<void> | undefined): Promise<TaskRecord> {
    const admittedLaunch = this.#launches.get(id);
    try { await cleanup; }
    catch { throw new GhostError("task_cancel_failed", "The native task did not confirm quiescence.", 502); }
    await admittedLaunch?.persisted;
    const prepared = await this.#actor(id, async () => {
      const row = await this.store.read(id);
      const launch = this.#launches.get(id); const live = this.#live.get(id); const followUp = this.#followUps.get(id);
      const destination = this.#stopTargets.get(id) ?? "cancelled";
      if (TERMINAL.has(row.state) && destination === "cancelled") return { row, alreadyTerminal: true };
      if (TERMINAL.has(row.state)) return { row, launch, live, followUp, alreadyTerminal: true };
      const next = await this.#update(id, (current) => {
        if (TERMINAL.has(current.state) || current.state === "cancelling") return false;
        current.state = "cancelling"; return true;
      });
      return { row: next, live, launch, followUp, alreadyTerminal: false };
    });
    if (!("launch" in prepared)) return prepared.row;
    prepared.launch?.abort.abort();
    try { await prepared.launch?.promise; await prepared.followUp; }
    catch {
      await this.#actor(id, () => this.#update(id, (row) => {
        if (TERMINAL.has(row.state)) return false;
        this.#appendEvent(row, "cancel_failed", "The native task did not confirm quiescence."); return true;
      }));
      throw new GhostError("task_cancel_failed", "The native task did not confirm quiescence.", 502);
    }
    if (prepared.alreadyTerminal) {
      if (prepared.live && this.#live.get(id)?.generation === prepared.live.generation) this.#live.delete(id);
      return this.store.read(id);
    }
    let settled = await this.#actor(id, () => this.#update(id, (row) => {
      if (row.generation !== prepared.row.generation || TERMINAL.has(row.state)) return false;
      const destination = this.#stopTargets.get(id) ?? "cancelled";
      row.state = destination;
      if (destination === "interrupted") row.error = { code: "daemon_shutdown", message: "The daemon stopped the task after native quiescence." };
      return true;
    }));
    if (this.#stopTargets.get(id) === "interrupted" && settled.state === "cancelled") {
      settled = await this.#actor(id, () => this.#update(id, (row) => {
        if (row.generation !== prepared.row.generation || row.state !== "cancelled") return false;
        row.state = "interrupted";
        row.error = { code: "daemon_shutdown", message: "The daemon stopped the task after native quiescence." };
        return true;
      }));
    }
    if (this.#live.get(id)?.generation === prepared.row.generation) this.#live.delete(id);
    return settled;
  }
  async beginShutdown(): Promise<void> {
    this.#ready(); this.#shuttingDown = true;
    const admitted = [...this.#launches.entries()];
    const live = [...this.#live.entries()];
    const activeStops = [...this.#stops.keys()];
    for (const [, launch] of admitted) launch.abort.abort();
    const cleanups = live.map(([, task]) => this.#cleanup(task));
    for (const id of activeStops) this.#stopTargets.set(id, "interrupted");
    const failures: unknown[] = [];
    const collect = (results: PromiseSettledResult<unknown>[]) => {
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    };
    collect(await Promise.allSettled([
      ...admitted.map(([, launch]) => launch.persisted),
      ...admitted.map(([, launch]) => launch.promise),
      ...cleanups,
    ]));
    let rows: TaskRecord[] = [];
    try { rows = await this.store.list(); } catch (error) { failures.push(error); }
    const ids = new Set(rows.filter((row) => !TERMINAL.has(row.state)).map((row) => row.id));
    for (const [id] of admitted) ids.add(id);
    for (const [id] of live) ids.add(id);
    for (const id of activeStops) ids.add(id);
    collect(await Promise.allSettled([...ids].map((id) => this.#sharedStop(id, "interrupted"))));
    collect(await Promise.allSettled([...this.#launches.values()].map((launch) => launch.promise)));
    collect(await Promise.allSettled([...this.#followUps.values()]));
    if (failures.length > 0) throw new GhostError("task_shutdown_failed", "Task shutdown finished with durable-state failures.", 500);
  }
  async forceAll(): Promise<void> {
    this.#ready(); const ids = new Set([...this.#live.keys(), ...this.#launches.keys()]);
    await Promise.all([...ids].map((id) => this.#sharedStop(id, "interrupted")));
  }
  async dispose(): Promise<void> {
    await this.beginShutdown(); await this.forceAll(); await this.store.dispose(); this.#initialized = false; this.#initialization = undefined;
  }
}
