import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BROWSER_ACTIONS, DESKTOP_ACTIONS } from "@ghost/extensions";
import { afterEach, describe, expect, it } from "vitest";
import type { AskBroker } from "../src/ask-broker.js";
import {
  createProposePlanTool,
  createTodoTool,
  formatTodo,
  PlanBook,
  planModeRefusal,
  planSections,
  readPlanBranch,
} from "../src/plan-mode.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const run = (tool: ReturnType<typeof createTodoTool>, params: Parameters<typeof tool.execute>[1]) =>
  tool.execute("call", params, undefined, undefined, {} as never);

describe("todo", () => {
  it("keeps one task in progress, persists every change in the transcript, and renders it", async () => {
    const manager = SessionManager.inMemory();
    const book = new PlanBook(manager);
    const todo = createTodoTool(book);
    expect(book.getTodo()).toEqual([]);
    expect(formatTodo([])).toBe("No todo list in this conversation.");

    await run(todo, { op: "init", list: [{ phase: "Build", items: ["Scaffold", "Wire"] }, { phase: "Verify", items: ["Test"] }] });
    expect(book.getTodo()).toEqual([
      { name: "Build", tasks: [{ content: "Scaffold", status: "in_progress" }, { content: "Wire", status: "pending" }] },
      { name: "Verify", tasks: [{ content: "Test", status: "pending" }] },
    ]);

    await run(todo, { op: "done", task: "Scaffold" });
    await run(todo, { op: "block", task: "wire", reason: "waiting on the API key" });
    await run(todo, { op: "append", phase: "Verify", items: ["Lint"] });
    const view = await run(todo, { op: "view" });
    expect(view.content[0]).toMatchObject({
      type: "text",
      text: "## Build\n[x] Scaffold\n[!] Wire (blocked: waiting on the API key)\n\n## Verify\n[>] Test\n[ ] Lint",
    });

    await run(todo, { op: "unblock", task: "Wire" });
    await run(todo, { op: "start", task: "Wire" });
    await run(todo, { op: "done", phase: "Verify" });
    await run(todo, { op: "rm", task: "Lint" });
    // A fresh book reads the same branch back from the transcript.
    expect(new PlanBook(manager).getTodo().map((phase) => phase.tasks.map((task) => `${task.content}:${task.status}`))).toEqual([
      ["Scaffold:completed", "Wire:in_progress"],
      ["Test:completed"],
    ]);
    expect(manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "ghost-todo")).toHaveLength(8);
    await expect(run(todo, { op: "done", task: "nothing like this" })).rejects.toThrow(/No todo task/);
    await run(todo, { op: "append", phase: "Build", items: ["Scaffold docs"] });
    await expect(run(todo, { op: "done", task: "scaffold" })).rejects.toThrow(/matches 2 todo tasks/);
    await expect(run(todo, { op: "init" })).rejects.toThrow(/init needs/);
  });
});

describe("plan mode", () => {
  it("blocks model Bash without trying to classify shell syntax", () => {
    const planning = { planning: true };
    for (const command of [
      "ls -la",
      "git status && git diff --stat",
      "rg foo src | head -20",
      "omarchy commands --json",
      "echo hi > out.txt",
      "cat file | tee copy",
      "git status --porcelain=v1; touch escaped",
      "printf '%s' \"$(touch escaped)\"",
      "FOO=$(touch escaped) env",
      "",
    ]) {
      expect(planModeRefusal(planning, "bash", { command }), JSON.stringify(command)).not.toBeNull();
    }
  });

  it("admits only the explicit observational model-tool surface", () => {
    const planning = { planning: true };
    const idle = { planning: false };
    expect(planModeRefusal(idle, "write", { path: "/x" })).toBeNull();

    for (const tool of [
      "read",
      "grep",
      "find",
      "ls",
      "ask",
      "inspect_image",
      "task_list",
      "task_get",
      "propose_plan",
    ]) {
      expect(planModeRefusal(planning, tool, {}), tool).toBeNull();
    }
    for (const op of ["list", "wait"]) {
      expect(planModeRefusal(planning, "jobs", { op }), `jobs:${op}`).toBeNull();
    }
    expect(planModeRefusal(planning, "todo", { op: "view" })).toBeNull();
    expect(planModeRefusal(planning, "ghost_character", { action: "read" })).toBeNull();

    const browserObservation = [
      "open", "read", "find", "back", "forward", "scroll", "console", "network", "tabs", "tab_switch",
    ];
    for (const action of browserObservation) {
      expect(planModeRefusal(planning, "ghost_browser", { action }), `browser:${action}`).toBeNull();
    }
    const desktopObservation = ["state", "see", "layers", "ax_query", "ax_roles", "hit_test"];
    for (const action of desktopObservation) {
      expect(planModeRefusal(planning, "ghost_desktop", { action }), `desktop:${action}`).toBeNull();
    }

    const refused: Array<[string, unknown]> = [
      ["bash", { command: "git status" }],
      ["bash", { command: "ls" }],
      ["edit", { path: "/ghost/plans/plan.md" }],
      ["write", { path: "/ghost/plans/plan.md" }],
      ["ghost_screen", { target: "screen" }],
      ["ghost_memory_write", { content: "fact" }],
      ["task", { harness: "codex", task: "Implement it." }],
      ["task_send", { task_id: "task-1", text: "Continue." }],
      ["task_cancel", { task_id: "task-1" }],
      ["mcp__server_tool", {}],
      ["unknown_tool", {}],
      ["jobs", { op: "cancel" }],
      ["todo", { op: "init" }],
      ["ghost_character", { action: "write" }],
      ...BROWSER_ACTIONS
        .filter((action) => !browserObservation.includes(action))
        .map((action): [string, unknown] => ["ghost_browser", { action }]),
      ...DESKTOP_ACTIONS
        .filter((action) => !desktopObservation.includes(action))
        .map((action): [string, unknown] => ["ghost_desktop", { action }]),
    ];
    for (const [tool, input] of refused) {
      expect(planModeRefusal(planning, tool, input), `${tool}:${JSON.stringify(input)}`).not.toBeNull();
    }
  });

  it("fails closed when an action or op selector is missing or malformed", () => {
    const planning = { planning: true };
    for (const tool of ["ghost_browser", "ghost_desktop", "ghost_character", "jobs", "todo"]) {
      for (const input of [undefined, null, [], {}, { action: 1 }, { action: {} }, { op: 1 }, { op: {} }]) {
        expect(planModeRefusal(planning, tool, input), `${tool}:${JSON.stringify(input)}`).not.toBeNull();
      }
    }
  });

  it("saves a proposed plan, ends plan mode on approval, and pins it into the prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "ghost-plan-"));
    const manager = SessionManager.inMemory();
    const answers: Array<"Approve" | "Revise"> = ["Revise", "Approve"];
    const broker = {
      open: async (questions: Array<{ options: Array<{ label: string }> }>) => ({
        kind: "submit" as const,
        results: [{ id: "plan", selectedOptions: [answers.shift() ?? "Approve"], note: questions[0]?.options.length === 2 ? "tighter scope" : undefined }],
      }),
    } as unknown as AskBroker;
    const book = new PlanBook(manager);
    const propose = createProposePlanTool({ book, broker, plansDir: join(dir, "plans"), timeoutMs: () => 0, now: () => new Date("2026-08-28T12:00:00Z") });
    const call = (params: { title: string; content: string }) => propose.execute("c", params, undefined, undefined, {} as never);

    await expect(call({ title: "x", content: "y" })).rejects.toThrow(/only works in plan mode/);
    book.setState({ planning: true });
    expect(planSections(book)[0]).toMatch(/^# Plan mode/);

    const revised = await call({ title: "Ship the thing!", content: "# Plan\n1. do it" });
    expect(revised.details).toMatchObject({ outcome: "revise", note: "tighter scope", path: join(dir, "plans", "ship-the-thing.md") });
    expect(book.getState()).toEqual({ planning: true });

    const approved = await call({ title: "Ship the thing!", content: "# Plan\n1. do it\n2. verify" });
    expect(approved.details).toMatchObject({ outcome: "approved" });
    expect(readFileSync(join(dir, "plans", "ship-the-thing.md"), "utf8")).toBe("# Plan\n1. do it\n2. verify\n");
    const state = book.getState();
    expect(state).toEqual({ planning: false, plan: { path: join(dir, "plans", "ship-the-thing.md"), title: "Ship the thing!", approvedAt: "2026-08-28T12:00:00.000Z" } });
    expect(readPlanBranch(manager).state).toEqual(state);
    book.setTodo([{ name: "Do", tasks: [{ content: "it", status: "in_progress" }] }]);
    const sections = planSections(book);
    expect(sections[0]).toContain("# Current plan: Ship the thing!");
    expect(sections[0]).toContain("2. verify");
    expect(sections[1]).toBe("# Todo\n## Do\n[>] it");
    expect(planSections(new PlanBook(SessionManager.inMemory()))).toEqual([]);
  });
});
