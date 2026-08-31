import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { redactMemorySecrets } from "@ghost/extensions";
import type { ConversationIdentity } from "./conversation-identity.js";
import { parseConversationIdentity } from "./conversation-identity.js";
import { GhostError } from "./ghosts.js";
import { readPrivateFileText, writePrivateJsonAtomic } from "./private-file.js";

export const TASK_RECORD_VERSION = 1;
export const TASKS_DIRNAME = ".tasks";
export const MAX_TASK_TEXT = 65_536;
export const MAX_TASK_RESULT = 65_536;
export const MAX_TASK_EVENTS = 64;
export const MAX_TASK_EVENT_MESSAGE = 2_000;

export type TaskState = "queued" | "starting" | "running" | "cancelling"
  | "completed" | "failed" | "cancelled" | "interrupted";
export type TaskEvent = Readonly<{ sequence: number; at: string; code: string; message: string }>;
export type TaskFailure = Readonly<{ code: string; message: string }>;

export interface TaskRecord {
  version: 1;
  id: string;
  parent: ConversationIdentity;
  harness: string;
  task: string;
  cwd: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  events: TaskEvent[];
  eventsTruncated: boolean;
  result: string | null;
  resultTruncated: boolean;
  error: TaskFailure | null;
}

export interface TaskAdapterHandle {
  readonly result: Promise<string>;
  followUp(message: string): Promise<void>;
  /** Resolves only after the complete native task is quiescent. */
  cancel(): Promise<void>;
}

export interface TaskAdapter {
  start(input: Readonly<{ id: string; task: string; cwd: string }>, emit: (event: Readonly<{ code: string; message: string }>) => Promise<void>): Promise<TaskAdapterHandle>;
}

const STATES = new Set<TaskState>(["queued", "starting", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"]);
const TERMINAL = new Set<TaskState>(["completed", "failed", "cancelled", "interrupted"]);
const ID = /^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
const HARNESS = /^[a-z0-9][a-z0-9-]{0,63}$/u;

function bounded(value: string, maximum: number): { text: string; truncated: boolean } {
  const safe = redactMemorySecrets([...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && character !== "\t" && character !== "\n" && character !== "\r") || code === 127 ? "�" : character;
  }).join(""));
  return safe.length <= maximum ? { text: safe, truncated: false } : { text: safe.slice(0, maximum), truncated: true };
}

function invalid(message: string): never { throw new GhostError("invalid_task", message, 400); }

function assertInput(input: { parent: ConversationIdentity; harness: string; task: string; cwd: string }): void {
  if (!parseConversationIdentity(input.parent.id)
    || parseConversationIdentity(input.parent.id)?.conversationId !== input.parent.conversationId
    || parseConversationIdentity(input.parent.id)?.runtime !== input.parent.runtime) invalid("The parent conversation identity is invalid.");
  if (!HARNESS.test(input.harness)) invalid("The task harness id is invalid.");
  if (input.task.length === 0 || input.task.length > MAX_TASK_TEXT) invalid(`Task text must contain 1-${MAX_TASK_TEXT} characters.`);
  if (!isAbsolute(input.cwd) || resolve(input.cwd) !== input.cwd || input.cwd.length > 4096) invalid("The task cwd must be an absolute canonical path.");
}

function parseRecord(value: unknown): TaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("The task record is invalid.");
  const record = value as Record<string, unknown>;
  const keys = ["version", "id", "parent", "harness", "task", "cwd", "state", "createdAt", "updatedAt", "events", "eventsTruncated", "result", "resultTruncated", "error"];
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) invalid("The task record has an unknown or missing field.");
  if (record.version !== 1 || typeof record.id !== "string" || !ID.test(record.id)
    || typeof record.harness !== "string" || typeof record.task !== "string" || typeof record.cwd !== "string"
    || typeof record.state !== "string" || !STATES.has(record.state as TaskState)
    || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string"
    || !Array.isArray(record.events) || typeof record.eventsTruncated !== "boolean"
    || !(record.result === null || typeof record.result === "string") || typeof record.resultTruncated !== "boolean") invalid("The task record is invalid.");
  assertInput({ parent: record.parent as ConversationIdentity, harness: record.harness, task: record.task, cwd: record.cwd });
  if (record.events.length > MAX_TASK_EVENTS) invalid("The task event history is invalid.");
  for (const [index, raw] of record.events.entries()) {
    const event = raw as Partial<TaskEvent>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || event.sequence !== index + 1
      || typeof event.at !== "string" || typeof event.code !== "string" || !CODE.test(event.code)
      || typeof event.message !== "string" || event.message.length > MAX_TASK_EVENT_MESSAGE) invalid("The task event history is invalid.");
  }
  if (!(record.error === null || (typeof record.error === "object" && !Array.isArray(record.error)
    && CODE.test(String((record.error as TaskFailure).code)) && typeof (record.error as TaskFailure).message === "string"))) invalid("The task error is invalid.");
  return record as unknown as TaskRecord;
}

export class TaskStore {
  readonly dir: string;
  constructor(ghostHome: string) {
    if (!isAbsolute(ghostHome) || resolve(ghostHome) !== ghostHome) invalid("The ghost home must be an absolute canonical path.");
    this.dir = join(ghostHome, TASKS_DIRNAME);
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }

  path(id: string): string { if (!ID.test(id)) invalid("The task id is invalid."); return join(this.dir, `${id}.json`); }

  async read(id: string): Promise<TaskRecord> {
    const path = this.path(id);
    const stats = await lstat(path).catch(() => null);
    if (!stats) throw new GhostError("task_not_found", "Task not found.", 404);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || (stats.mode & 0o777) !== 0o600) invalid("The task record is not a private regular file.");
    try { return parseRecord(JSON.parse(await readPrivateFileText(path))); }
    catch (error) { if (error instanceof GhostError) throw error; invalid("The task record is not valid JSON."); }
  }

  async write(record: TaskRecord): Promise<void> { await this.initialize(); await writePrivateJsonAtomic(this.path(record.id), record); }

  async recover(): Promise<TaskRecord[]> {
    await this.initialize();
    const files = (await readdir(this.dir)).filter((name) => /^task-.*\.json$/u.test(name)).sort();
    const recovered: TaskRecord[] = [];
    for (const file of files) {
      const record = await this.read(file.slice(0, -5));
      if (!TERMINAL.has(record.state)) {
        record.state = "interrupted";
        record.updatedAt = new Date().toISOString();
        record.error = { code: "daemon_restarted", message: "The daemon restarted before the task settled." };
        await this.write(record);
      }
      recovered.push(record);
    }
    return recovered;
  }
}

export class TaskController {
  readonly #store: TaskStore;
  readonly #adapters: ReadonlyMap<string, TaskAdapter>;
  readonly #handles = new Map<string, TaskAdapterHandle>();
  readonly #runs = new Map<string, Promise<void>>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #writes = new Map<string, Promise<void>>();
  readonly #now: () => Date;

  constructor(store: TaskStore, adapters: ReadonlyMap<string, TaskAdapter>, now = () => new Date()) { this.#store = store; this.#adapters = adapters; this.#now = now; }

  async initialize(): Promise<TaskRecord[]> { return this.#store.recover(); }

  async start(input: { parent: ConversationIdentity; harness: string; task: string; cwd: string }): Promise<TaskRecord> {
    assertInput(input);
    if (!this.#adapters.has(input.harness)) throw new GhostError("task_harness_unavailable", "That task harness is unavailable.", 409);
    const at = this.#now().toISOString();
    const record: TaskRecord = { version: 1, id: `task-${randomUUID()}`, parent: input.parent, harness: input.harness,
      task: bounded(input.task, MAX_TASK_TEXT).text, cwd: input.cwd, state: "queued", createdAt: at, updatedAt: at,
      events: [], eventsTruncated: false, result: null, resultTruncated: false, error: null };
    await this.#store.write(record);
    const run = this.#run(record.id).finally(() => { this.#runs.delete(record.id); });
    this.#runs.set(record.id, run);
    return record;
  }

  async #mutate(id: string, change: (record: TaskRecord) => void): Promise<TaskRecord> {
    const previous = this.#writes.get(id) ?? Promise.resolve();
    let updated!: TaskRecord;
    const write = previous.catch(() => {}).then(async () => {
      const record = await this.#store.read(id); change(record); record.updatedAt = this.#now().toISOString(); await this.#store.write(record); updated = record;
    });
    const tail = write.then(() => undefined, () => undefined);
    this.#writes.set(id, tail);
    try { await write; return updated; }
    finally { if (this.#writes.get(id) === tail) this.#writes.delete(id); }
  }

  async #run(id: string): Promise<void> {
    const initial = await this.#store.read(id);
    const adapter = this.#adapters.get(initial.harness);
    if (!adapter) throw new GhostError("task_harness_unavailable", "That task harness is unavailable.", 409);
    let shouldStart = false;
    await this.#mutate(id, (record) => {
      if (record.state === "queued") {
        record.state = "starting";
        shouldStart = true;
      } else if (record.state === "cancelling") {
        record.state = "cancelled";
      }
    });
    if (!shouldStart) return;
    try {
      const handle = await adapter.start({ id, task: initial.task, cwd: initial.cwd }, async (event) => {
        if (!CODE.test(event.code)) return;
        await this.#mutate(id, (record) => {
          const message = bounded(event.message, MAX_TASK_EVENT_MESSAGE).text;
          record.events.push({ sequence: record.events.length + 1, at: this.#now().toISOString(), code: event.code, message });
          if (record.events.length > MAX_TASK_EVENTS) { record.events.shift(); record.eventsTruncated = true; record.events.forEach((entry, index) => { (entry as { sequence: number }).sequence = index + 1; }); }
        });
      });
      this.#handles.set(id, handle);
      const current = await this.#store.read(id);
      if (current.state === "cancelling") {
        await handle.cancel();
        await this.#mutate(id, (record) => { record.state = "cancelled"; });
        return;
      }
      await this.#mutate(id, (record) => { record.state = "running"; });
      const result = await handle.result;
      await this.#mutate(id, (record) => {
        if (TERMINAL.has(record.state)) return;
        if (record.state === "cancelling") record.state = "cancelled"; else record.state = "completed";
        const safe = bounded(result, MAX_TASK_RESULT); record.result = safe.text; record.resultTruncated = safe.truncated;
      });
    } catch {
      await this.#mutate(id, (record) => {
        if (TERMINAL.has(record.state)) return;
        record.state = "failed"; record.error = { code: "task_failed", message: "The native task failed." };
      });
    } finally { this.#handles.delete(id); }
  }

  #serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#operations.set(id, tail); void tail.finally(() => { if (this.#operations.get(id) === tail) this.#operations.delete(id); });
    return result;
  }

  followUp(id: string, message: string): Promise<TaskRecord> {
    return this.#serialize(id, async () => {
      const record = await this.#store.read(id);
      if (record.state !== "running") throw new GhostError("task_not_running", "Follow-up is accepted only while the task is running.", 409);
      if (!message || message.length > MAX_TASK_TEXT) invalid("The follow-up is invalid.");
      const handle = this.#handles.get(id);
      if (!handle) throw new GhostError("task_not_running", "The native task is not running.", 409);
      await handle.followUp(bounded(message, MAX_TASK_TEXT).text);
      return this.#store.read(id);
    });
  }

  cancel(id: string): Promise<TaskRecord> {
    return this.#serialize(id, async () => {
      let record = await this.#store.read(id);
      if (TERMINAL.has(record.state)) return record;
      record = await this.#mutate(id, (current) => { current.state = "cancelling"; });
      const handle = this.#handles.get(id);
      if (handle) {
        await handle.cancel();
        record = await this.#mutate(id, (current) => { if (!TERMINAL.has(current.state)) current.state = "cancelled"; });
      } else {
        await this.#runs.get(id);
        record = await this.#store.read(id);
      }
      return record;
    });
  }
}
