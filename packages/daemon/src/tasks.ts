/** Persistent task lifecycle shared by every worker harness. */
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import type { ConversationIdentity } from "./conversation-identity.js";
import { requireConversationIdentity } from "./conversation-identity.js";
import {
  GHOST_TASKS_DIRNAME,
  GhostError,
  ghostPaths,
  type GhostRegistry,
} from "./ghosts.js";
import type {
  HomeMoveParticipantReservation,
  HomeOperationCoordinator,
} from "./home-operations.js";
import { silentLogger, type Logger } from "./log.js";
import {
  MAX_PRIVATE_FILE_BYTES,
  readPrivateFileText,
  writePrivateJsonAtomic,
} from "./private-file.js";
import { serializeByKey } from "./promise-chain.js";
import { WORKER_IDS, type WorkerId } from "./worker-identity.js";

export const TASKS_DIRNAME = GHOST_TASKS_DIRNAME;
export const TASK_RECORD_VERSION = 1;
export const TASK_STATES = [
  "queued",
  "starting",
  "running",
  "waiting_for_owner",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type TaskState = typeof TASK_STATES[number];

export const MAX_TASK_PROMPT_LENGTH = 64_000;
export const MAX_TASK_RESULT_LENGTH = 128_000;
export const MAX_TASK_EVENT_TEXT_LENGTH = 4_000;
export const MAX_TASK_EVENTS = 100;
export const MAX_TASK_RECORD_BYTES = MAX_PRIVATE_FILE_BYTES;

const TASK_ID_PATTERN = /^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_CWD_LENGTH = 4_096;
const MAX_NATIVE_SESSION_ID_LENGTH = 2_000;
const MAX_ERROR_CODE_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 4_000;
const MAX_TASK_PREVIEW_LENGTH = 160;

export interface TaskErrorView {
  code: string;
  message: string;
  messageTruncated: boolean;
}

export interface TaskEvent {
  sequence: number;
  at: string;
  type: "state" | "output" | "notice" | "owner_message" | "principal_message";
  state?: TaskState;
  text?: string;
  textTruncated?: boolean;
}

export interface TaskView {
  version: typeof TASK_RECORD_VERSION;
  id: string;
  parent: ConversationIdentity;
  agent: WorkerId;
  task: string;
  root: string;
  cwd: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  nativeSessionId: string | null;
  result: string | null;
  resultTruncated: boolean;
  error: TaskErrorView | null;
  events: TaskEvent[];
  eventsTruncated: boolean;
}

export interface TaskSummary {
  id: string;
  parent: ConversationIdentity;
  agent: WorkerId;
  taskPreview: string;
  root: string;
  cwd: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  nativeSessionId: string | null;
  resultPreview: string | null;
  resultTruncated: boolean;
  error: TaskErrorView | null;
}

export interface TaskListView {
  tasks: TaskSummary[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface StartTaskInput {
  ghostName: string;
  parent: ConversationIdentity;
  agent: WorkerId;
  task: string;
  cwd?: string;
}

export interface ResolvedTaskContext {
  root: string;
  cwd: string;
}

export type TaskContextResolver = (input: {
  ghostName: string;
  parent: ConversationIdentity;
  requestedCwd?: string;
  agent: WorkerId;
}) => Promise<ResolvedTaskContext>;

export type WorkerAdapterEvent =
  | { type: "output"; text: string }
  | { type: "notice"; text: string }
  | { type: "waiting_for_owner"; text?: string }
  | { type: "resumed"; text?: string };

export interface WorkerTaskRequest {
  taskId: string;
  ghostName: string;
  parent: ConversationIdentity;
  task: string;
  root: string;
  cwd: string;
}

export interface WorkerTaskResult {
  text: string;
  nativeSessionId?: string;
}

/** A native controller confirmed it stopped, but its terminal outcome was a worker failure. */
export class WorkerStoppedError extends Error {
  override readonly name = "WorkerStoppedError";
}

export interface WorkerTaskController {
  nativeSessionId?: string;
  result: Promise<WorkerTaskResult>;
  send?(text: string): void | Promise<void>;
  /** Resolves only after this native task can no longer keep working. */
  cancel(): void | Promise<void>;
}

export interface WorkerAdapter {
  readonly id: WorkerId;
  start(
    request: WorkerTaskRequest,
    context: {
      signal: AbortSignal;
      emit(event: WorkerAdapterEvent): Promise<void>;
      /** Register the one captured native operation's emergency shutdown action. */
      registerForce(force: () => void): void;
    },
  ): Promise<WorkerTaskController>;
}

export interface TaskManagerOptions {
  registry: GhostRegistry;
  adapters?: readonly WorkerAdapter[];
  resolveContext?: TaskContextResolver;
  homeOperations?: HomeOperationCoordinator;
  now?: () => number;
  logger?: Logger;
}

export type CancelTaskOutcome = "cancelled" | "cancellation_requested" | "already_settled";

export interface CancelTaskResult {
  outcome: CancelTaskOutcome;
  task: TaskView;
}

interface StoredTask extends TaskView {
  ghostName: string;
}

interface TaskStoreListing {
  records: StoredTask[];
  skipped: TaskListView["skipped"];
}

interface LiveTask {
  ghostName: string;
  taskId: string;
  adapter: WorkerAdapter;
  abort: AbortController;
  controller?: WorkerTaskController;
  cancellation?: Promise<void>;
  failureAfterStop?: TaskErrorView;
  force?: () => void;
  forceRequested?: boolean;
  settled: Promise<void>;
  settle(): void;
}

interface OpeningTask {
  ghostName: string;
  settled: Promise<void>;
  settle(): void;
}

export type TaskMessageActor = "owner" | "principal";

function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && TASK_STATES.includes(value as TaskState);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return state === "completed"
    || state === "failed"
    || state === "cancelled"
    || state === "interrupted";
}

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["starting", "cancelling", "interrupted"],
  starting: ["running", "waiting_for_owner", "cancelling", "failed", "interrupted"],
  running: ["waiting_for_owner", "cancelling", "completed", "failed", "interrupted"],
  waiting_for_owner: ["running", "cancelling", "completed", "failed", "interrupted"],
  cancelling: ["completed", "cancelled", "failed", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function isWorkerId(value: unknown): value is WorkerId {
  return typeof value === "string" && WORKER_IDS.includes(value as WorkerId);
}

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function bounded(value: string, limit: number): { text: string; truncated: boolean } {
  return { text: boundedText(value, limit), truncated: value.length > limit };
}

function preview(value: string | null): string | null {
  if (value === null) return null;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_TASK_PREVIEW_LENGTH) return compact;
  return `${compact.slice(0, MAX_TASK_PREVIEW_LENGTH - 1)}…`;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validTaskError(value: unknown): value is TaskErrorView | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Partial<TaskErrorView>;
  return typeof error.code === "string"
    && error.code.length > 0
    && error.code.length <= MAX_ERROR_CODE_LENGTH
    && typeof error.message === "string"
    && error.message.length > 0
    && error.message.length <= MAX_ERROR_MESSAGE_LENGTH
    && typeof error.messageTruncated === "boolean";
}

function parseTaskEvent(value: unknown): TaskEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<TaskEvent>;
  if (!Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) <= 0
    || !validTimestamp(event.at)
    || !["state", "output", "notice", "owner_message", "principal_message"].includes(event.type ?? "")) {
    return null;
  }
  if (event.type === "state" && !isTaskState(event.state)) return null;
  if (event.type !== "state" && event.state !== undefined) return null;
  if (event.text !== undefined
    && (typeof event.text !== "string" || event.text.length > MAX_TASK_EVENT_TEXT_LENGTH)) {
    return null;
  }
  if ((event.text === undefined) !== (event.textTruncated === undefined)
    || (event.textTruncated !== undefined && typeof event.textTruncated !== "boolean")) {
    return null;
  }
  return {
    sequence: event.sequence as number,
    at: event.at as string,
    type: event.type as TaskEvent["type"],
    ...(event.state === undefined ? {} : { state: event.state }),
    ...(event.text === undefined ? {} : { text: event.text }),
    ...(event.textTruncated === undefined ? {} : { textTruncated: event.textTruncated }),
  };
}

function parseTaskParent(value: unknown): ConversationIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ConversationIdentity>;
  try {
    const parent = requireConversationIdentity(candidate.id ?? "");
    return parent.runtime === candidate.runtime
      && parent.conversationId === candidate.conversationId
      ? parent
      : null;
  } catch {
    return null;
  }
}

function parseTaskEvents(value: unknown): TaskEvent[] | null {
  if (!Array.isArray(value) || value.length > MAX_TASK_EVENTS) return null;
  const events: TaskEvent[] = [];
  let previousSequence = 0;
  for (const candidate of value) {
    const event = parseTaskEvent(candidate);
    if (!event || event.sequence <= previousSequence) return null;
    events.push(event);
    previousSequence = event.sequence;
  }
  return events;
}

function parseStoredTask(value: unknown, expectedGhost: string, expectedId: string): StoredTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<StoredTask>;
  if (record.version !== TASK_RECORD_VERSION
    || record.id !== expectedId
    || !isTaskId(record.id)
    || !isWorkerId(record.agent)
    || typeof record.task !== "string"
    || record.task.trim() === ""
    || record.task.length > MAX_TASK_PROMPT_LENGTH
    || typeof record.root !== "string"
    || !isAbsolute(record.root)
    || typeof record.cwd !== "string"
    || !isAbsolute(record.cwd)
    || !isTaskState(record.state)
    || !validTimestamp(record.createdAt)
    || !validTimestamp(record.updatedAt)
    || (record.nativeSessionId !== null
      && (typeof record.nativeSessionId !== "string"
        || record.nativeSessionId.length > MAX_NATIVE_SESSION_ID_LENGTH))
    || (record.result !== null
      && (typeof record.result !== "string" || record.result.length > MAX_TASK_RESULT_LENGTH))
    || typeof record.resultTruncated !== "boolean"
    || (record.result === null && record.resultTruncated)
    || !validTaskError(record.error)
    || typeof record.eventsTruncated !== "boolean") {
    return null;
  }
  const parent = parseTaskParent(record.parent);
  const events = parseTaskEvents(record.events);
  if (!parent || !events) return null;
  return {
    version: TASK_RECORD_VERSION,
    id: record.id,
    ghostName: expectedGhost,
    parent,
    agent: record.agent,
    task: record.task,
    root: record.root,
    cwd: record.cwd,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nativeSessionId: record.nativeSessionId,
    result: record.result,
    resultTruncated: record.resultTruncated,
    error: record.error,
    events,
    eventsTruncated: record.eventsTruncated,
  };
}

function publicTask(record: StoredTask): TaskView {
  const { ghostName: _ghostName, ...view } = record;
  return structuredClone(view);
}

function taskSummary(record: StoredTask): TaskSummary {
  return {
    id: record.id,
    parent: record.parent,
    agent: record.agent,
    taskPreview: preview(record.task) ?? "",
    root: record.root,
    cwd: record.cwd,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nativeSessionId: record.nativeSessionId,
    resultPreview: preview(record.result),
    resultTruncated: record.resultTruncated,
    error: record.error,
  };
}

function isWithin(root: string, cwd: string): boolean {
  const relation = relative(root, cwd);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function durableTask(record: StoredTask): Omit<StoredTask, "ghostName"> {
  const { ghostName: _ghostName, ...durable } = record;
  return durable;
}

function durableTaskBytes(record: StoredTask): number {
  return Buffer.byteLength(`${JSON.stringify(durableTask(record), null, 2)}\n`);
}

function fitDurableTask(record: StoredTask): void {
  while (record.events.length > 1 && durableTaskBytes(record) > MAX_TASK_RECORD_BYTES) {
    record.events.shift();
    record.eventsTruncated = true;
  }
  if (durableTaskBytes(record) <= MAX_TASK_RECORD_BYTES) return;

  if (record.result !== null) {
    const result = record.result;
    let lower = 0;
    let upper = result.length;
    while (lower < upper) {
      const midpoint = Math.ceil((lower + upper) / 2);
      record.result = result.slice(0, midpoint);
      if (durableTaskBytes(record) <= MAX_TASK_RECORD_BYTES) lower = midpoint;
      else upper = midpoint - 1;
    }
    record.result = result.slice(0, lower);
    if (lower < result.length) record.resultTruncated = true;
  }
  if (durableTaskBytes(record) > MAX_TASK_RECORD_BYTES) {
    throw new GhostError("task_state_too_large", "The task state exceeds its durable size limit.", 409);
  }
}

class TaskStore {
  constructor(private readonly registry: GhostRegistry) {}

  directory(ghostName: string): string {
    return ghostPaths(this.registry.get(ghostName).dir).taskDir;
  }

  async write(record: StoredTask): Promise<void> {
    const directory = this.ensureDirectory(record.ghostName);
    fitDurableTask(record);
    await writePrivateJsonAtomic(join(directory, `${record.id}.json`), durableTask(record));
  }

  read(ghostName: string, taskId: string): StoredTask | null {
    if (!isTaskId(taskId)) {
      throw new GhostError("invalid_task_id", "Task ids must be daemon-issued task UUIDs.", 400);
    }
    const path = join(this.ensureDirectory(ghostName), `${taskId}.json`);
    let raw: string;
    try {
      raw = readPrivateFileText(path);
    } catch (error) {
      const code = (error as Error & { cause?: NodeJS.ErrnoException }).cause?.code;
      if (code === "ENOENT") return null;
      throw new GhostError("task_state_invalid", "The task state file could not be read safely.", 409);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new GhostError("task_state_invalid", "The task state file is not valid JSON.", 409);
    }
    const record = parseStoredTask(parsed, ghostName, taskId);
    if (!record) {
      throw new GhostError("task_state_invalid", "The task state file does not match its contract.", 409);
    }
    return record;
  }

  list(ghostName: string): TaskStoreListing {
    const directory = this.ensureDirectory(ghostName);
    const records: StoredTask[] = [];
    const skipped: TaskListView["skipped"] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json") || !entry.isFile()) continue;
      const taskId = entry.name.slice(0, -".json".length);
      if (!isTaskId(taskId)) {
        skipped.push({ path: `${TASKS_DIRNAME}/${entry.name}`, reason: "invalid task filename" });
        continue;
      }
      try {
        const record = this.read(ghostName, taskId);
        if (record) records.push(record);
      } catch (error) {
        skipped.push({
          path: `${TASKS_DIRNAME}/${entry.name}`,
          reason: error instanceof GhostError ? error.code : "task_state_invalid",
        });
      }
    }
    records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    return { records, skipped };
  }

  private ensureDirectory(ghostName: string): string {
    const directory = this.directory(ghostName);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new GhostError("task_store_invalid", "The daemon task directory is unsafe.", 409);
    }
    return directory;
  }
}

/** Owns durable task state while adapters own vendor-native sessions and transcripts. */
export class TaskManager {
  private readonly registry: GhostRegistry;
  private readonly store: TaskStore;
  private readonly adapters = new Map<WorkerId, WorkerAdapter>();
  private readonly resolveContext: TaskContextResolver;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly live = new Map<string, LiveTask>();
  private readonly openings = new Set<OpeningTask>();
  private readonly pendingControllerOperations = new Set<OpeningTask>();
  private readonly homeMoveClaims = new Set<string>();
  private readonly controllerOperations = new Map<string, Promise<unknown>>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly restored = new Map<string, Promise<{ interrupted: number; invalid: number }>>();
  private readonly listeners = new Map<string, Set<(task: TaskView) => void>>();
  private readonly unregisterHomeMoveParticipant?: () => void;
  private shuttingDown = false;

  constructor(options: TaskManagerOptions) {
    this.registry = options.registry;
    this.store = new TaskStore(options.registry);
    for (const adapter of options.adapters ?? []) {
      if (this.adapters.has(adapter.id)) throw new Error(`Duplicate worker adapter ${adapter.id}.`);
      this.adapters.set(adapter.id, adapter);
    }
    this.resolveContext = options.resolveContext ?? (async () => {
      throw new GhostError("task_context_unavailable", "Task project context is not available.", 503);
    });
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.unregisterHomeMoveParticipant = options.homeOperations?.registerMoveParticipant({
      preclaim: (ghostName) => {
        if (this.hasActiveTask(ghostName)) {
          throw new GhostError(
            "ghost_busy",
            "Wait for this ghost's worker tasks to settle before moving it.",
            409,
          );
        }
      },
      reserve: (ghostName): HomeMoveParticipantReservation => {
        if (this.homeMoveClaims.has(ghostName)) {
          throw new GhostError("ghost_busy", "Another whole-home move is already in progress.", 409);
        }
        this.homeMoveClaims.add(ghostName);
        let released = false;
        return {
          drained: Promise.resolve(),
          release: () => {
            if (released) return;
            released = true;
            this.homeMoveClaims.delete(ghostName);
          },
        };
      },
    });
  }

  async create(input: StartTaskInput): Promise<TaskView> {
    this.registry.get(input.ghostName);
    this.assertAdmission(input.ghostName);
    const opened = Promise.withResolvers<void>();
    const opening: OpeningTask = {
      ghostName: input.ghostName,
      settled: opened.promise,
      settle: opened.resolve,
    };
    this.openings.add(opening);
    try {
      return await this.createFresh(input);
    } finally {
      this.openings.delete(opening);
      opening.settle();
    }
  }

  private async createFresh(input: StartTaskInput): Promise<TaskView> {
    await this.restoreGhost(input.ghostName);
    if (!isWorkerId(input.agent)) {
      throw new GhostError("unknown_worker", "Choose claude-code, codex, or pi-worker.", 400);
    }
    const adapter = this.adapters.get(input.agent);
    if (!adapter) {
      throw new GhostError(
        "worker_unavailable",
        `The ${input.agent} task adapter is not available yet.`,
        503,
      );
    }
    if (typeof input.task !== "string" || input.task.trim() === "") {
      throw new GhostError("invalid_task", "A task must be a non-empty string.", 400);
    }
    if (input.task.length > MAX_TASK_PROMPT_LENGTH) {
      throw new GhostError("task_too_large", `A task may be at most ${MAX_TASK_PROMPT_LENGTH} characters.`, 413);
    }
    if (input.cwd !== undefined
      && (typeof input.cwd !== "string" || input.cwd.trim() === "" || input.cwd.length > MAX_CWD_LENGTH)) {
      throw new GhostError("invalid_task_cwd", "cwd must be a non-empty path when supplied.", 400);
    }
    if (!input.parent || typeof input.parent !== "object" || typeof input.parent.id !== "string") {
      throw new GhostError("invalid_conversation_id", "The task parent identity is invalid.", 400);
    }
    const parent = requireConversationIdentity(input.parent.id);
    if (parent.runtime !== input.parent.runtime || parent.conversationId !== input.parent.conversationId) {
      throw new GhostError("invalid_conversation_id", "The task parent identity is inconsistent.", 400);
    }
    const context = await this.resolveContext({
      ghostName: input.ghostName,
      parent,
      agent: input.agent,
      ...(input.cwd === undefined ? {} : { requestedCwd: input.cwd }),
    });
    if (!isAbsolute(context.root) || !isAbsolute(context.cwd) || !isWithin(context.root, context.cwd)) {
      throw new GhostError("invalid_task_context", "The resolved task cwd must stay inside its project root.", 409);
    }
    this.assertAdmission(input.ghostName);

    const now = this.timestamp();
    const id = `task-${randomUUID()}`;
    const record: StoredTask = {
      version: TASK_RECORD_VERSION,
      id,
      ghostName: input.ghostName,
      parent,
      agent: input.agent,
      task: input.task,
      root: context.root,
      cwd: context.cwd,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      nativeSessionId: null,
      result: null,
      resultTruncated: false,
      error: null,
      events: [{ sequence: 1, at: now, type: "state", state: "queued" }],
      eventsTruncated: false,
    };
    await this.store.write(record);
    this.publish(record);
    this.start(record, adapter);
    return publicTask(record);
  }

  async list(ghostName: string): Promise<TaskListView> {
    this.registry.get(ghostName);
    await this.restoreGhost(ghostName);
    const listing = this.store.list(ghostName);
    return { tasks: listing.records.map(taskSummary), skipped: listing.skipped };
  }

  async get(ghostName: string, taskId: string): Promise<TaskView> {
    this.registry.get(ghostName);
    await this.restoreGhost(ghostName);
    return publicTask(this.requireRecord(ghostName, taskId));
  }

  async wait(ghostName: string, taskId: string): Promise<TaskView> {
    await this.restoreGhost(ghostName);
    const current = this.requireRecord(ghostName, taskId);
    if (isTerminalTaskState(current.state)) return publicTask(current);
    await this.live.get(this.key(ghostName, taskId))?.settled;
    return this.get(ghostName, taskId);
  }

  async send(
    ghostName: string,
    taskId: string,
    text: string,
    actor: TaskMessageActor = "owner",
  ): Promise<TaskView> {
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TASK_PROMPT_LENGTH) {
      throw new GhostError("invalid_task_message", "Task messages must be non-empty and bounded.", 400);
    }
    return this.withControllerOperation(ghostName, false, async () => {
      await this.restoreGhost(ghostName);
      return serializeByKey(
        this.controllerOperations,
        this.key(ghostName, taskId),
        () => this.sendFresh(ghostName, taskId, text, actor),
      );
    });
  }

  private async sendFresh(
    ghostName: string,
    taskId: string,
    text: string,
    actor: TaskMessageActor,
  ): Promise<TaskView> {
    const live = this.live.get(this.key(ghostName, taskId));
    const record = this.requireRecord(ghostName, taskId);
    if (isTerminalTaskState(record.state)) {
      throw new GhostError("task_settled", "This task has already settled.", 409);
    }
    if (record.state === "cancelling" || !live?.controller?.send) {
      throw new GhostError("task_not_steerable", "This worker cannot accept a message right now.", 409);
    }
    try {
      await live.controller.send(text);
    } catch {
      await this.mutate(ghostName, taskId, (current) => {
        if (isTerminalTaskState(current.state)) return false;
        this.appendEvent(current, "notice", "The worker did not accept that message.");
      });
      throw new GhostError("task_send_failed", "The worker did not accept that message.", 502);
    }
    await this.mutate(ghostName, taskId, (current) => {
      if (current.state === "cancelling"
        || current.state === "cancelled"
        || current.state === "interrupted") return false;
      this.appendEvent(current, actor === "owner" ? "owner_message" : "principal_message", text);
      if (current.state === "waiting_for_owner") this.changeState(current, "running");
    });
    return this.get(ghostName, taskId);
  }

  async cancel(ghostName: string, taskId: string): Promise<CancelTaskResult> {
    return this.withControllerOperation(ghostName, true, async () => {
      await this.restoreGhost(ghostName);
      // Cancellation is a priority control path. It must not queue behind a
      // steering request that the native worker may keep open for a full turn.
      return this.cancelFresh(ghostName, taskId);
    });
  }

  private async cancelFresh(ghostName: string, taskId: string): Promise<CancelTaskResult> {
    let alreadySettled = false;
    let task = await this.mutate(ghostName, taskId, (current) => {
      if (isTerminalTaskState(current.state)) {
        alreadySettled = true;
        return false;
      }
      if (current.state === "cancelling") return false;
      this.changeState(current, "cancelling");
      current.error = null;
    });
    if (alreadySettled) return { outcome: "already_settled", task };

    let outcome: CancelTaskOutcome = "cancellation_requested";
    const live = this.live.get(this.key(ghostName, taskId));
    live?.abort.abort();
    if (live?.controller) {
      try {
        await this.stopLive(live);
      } catch (error) {
        if (error instanceof WorkerStoppedError) {
          live.failureAfterStop = this.taskError("worker_failed", error.message);
        } else {
          await this.failCancellation(ghostName, taskId, error);
          live.cancellation = undefined;
          throw new GhostError("task_cancel_failed", "The worker did not confirm cancellation.", 502);
        }
      }
      task = await this.finishStoppedLive(live);
      this.detachLive(live);
      outcome = task.state === "cancelled" ? "cancelled" : "already_settled";
    }
    return { outcome, task };
  }

  subscribe(ghostName: string, taskId: string, listener: (task: TaskView) => void): () => void {
    const key = this.key(ghostName, taskId);
    const listeners = this.listeners.get(key) ?? new Set<(task: TaskView) => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  restoreGhost(ghostName: string): Promise<{ interrupted: number; invalid: number }> {
    const existing = this.restored.get(ghostName);
    if (existing) return existing;
    const restoring = this.restoreGhostFresh(ghostName).catch((error) => {
      this.restored.delete(ghostName);
      throw error;
    });
    this.restored.set(ghostName, restoring);
    return restoring;
  }

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const live of this.live.values()) {
      live.abort.abort();
    }
  }

  async disposeAll(): Promise<void> {
    this.beginShutdown();
    await Promise.allSettled([...this.openings].map((opening) => opening.settled));
    const active = [...this.live.values()];
    await Promise.allSettled(active.map((task) => this.cancel(task.ghostName, task.taskId)));
    await Promise.allSettled(
      [...this.pendingControllerOperations].map((operation) => operation.settled),
    );
    await Promise.allSettled(active.map((task) => task.settled));
    this.unregisterHomeMoveParticipant?.();
  }

  forceDisposeAll(): void {
    this.beginShutdown();
    for (const live of [...this.live.values()]) {
      live.forceRequested = true;
      live.force?.();
      void this.stopLive(live).catch(() => {});
      void this.mutate(live.ghostName, live.taskId, (record) => {
        if (isTerminalTaskState(record.state)) return false;
        record.error = this.taskError("daemon_stopped", "The daemon stopped before cancellation settled.");
        this.changeState(record, "interrupted");
      }).catch(() => {});
      this.detachLive(live);
    }
  }

  private start(record: StoredTask, adapter: WorkerAdapter): void {
    const settled = Promise.withResolvers<void>();
    const live: LiveTask = {
      ghostName: record.ghostName,
      taskId: record.id,
      adapter,
      abort: new AbortController(),
      settled: settled.promise,
      settle: settled.resolve,
    };
    this.live.set(this.key(record.ghostName, record.id), live);
    void this.run(live).finally(() => {
      this.live.delete(this.key(record.ghostName, record.id));
      live.settle();
    });
  }

  private async run(live: LiveTask): Promise<void> {
    const { ghostName, taskId, adapter } = live;
    try {
      const starting = await this.mutate(ghostName, taskId, (record) => {
        if (record.state !== "queued") return false;
        this.changeState(record, "starting");
      });
      if (starting.state !== "starting") {
        if (starting.state === "cancelling") await this.finishCancellation(ghostName, taskId);
        return;
      }
      const controller = await adapter.start({
        taskId,
        ghostName,
        parent: starting.parent,
        task: starting.task,
        root: starting.root,
        cwd: starting.cwd,
      }, {
        signal: live.abort.signal,
        emit: (event) => this.onAdapterEvent(ghostName, taskId, event),
        registerForce: (force) => {
          live.force = force;
          if (live.forceRequested) force();
        },
      });
      live.controller = controller;
      // Cancellation can settle the task before this run reaches its normal
      // result await. Attach immediately so a native rejected result never
      // escapes as an unhandled promise rejection.
      void controller.result.catch(() => {});
      if (controller.nativeSessionId !== undefined) {
        try {
          this.requireNativeSessionId(controller.nativeSessionId);
        } catch (error) {
          live.failureAfterStop = this.taskError(
            "worker_failed",
            error instanceof Error ? error.message : String(error),
          );
          await this.stopInvalidController(live);
          return;
        }
      }
      if (live.abort.signal.aborted
        || this.requireRecord(ghostName, taskId).state === "cancelling") {
        try {
          await this.stopLive(live);
          await this.finishStoppedLive(live);
          this.detachLive(live);
          return;
        } catch (error) {
          await this.failCancellation(ghostName, taskId, error);
          live.cancellation = undefined;
        }
      }
      await this.mutate(ghostName, taskId, (record) => {
        if (isTerminalTaskState(record.state) || record.state === "cancelling") return false;
        let changed = false;
        if (record.state === "starting") {
          this.changeState(record, "running");
          changed = true;
        }
        if (controller.nativeSessionId) {
          record.nativeSessionId = controller.nativeSessionId;
          changed = true;
        }
        return changed;
      });
      const result = await controller.result;
      if (!result || typeof result.text !== "string") {
        throw new Error("The worker returned an invalid result.");
      }
      if (result.nativeSessionId !== undefined) this.requireNativeSessionId(result.nativeSessionId);
      await this.mutate(ghostName, taskId, (record) => {
        if (isTerminalTaskState(record.state)) return false;
        const boundedResult = bounded(result.text, MAX_TASK_RESULT_LENGTH);
        record.result = boundedResult.text;
        record.resultTruncated = boundedResult.truncated;
        record.error = null;
        if (result.nativeSessionId) {
          record.nativeSessionId = result.nativeSessionId;
        }
        this.changeState(record, "completed");
      });
    } catch (error) {
      await this.settleRunError(live, error).catch((persistenceError) => {
        this.logger.error("task failure could not be persisted", {
          worker: adapter.id,
          task: taskId,
          error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
        });
      });
    }
  }

  private async onAdapterEvent(
    ghostName: string,
    taskId: string,
    event: WorkerAdapterEvent,
  ): Promise<void> {
    await this.mutate(ghostName, taskId, (record) => {
      if (isTerminalTaskState(record.state) || record.state === "cancelling") return false;
      switch (event.type) {
        case "output":
        case "notice":
          if (typeof event.text !== "string") throw new Error("The worker emitted invalid text.");
          this.appendEvent(record, event.type, event.text);
          break;
        case "waiting_for_owner":
          if (record.state !== "starting" && record.state !== "running") return false;
          this.changeState(record, "waiting_for_owner", event.text);
          break;
        case "resumed":
          if (record.state !== "waiting_for_owner") return false;
          this.changeState(record, "running", event.text);
          break;
      }
    });
  }

  private async restoreGhostFresh(ghostName: string): Promise<{ interrupted: number; invalid: number }> {
    this.registry.get(ghostName);
    const listing = this.store.list(ghostName);
    let interrupted = 0;
    for (const record of listing.records) {
      if (isTerminalTaskState(record.state)) continue;
      record.error = this.taskError(
        "daemon_restarted",
        "The daemon restarted before this task settled.",
      );
      this.changeState(record, "interrupted");
      record.updatedAt = this.timestamp();
      await this.store.write(record);
      this.publish(record);
      interrupted += 1;
    }
    return { interrupted, invalid: listing.skipped.length };
  }

  private requireRecord(ghostName: string, taskId: string): StoredTask {
    const record = this.store.read(ghostName, taskId);
    if (!record) throw new GhostError("task_not_found", "No such task.", 404);
    return record;
  }

  private async mutate(
    ghostName: string,
    taskId: string,
    change: (record: StoredTask) => boolean | void,
  ): Promise<TaskView> {
    const key = this.key(ghostName, taskId);
    return serializeByKey(this.mutations, key, async () => {
      const record = this.requireRecord(ghostName, taskId);
      const changed = change(record);
      if (changed === false) return publicTask(record);
      record.updatedAt = this.timestamp();
      await this.store.write(record);
      this.publish(record);
      return publicTask(record);
    });
  }

  private changeState(record: StoredTask, state: TaskState, text?: string): void {
    if (!TASK_TRANSITIONS[record.state].includes(state)) {
      throw new Error(`Invalid task transition ${record.state} -> ${state}.`);
    }
    record.state = state;
    this.appendEvent(record, "state", text, state);
  }

  private appendEvent(
    record: StoredTask,
    type: TaskEvent["type"],
    text?: string,
    state?: TaskState,
  ): void {
    const boundedEvent = text === undefined ? null : bounded(text, MAX_TASK_EVENT_TEXT_LENGTH);
    const event: TaskEvent = {
      sequence: (record.events.at(-1)?.sequence ?? 0) + 1,
      at: this.timestamp(),
      type,
      ...(state === undefined ? {} : { state }),
      ...(boundedEvent === null
        ? {}
        : { text: boundedEvent.text, textTruncated: boundedEvent.truncated }),
    };
    record.events.push(event);
    if (record.events.length > MAX_TASK_EVENTS) {
      record.events.splice(0, record.events.length - MAX_TASK_EVENTS);
      record.eventsTruncated = true;
    }
  }

  private publish(record: StoredTask): void {
    for (const listener of this.listeners.get(this.key(record.ghostName, record.id)) ?? []) {
      listener(publicTask(record));
    }
  }

  private assertAdmission(ghostName: string): void {
    if (this.shuttingDown) {
      throw new GhostError("daemon_shutting_down", "The daemon is shutting down.", 503);
    }
    if (this.homeMoveClaims.has(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's home move to finish.", 409);
    }
  }

  private hasActiveTask(ghostName: string): boolean {
    return [...this.openings].some((opening) => opening.ghostName === ghostName)
      || [...this.pendingControllerOperations].some((operation) => operation.ghostName === ghostName)
      || [...this.live.values()].some((live) => live.ghostName === ghostName);
  }

  private async withControllerOperation<T>(
    ghostName: string,
    allowDuringShutdown: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.registry.get(ghostName);
    if (!allowDuringShutdown && this.shuttingDown) {
      throw new GhostError("daemon_shutting_down", "The daemon is shutting down.", 503);
    }
    if (this.homeMoveClaims.has(ghostName)) {
      throw new GhostError("ghost_busy", "Wait for this ghost's home move to finish.", 409);
    }
    const settled = Promise.withResolvers<void>();
    const pending: OpeningTask = {
      ghostName,
      settled: settled.promise,
      settle: settled.resolve,
    };
    this.pendingControllerOperations.add(pending);
    try {
      return await operation();
    } finally {
      this.pendingControllerOperations.delete(pending);
      pending.settle();
    }
  }

  private stopLive(live: LiveTask): Promise<void> {
    live.abort.abort();
    const controller = live.controller;
    if (!controller) return Promise.resolve();
    live.cancellation ??= Promise.resolve().then(() => controller.cancel());
    return live.cancellation;
  }

  private detachLive(live: LiveTask): void {
    const key = this.key(live.ghostName, live.taskId);
    if (this.live.get(key) === live) this.live.delete(key);
    live.settle();
  }

  private finishCancellation(ghostName: string, taskId: string): Promise<TaskView> {
    return this.mutate(ghostName, taskId, (record) => {
      if (record.state !== "cancelling") return false;
      record.error = null;
      this.changeState(record, "cancelled");
    });
  }

  private finishStoppedLive(live: LiveTask): Promise<TaskView> {
    if (!live.failureAfterStop) {
      return this.finishCancellation(live.ghostName, live.taskId);
    }
    return this.mutate(live.ghostName, live.taskId, (record) => {
      if (isTerminalTaskState(record.state)) return false;
      record.error = live.failureAfterStop ?? null;
      this.changeState(record, "failed");
    });
  }

  private async stopInvalidController(live: LiveTask): Promise<void> {
    await this.mutate(live.ghostName, live.taskId, (record) => {
      if (isTerminalTaskState(record.state) || record.state === "cancelling") return false;
      record.error = null;
      this.changeState(record, "cancelling");
    });
    try {
      await this.stopLive(live);
    } catch (error) {
      await this.failCancellation(live.ghostName, live.taskId, error);
      live.cancellation = undefined;
      try {
        await live.controller?.result;
      } catch {
        // Result settlement proves an uncooperative controller can no longer work.
      }
    }
    await this.finishStoppedLive(live);
  }

  private async settleRunError(live: LiveTask, error: unknown): Promise<void> {
    if (error instanceof WorkerStoppedError) {
      await this.failWorker(live.ghostName, live.taskId, error);
      return;
    }
    if (!live.abort.signal.aborted) {
      await this.failWorker(live.ghostName, live.taskId, error);
      return;
    }
    const current = this.requireRecord(live.ghostName, live.taskId);
    if (current.state === "cancelling" && current.error?.code === "cancellation_failed") {
      await this.failWorker(live.ghostName, live.taskId, error);
      return;
    }
    await this.mutate(live.ghostName, live.taskId, (record) => {
      if (isTerminalTaskState(record.state) || record.state === "cancelling") return false;
      record.error = null;
      this.changeState(record, "cancelling");
    });
    try {
      await this.stopLive(live);
    } catch {
      live.cancellation = undefined;
      await this.failWorker(live.ghostName, live.taskId, error);
      return;
    }
    await this.finishStoppedLive(live);
  }

  private failWorker(ghostName: string, taskId: string, error: unknown): Promise<TaskView> {
    return this.mutate(ghostName, taskId, (record) => {
      if (isTerminalTaskState(record.state)) return false;
      record.error = this.taskError(
        "worker_failed",
        error instanceof Error ? error.message : String(error),
        "The worker failed.",
      );
      this.changeState(record, "failed");
    });
  }

  private failCancellation(ghostName: string, taskId: string, error: unknown): Promise<TaskView> {
    return this.mutate(ghostName, taskId, (record) => {
      if (record.state !== "cancelling") return false;
      record.error = this.taskError(
        "cancellation_failed",
        error instanceof Error ? error.message : String(error),
        "The worker did not confirm cancellation.",
      );
    });
  }

  private taskError(code: string, message: string, fallback = message): TaskErrorView {
    const value = message || fallback;
    const boundedMessage = bounded(value, MAX_ERROR_MESSAGE_LENGTH);
    return {
      code: boundedText(code, MAX_ERROR_CODE_LENGTH),
      message: boundedMessage.text,
      messageTruncated: boundedMessage.truncated,
    };
  }

  private requireNativeSessionId(value: string): void {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_NATIVE_SESSION_ID_LENGTH) {
      throw new Error("The worker returned an invalid native session id.");
    }
  }

  private key(ghostName: string, taskId: string): string {
    return `${ghostName}\0${taskId}`;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}
