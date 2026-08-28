import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { AskBroker } from "../src/ask-broker.js";
import {
  createProposePlanTool,
  createTodoTool,
  formatTodo,
  isReadOnlyCommand,
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
  it("judges read-only shell commands conservatively", () => {
    for (const ok of ["ls -la", "git status && git diff --stat", "rg foo src | head -20", "FOO=1 cat file.txt", "sed -n 1,10p a.ts"]) {
      expect(isReadOnlyCommand(ok), ok).toBe(true);
    }
    for (const bad of ["rm -rf x", "echo hi > out.txt", "git commit -m x", "cat a | tee b", "sed -i s/a/b/ f", "npm install", ""]) {
      expect(isReadOnlyCommand(bad), bad).toBe(false);
    }
  });

  it("refuses mutations while planning except inside the plans folder", () => {
    const planning = { planning: true };
    const idle = { planning: false };
    expect(planModeRefusal(idle, "/p", "write", { path: "/x" })).toBeNull();
    expect(planModeRefusal(planning, "/p", "read", { path: "/x" })).toBeNull();
    expect(planModeRefusal(planning, "/p", "write", { path: "/p/plan.md" })).toBeNull();
    expect(planModeRefusal(planning, "/p", "write", { path: "/px/plan.md" })).toMatch(/read-only/);
    expect(planModeRefusal(planning, "/p", "bash", { command: "git log" })).toBeNull();
    expect(planModeRefusal(planning, "/p", "bash", { command: "ls", background: true })).toMatch(/read-only commands/);
    expect(planModeRefusal(planning, "/p", "ghost_browser", { action: "read" })).toBeNull();
    expect(planModeRefusal(planning, "/p", "ghost_browser", { action: "click" })).toMatch(/browser is read-only/);
    expect(planModeRefusal(planning, "/p", "ghost_desktop", { action: "see" })).toBeNull();
    expect(planModeRefusal(planning, "/p", "ghost_desktop", { action: "click" })).toMatch(/desktop is read-only/);
    expect(planModeRefusal(planning, "/p", "ghost_screen", { target: "screen" })).toBeNull();
    expect(planModeRefusal(planning, "/p", "mcp__server_tool", {})).toMatch(/not available/);
    expect(planModeRefusal(planning, "/p", "ghost_memory_write", {})).toMatch(/not available/);
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
