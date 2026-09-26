import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendHandoff, HANDOFF_LOG_LIMIT_BYTES, type HandoffReceipt } from "../src/handoffs.js";
import { runCli } from "./helpers/cli.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function machine(): { env: NodeJS.ProcessEnv; log: string; calls: string } {
  root = mkdtempSync(join(tmpdir(), "ghost-delegate-"));
  const bin = join(root, "bin");
  const usage = join(root, "state", "omarchy", "agents", "usage");
  mkdirSync(bin);
  mkdirSync(usage, { recursive: true });
  const calls = join(root, "calls");
  const executable = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  writeFileSync(join(root, "commands.json"), JSON.stringify({
    commands: [{ route: "omarchy default agent", args: "[claude|codex|grok]" }],
  }));
  // `omarchy commands --json` lists agents; `omarchy agent usage update` is logged.
  executable("omarchy", `[ "$1" = commands ] && exec cat '${join(root, "commands.json")}'\necho "$*" >> '${calls}'`);
  // claude echoes its args, or fails on a limit when asked.
  executable("claude", [
    'if [ "$1" = limit ]; then echo "Error: You have hit your usage limit" >&2; exit 1; fi',
    // A descendant that outlives the harness keeps its pipes open.
    'if [ "$1" = linger ]; then sleep 20 & echo done; exit 0; fi',
    'echo "claude got: $*"',
    "exit 3",
  ].join("\n"));
  executable("codex", "echo should-not-run; exit 0");
  const fresh = new Date().toISOString();
  const later = "2999-01-01T00:00:00Z";
  writeFileSync(join(usage, "claude.json"), JSON.stringify({
    updatedAt: fresh,
    limits: [{ label: "Session (5-hour)", percent: 0.2, resetsAt: later }],
  }));
  writeFileSync(join(usage, "codex.json"), JSON.stringify({
    updatedAt: fresh,
    limits: [{ label: "Weekly (7-day)", percent: 0.99, resetsAt: later }],
  }));
  return {
    env: { PATH: `${bin}:/usr/bin:/bin`, XDG_STATE_HOME: join(root, "state"), GHOST: "aria", GHOST_SESSION: "cli-abc" },
    log: join(root, "state", "ghost", "handoffs.jsonl"),
    calls,
  };
}

function receipts(log: string): HandoffReceipt[] {
  return readFileSync(log, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as HandoffReceipt);
}

describe("ghost delegate", () => {
  it("refreshes the harness, runs it with its args, streams its output, and exits with its status", async () => {
    const { env, log, calls } = machine();
    const result = await runCli(["delegate", "claude", "--", "-p", "fix it"], { env, home: root });
    expect(result.stdout).toBe("claude got: -p fix it\n");
    expect(result.code).toBe(3);
    expect(readFileSync(calls, "utf8")).toBe("agent usage update --limits-only claude\n");
    const [receipt] = receipts(log);
    expect(receipt).toMatchObject({
      v: 1,
      ghost: "aria",
      session: "cli-abc",
      harness: "claude",
      cwd: process.cwd(),
      eligible: ["claude"],
      windows: [{ label: "Session (5-hour)", percent: 0.2 }],
      outcome: { exit: 3, signal: null, limit: null },
    });
    expect(JSON.stringify(receipt)).not.toContain("fix it");
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("records the limit a failed run names", async () => {
    const { env, log } = machine();
    const result = await runCli(["delegate", "claude", "--", "limit"], { env, home: root });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("hit your usage limit");
    expect(receipts(log)[0]?.outcome).toMatchObject({ exit: 1, limit: "usage_limit" });
  });

  it("returns once the harness exits even when a descendant still holds its output", async () => {
    const { env, log } = machine();
    const started = Date.now();
    const result = await runCli(["delegate", "claude", "--", "linger"], { env, home: root });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ code: 0, stdout: "done\n" });
    expect(receipts(log)[0]?.outcome).toMatchObject({ exit: 0, limit: null });
  });

  it("refuses a harness without room, never running it, and records the refusal", async () => {
    const { env, log } = machine();
    const result = await runCli(["delegate", "codex", "--", "exec", "hi"], { env, home: root });
    expect(result.code).toBe(6);
    expect(result.stdout).not.toContain("should-not-run");
    expect(result.stderr).toMatch(/codex has no room: Weekly \(7-day\) 99% used/u);
    expect(receipts(log)[0]).toMatchObject({ harness: "codex", outcome: { refused: expect.stringMatching(/^Weekly/u) } });
  });

  it("refuses a harness that is not installed", async () => {
    const { env, log } = machine();
    const result = await runCli(["delegate", "grok", "--", "hi"], { env, home: root });
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("grok is not an installed agent CLI");
    expect(receipts(log)[0]?.outcome).toEqual({ refused: "not installed" });
  });

  it("needs a harness", async () => {
    const { env } = machine();
    const result = await runCli(["delegate"], { env, home: root });
    expect(result.code).toBe(2);
  });
});

describe("appendHandoff", () => {
  it("moves a full log aside, keeping one previous generation", () => {
    root = mkdtempSync(join(tmpdir(), "ghost-handoffs-"));
    const log = join(root, "ghost", "handoffs.jsonl");
    mkdirSync(join(root, "ghost"));
    writeFileSync(log, "x".repeat(HANDOFF_LOG_LIMIT_BYTES));
    const receipt: HandoffReceipt = {
      v: 1, at: "2026-09-26T00:00:00.000Z", ghost: null, session: null, harness: "pi", cwd: "/", eligible: [], windows: [],
      outcome: { refused: "not installed" },
    };
    appendHandoff(log, receipt);
    expect(statSync(`${log}.1`).size).toBe(HANDOFF_LOG_LIMIT_BYTES);
    expect(receipts(log)).toEqual([receipt]);
  });
});
