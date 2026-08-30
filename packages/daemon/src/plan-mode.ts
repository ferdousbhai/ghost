/**
 * Plan mode and the conversation's todo list, Ghost-owned.
 *
 * Both live in the transcript as custom entries (`ghost-plan`, `ghost-todo`),
 * so they follow branches and survive restarts; a `PlanBook` keeps the
 * conversation's current state in memory so per-turn and per-tool-call reads
 * cost nothing. Plan mode keeps the world read-only while the model drafts a
 * plan into the ghost's `plans/` folder and proposes it; the owner approves
 * through `ask`, which ends plan mode and pins the plan into every later turn
 * until the owner clears it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionFactory, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  GHOST_BROWSER,
  GHOST_DESKTOP,
  READ_ONLY_BROWSER_ACTIONS,
  READ_ONLY_DESKTOP_ACTIONS,
} from "@ghost/extensions";
import { Type } from "typebox";
import type { AskBroker } from "./ask-broker.js";
import { ASK_TOOL_NAME, askOwner } from "./ask-tool.js";

// ---------------------------------------------------------------------------
// State

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export interface ApprovedPlan {
  path: string;
  title: string;
  approvedAt: string;
}

export interface PlanState {
  planning: boolean;
  plan?: ApprovedPlan;
}

export const TODO_ENTRY_TYPE = "ghost-todo";
export const PLAN_ENTRY_TYPE = "ghost-plan";

function isTodoPhases(value: unknown): value is TodoPhase[] {
  return Array.isArray(value) && value.every((phase) =>
    phase && typeof phase === "object"
    && typeof (phase as TodoPhase).name === "string"
    && Array.isArray((phase as TodoPhase).tasks));
}

function isPlanState(value: unknown): value is PlanState {
  return typeof value === "object" && value !== null && typeof (value as PlanState).planning === "boolean";
}

/** The plan state and todo list a transcript's current branch carries. */
export function readPlanBranch(manager: SessionManager): { state: PlanState; todo: TodoPhase[] } {
  let state: PlanState | undefined;
  let todo: TodoPhase[] | undefined;
  const branch = manager.getBranch();
  for (let index = branch.length - 1; index >= 0 && (!state || !todo); index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom") continue;
    const data = entry.data as { state?: unknown; phases?: unknown } | undefined;
    if (!state && entry.customType === PLAN_ENTRY_TYPE && isPlanState(data?.state)) state = data.state;
    if (!todo && entry.customType === TODO_ENTRY_TYPE && isTodoPhases(data?.phases)) todo = data.phases;
  }
  return { state: structuredClone(state ?? { planning: false }), todo: structuredClone(todo ?? []) };
}

/**
 * One conversation's plan state and todo list: read once from the transcript,
 * written through to it, re-read only when the branch moves.
 */
export class PlanBook {
  private state: PlanState;
  private todo: TodoPhase[];
  private planText: { path: string; content: string | null } | undefined;

  constructor(private readonly manager: SessionManager) {
    ({ state: this.state, todo: this.todo } = readPlanBranch(manager));
  }

  /** After `manager.branch(...)`: the current branch may carry different entries. */
  reload(): void {
    ({ state: this.state, todo: this.todo } = readPlanBranch(this.manager));
  }

  getState(): PlanState {
    return structuredClone(this.state);
  }

  setState(state: PlanState): void {
    this.state = structuredClone(state);
    this.manager.appendCustomEntry(PLAN_ENTRY_TYPE, { version: 1, state });
  }

  getTodo(): TodoPhase[] {
    return structuredClone(this.todo);
  }

  setTodo(phases: TodoPhase[]): void {
    this.todo = structuredClone(phases);
    this.manager.appendCustomEntry(TODO_ENTRY_TYPE, { version: 1, phases });
  }

  /** The approved plan's text, read once per path; null when the file is gone. */
  planContent(): string | null {
    const plan = this.state.plan;
    if (!plan) return null;
    if (this.planText?.path !== plan.path) {
      let content: string | null;
      try {
        content = readFileSync(plan.path, "utf8");
      } catch {
        content = null;
      }
      this.planText = { path: plan.path, content };
    }
    return this.planText.content;
  }
}

// ---------------------------------------------------------------------------
// Todo

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  abandoned: "[-]",
  blocked: "[!]",
};

export function formatTodo(phases: readonly TodoPhase[]): string {
  if (phases.length === 0) return "No todo list in this conversation.";
  return phases
    .map((phase) => [
      `## ${phase.name}`,
      ...phase.tasks.map((task) =>
        `${STATUS_MARK[task.status]} ${task.content}${task.status === "blocked" && task.blocker ? ` (blocked: ${task.blocker})` : ""}`),
    ].join("\n"))
    .join("\n\n");
}

/** One task is in progress: the first pending one when none is. */
function normalizeInProgress(phases: TodoPhase[]): void {
  const tasks = phases.flatMap((phase) => phase.tasks);
  const active = tasks.filter((task) => task.status === "in_progress");
  for (const task of active.slice(1)) task.status = "pending";
  if (active.length === 0) {
    const next = tasks.find((task) => task.status === "pending");
    if (next) next.status = "in_progress";
  }
}

/** Exact content first; otherwise the one task containing the text. */
function findTask(phases: TodoPhase[], content: string): TodoItem {
  const wanted = content.trim();
  const tasks = phases.flatMap((phase) => phase.tasks);
  const exact = tasks.find((task) => task.content === wanted);
  if (exact) return exact;
  const partial = tasks.filter((task) => task.content.toLowerCase().includes(wanted.toLowerCase()));
  const [only] = partial;
  if (only && partial.length === 1) return only;
  throw new Error(partial.length === 0
    ? `No todo task matches ${JSON.stringify(content)}.`
    : `${JSON.stringify(content)} matches ${partial.length} todo tasks; use the full task text.`);
}

const phaseListSchema = Type.Array(Type.Object({
  phase: Type.String({ description: "Phase name." }),
  items: Type.Array(Type.String(), { minItems: 1, description: "Tasks in this phase, in order." }),
}));

export const todoToolSchema = Type.Object({
  op: Type.Union([
    Type.Literal("init"),
    Type.Literal("view"),
    Type.Literal("start"),
    Type.Literal("done"),
    Type.Literal("rm"),
    Type.Literal("drop"),
    Type.Literal("block"),
    Type.Literal("unblock"),
    Type.Literal("append"),
  ], {
    description: "init: replace the whole list; view: show it; start: mark a task in progress; done: complete a task or a whole phase; rm: delete a task; drop: abandon a task; block/unblock: mark a task waiting on something; append: add tasks to a phase (or new phases).",
  }),
  list: Type.Optional(phaseListSchema),
  items: Type.Optional(Type.Array(Type.String(), { description: "Tasks for a single-phase init or an append." })),
  phase: Type.Optional(Type.String({ description: "Phase name for done/append." })),
  task: Type.Optional(Type.String({ description: "Task content (or a unique part of it) for start/done/rm/drop/block/unblock." })),
  reason: Type.Optional(Type.String({ description: "What a blocked task is waiting for." })),
});

export interface TodoToolDetails {
  op: string;
  phases: TodoPhase[];
}

function phasesFromInit(params: { list?: Array<{ phase: string; items: string[] }>; items?: string[]; phase?: string }): TodoPhase[] {
  const toTasks = (items: string[]): TodoItem[] =>
    items.map((content) => content.trim()).filter(Boolean).map((content) => ({ content, status: "pending" as const }));
  if (params.list?.length) return params.list.map((entry) => ({ name: entry.phase.trim() || "Tasks", tasks: toTasks(entry.items) }));
  if (params.items?.length) return [{ name: params.phase?.trim() || "Tasks", tasks: toTasks(params.items) }];
  throw new Error("init needs `list` (phases with items) or `items`.");
}

function requireTask(params: { task?: string }): string {
  if (!params.task?.trim()) throw new Error("This op needs `task`.");
  return params.task;
}

export function createTodoTool(book: PlanBook): ToolDefinition<typeof todoToolSchema, TodoToolDetails> {
  return {
    name: "todo",
    label: "Todo list",
    description: "Keep this conversation's task list: phases of tasks with pending / in progress / completed / blocked / abandoned status. The owner sees it live, so keep it current: init it when a piece of work has several steps, mark tasks done as you finish them, and block a task with the reason when you are waiting on something.",
    parameters: todoToolSchema,
    async execute(_toolCallId, params) {
      let phases = book.getTodo();
      switch (params.op) {
        case "view":
          return { content: [{ type: "text", text: formatTodo(phases) }], details: { op: params.op, phases } };
        case "init":
          phases = phasesFromInit(params);
          break;
        case "append": {
          for (const addition of phasesFromInit(params)) {
            const existing = phases.find((phase) => phase.name === addition.name);
            if (existing) existing.tasks.push(...addition.tasks);
            else phases.push(addition);
          }
          break;
        }
        case "done": {
          if (params.phase && !params.task) {
            const phase = phases.find((candidate) => candidate.name === params.phase?.trim());
            if (!phase) throw new Error(`No todo phase named ${JSON.stringify(params.phase)}.`);
            for (const task of phase.tasks) if (task.status !== "abandoned") task.status = "completed";
          } else {
            findTask(phases, requireTask(params)).status = "completed";
          }
          break;
        }
        case "start": {
          for (const task of phases.flatMap((phase) => phase.tasks)) if (task.status === "in_progress") task.status = "pending";
          findTask(phases, requireTask(params)).status = "in_progress";
          break;
        }
        case "rm": {
          const task = findTask(phases, requireTask(params));
          for (const phase of phases) phase.tasks = phase.tasks.filter((candidate) => candidate !== task);
          phases = phases.filter((phase) => phase.tasks.length > 0);
          break;
        }
        case "drop":
          findTask(phases, requireTask(params)).status = "abandoned";
          break;
        case "block": {
          const task = findTask(phases, requireTask(params));
          task.status = "blocked";
          if (params.reason?.trim()) task.blocker = params.reason.trim();
          break;
        }
        case "unblock": {
          const task = findTask(phases, requireTask(params));
          task.status = "pending";
          delete task.blocker;
          break;
        }
      }
      normalizeInProgress(phases);
      book.setTodo(phases);
      return { content: [{ type: "text", text: formatTodo(phases) }], details: { op: params.op, phases } };
    },
  };
}

// ---------------------------------------------------------------------------
// Plan mode

export function planFileName(title: string): string {
  const stem = title
    .replace(/\.md$/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!stem) throw new Error("The plan needs a title with letters or digits in it.");
  return `${stem}.md`;
}

const PLAN_ALWAYS_ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  ASK_TOOL_NAME,
  "inspect_image",
  "propose_plan",
]);
const PLAN_JOB_OPS = new Set(["list", "wait"]);
const PLAN_TODO_OPS = new Set(["view"]);

function selectorAllowed(
  input: unknown,
  key: "action" | "op",
  allowed: ReadonlySet<string>,
): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && allowed.has(value);
}

/** Why a tool call is refused while planning, or null when it may run. */
export function planModeRefusal(state: PlanState, toolName: string, input: unknown): string | null {
  if (!state.planning) return null;
  if (PLAN_ALWAYS_ALLOWED_TOOLS.has(toolName)) return null;

  switch (toolName) {
    case "edit":
    case "write":
      return "Plan mode: files are read-only; propose_plan is the only plan writer.";
    case "bash":
      return "Plan mode: Bash is unavailable to the model; use read, grep, find, or ls.";
    case "jobs":
      return selectorAllowed(input, "op", PLAN_JOB_OPS)
        ? null
        : "Plan mode: jobs may only list or wait; cancellation remains the owner's decision.";
    case "todo":
      return selectorAllowed(input, "op", PLAN_TODO_OPS)
        ? null
        : "Plan mode: the todo list is read-only until the plan is approved.";
    case GHOST_BROWSER:
      return selectorAllowed(input, "action", READ_ONLY_BROWSER_ACTIONS)
        ? null
        : "Plan mode: only non-persisting browser observation and navigation are available; screenshots and actions are blocked.";
    case GHOST_DESKTOP:
      return selectorAllowed(input, "action", READ_ONLY_DESKTOP_ACTIONS)
        ? null
        : "Plan mode: only desktop observation is available until the plan is approved.";
    default:
      return `Plan mode: ${toolName} is not available until the plan is approved.`;
  }
}

/** The system-prompt sections plan mode, the approved plan, and the todo list add to a turn. */
export function planSections(book: PlanBook): string[] {
  const state = book.getState();
  const sections: string[] = [];
  if (state.planning) {
    sections.push([
      "# Plan mode",
      "You are planning, not doing: read, search, inspect, and think, but change nothing. Bash, generic file writes/edits, screenshots, memory writes, and every other mutation are blocked.",
      "Use native read, grep, find, and ls for files; ask for decisions; and use only the observational forms of browser, desktop, jobs, todo, character, and image inspection tools.",
      "When the approach is clear, call propose_plan with a title and the complete plan in Markdown. It is the only plan writer. The owner approves or asks for revisions; approval ends plan mode.",
    ].join("\n"));
  } else if (state.plan) {
    const content = book.planContent();
    if (content !== null) {
      sections.push(`# Current plan: ${state.plan.title}\nApproved ${state.plan.approvedAt}; file ${state.plan.path}. Follow it, and keep the todo list current as you go.\n\n${content.trim()}`);
    }
  }
  const todo = book.getTodo();
  if (todo.length > 0) sections.push(`# Todo\n${formatTodo(todo)}`);
  return sections;
}

/** The read-only guard while planning; pi refuses the call with the reason the model sees. */
export function createPlanModeGuard(book: PlanBook): ExtensionFactory {
  return (api) => {
    api.on("tool_call", (event) => {
      const reason = planModeRefusal(book.getState(), event.toolName, event.input);
      return reason ? { block: true, reason } : undefined;
    });
  };
}

export const proposePlanSchema = Type.Object({
  title: Type.String({ description: "A short name for the plan; it becomes the file name." }),
  content: Type.String({ description: "The complete plan in Markdown: goal, steps, files touched, risks, how to verify." }),
});

export interface ProposePlanDetails {
  path: string;
  title: string;
  outcome: "approved" | "revise";
  note?: string;
}

export interface ProposePlanOptions {
  book: PlanBook;
  broker: AskBroker;
  plansDir: string;
  timeoutMs: () => number;
  now?: () => Date;
}

export function createProposePlanTool(options: ProposePlanOptions): ToolDefinition<typeof proposePlanSchema, ProposePlanDetails> {
  return {
    name: "propose_plan",
    label: "Propose plan",
    description: "Save the plan you drafted in plan mode and ask the owner to approve it. Approval ends plan mode and pins the plan into the conversation; a revision request keeps you planning.",
    parameters: proposePlanSchema,
    async execute(_toolCallId, params, signal) {
      if (!options.book.getState().planning) throw new Error("propose_plan only works in plan mode; the owner starts it.");
      mkdirSync(options.plansDir, { recursive: true });
      const path = join(options.plansDir, planFileName(params.title));
      writeFileSync(path, params.content.endsWith("\n") ? params.content : `${params.content}\n`, { encoding: "utf8", mode: 0o600 });
      const title = params.title.trim();
      // Chatting instead of answering, or a timeout, keeps the model planning.
      const result = await askOwner(options.broker, {
        id: "plan",
        header: "Plan",
        question: `Approve the plan "${title}" (${basename(path)})?`,
        options: [
          { label: "Approve", description: "End plan mode and follow this plan." },
          { label: "Revise", description: "Keep planning; say what to change." },
        ],
      }, { ...(signal ? { signal } : {}), timeout: options.timeoutMs() });
      const note = result?.note ?? result?.customInput;
      if (result?.selectedOptions.includes("Approve")) {
        options.book.setState({ planning: false, plan: { path, title, approvedAt: (options.now ?? (() => new Date()))().toISOString() } });
        return {
          content: [{ type: "text", text: `The owner approved the plan; plan mode has ended. Carry it out, starting with a todo list of its steps.${note ? `\nOwner's note: ${note}` : ""}` }],
          details: { path, title, outcome: "approved", ...(note ? { note } : {}) },
        };
      }
      return {
        content: [{ type: "text", text: `The owner wants revisions${note ? `: ${note}` : " (they will say what to change)."} You are still in plan mode.` }],
        details: { path, title, outcome: "revise", ...(note ? { note } : {}) },
      };
    },
  };
}
