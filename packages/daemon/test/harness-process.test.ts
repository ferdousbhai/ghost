import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runHarness } from "../src/harness-process.js";
import type { HarnessEvent } from "../src/harness-table.js";

it("closes inherited pipes and never parses descendant output after settlement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ghost-harness-drain-"));
  const gate = join(directory, "write-late");
  const pidFile = join(directory, "descendant.pid");
  const descendant = join(directory, "descendant.cjs");
  const parent = join(directory, "parent.cjs");
  writeFileSync(descendant, `
    const fs = require("node:fs");
    process.stdout.on("error", () => {});
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(gate)})) return;
      clearInterval(timer);
      process.stdout.write("late\\n", () => process.exit(0));
    }, 10);
  `);
  writeFileSync(parent, `
    const child = require("node:child_process").spawn(process.execPath,
      [${JSON.stringify(descendant)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    child.unref();
    process.stdout.write("early\\n");
  `);
  const events: HarnessEvent[] = [];
  try {
    const result = await runHarness({
      launch: { argv: [process.execPath, parent] }, cwd: directory, env: process.env,
      signal: new AbortController().signal,
      parse: (line) => [{ type: "text", block: "reply", delta: line }],
      onEvent: (event) => events.push(event),
    });
    expect(result.code).toBe(0);
    writeFileSync(gate, "ready");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual([{ type: "text", block: "reply", delta: "early" }]);
  } finally {
    killCaptured(pidFile);
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

function killCaptured(pidFile: string): void {
  try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); }
  catch (error) {
    if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}

it.each(["inherit", "ignore"] as const)("kills the stopped leader's surviving process group with %s pipes", async (stdio) => {
  const directory = mkdtempSync(join(tmpdir(), "ghost-harness-stop-"));
  const ready = join(directory, "ready");
  const pidFile = join(directory, "descendant.pid");
  const descendant = join(directory, "descendant.cjs");
  const parent = join(directory, "parent.cjs");
  writeFileSync(descendant, `
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");
    setInterval(() => {}, 1000);
  `);
  writeFileSync(parent, `
    const fs = require("node:fs");
    const child = require("node:child_process").spawn(process.execPath,
      [${JSON.stringify(descendant)}], { stdio: ${JSON.stringify(stdio)} });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(ready)})) return;
      clearInterval(timer);
      process.stdout.write("ready\\n");
    }, 10);
  `);
  const controller = new AbortController();
  try {
    await runHarness({
      launch: { argv: [process.execPath, parent] }, cwd: directory, env: process.env,
      signal: controller.signal,
      parse: () => { controller.abort(); return []; }, onEvent: () => {},
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  } finally {
    killCaptured(pidFile);
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
