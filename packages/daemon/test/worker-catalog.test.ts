import {
  chmodSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultOmarchyUsageDir,
  resolveWorkerExecutable,
  WorkerCatalog,
} from "../src/worker-catalog.js";
import { GhostError } from "../src/ghosts.js";
import { tempDir } from "./helpers/fixtures.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function scratch(prefix: string): string {
  const temporary = tempDir(prefix);
  cleanups.push(temporary.cleanup);
  return temporary.path;
}

function writeUsage(
  usageDir: string,
  id: "claude" | "codex",
  overrides: Record<string, unknown> = {},
): void {
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(join(usageDir, `${id}.json`), `${JSON.stringify({
    schemaVersion: 1,
    id,
    name: id === "claude" ? "Claude Code" : "Codex",
    updatedAt: "2026-08-30T09:00:00Z",
    ready: true,
    tierLabel: id === "claude" ? "Max" : "Plus",
    usageStatusText: "",
    authHelpText: "",
    limits: [
      { label: "Session", percent: 0.25, resetsAt: "2026-08-30T12:00:00Z" },
      { label: "invalid", percent: 42, resetsAt: "not-a-date" },
    ],
    todayTotalTokens: 12_345,
    todayPrompts: 7,
    todaySessions: 2,
    ...overrides,
  })}\n`, { mode: 0o600 });
}

describe("WorkerCatalog", () => {
  it("reports fixed worker identities, native installation, plan auth, and bounded Omarchy usage", async () => {
    const usageDir = scratch("ghost-worker-usage-");
    writeUsage(usageDir, "claude");
    writeUsage(usageDir, "codex", {
      usageStatusText: "Local stats are still available.\nRetry later.",
    });
    const resolveCodexExecutable = vi.fn(async (configured: string) => {
      expect(configured).toBe("owner-codex");
      return "/resolved/codex";
    });
    const catalog = new WorkerCatalog({
      usageDir,
      now: () => Date.parse("2026-08-30T09:10:00Z"),
      env: { PATH: "/usr/bin", GHOST_CODEX_BINARY: "owner-codex" },
      claudeCodeProbe: {
        read: async () => ({
          binaryPath: "/resolved/claude",
          authStatus: { loggedIn: true, authMethod: "claude.ai" },
        }),
      },
      resolveCodexExecutable,
    });

    const result = await catalog.list();

    expect(result.workers.map((worker) => worker.id)).toEqual([
      "claude-code",
      "codex",
      "pi-worker",
    ]);
    expect(result.workers[0]).toMatchObject({
      kind: "native",
      nativeConfiguration: true,
      installation: "installed",
      authentication: "authenticated",
      reason: null,
      usage: {
        source: "omarchy",
        state: "ready",
        updatedAt: "2026-08-30T09:00:00.000Z",
        stale: false,
        tier: "Max",
        limits: [{
          label: "Session",
          usedFraction: 0.25,
          resetsAt: "2026-08-30T12:00:00.000Z",
        }],
        today: { totalTokens: 12_345, prompts: 7, sessions: 2 },
      },
    });
    expect(result.workers[1]).toMatchObject({
      installation: "installed",
      authentication: "unknown",
      usage: {
        status: "Local stats are still available. Retry later.",
      },
    });
    expect(result.workers[2]).toEqual({
      id: "pi-worker",
      name: "Pi worker",
      kind: "builtin",
      nativeConfiguration: false,
      installation: "installed",
      authentication: "ghost-model",
      reason: null,
      usage: null,
    });
    expect(resolveCodexExecutable).toHaveBeenCalledTimes(1);
  });

  it("keeps stale, missing, and unsafe records categorical without failing discovery", async () => {
    const usageDir = scratch("ghost-worker-usage-invalid-");
    writeUsage(usageDir, "claude");
    const outside = join(scratch("ghost-worker-usage-outside-"), "codex.json");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    symlinkSync(outside, join(usageDir, "codex.json"));
    const catalog = new WorkerCatalog({
      usageDir,
      now: () => Date.parse("2026-08-30T10:00:01Z"),
      claudeCodeProbe: {
        read: async () => ({ binaryPath: "/claude", authStatus: { loggedIn: false } }),
      },
      resolveCodexExecutable: async () => {
        throw new Error("codex is not installed\nwith extra detail");
      },
    });

    const result = await catalog.list();

    expect(result.workers[0]).toMatchObject({
      installation: "installed",
      authentication: "unauthenticated",
      usage: { state: "ready", stale: true },
    });
    expect(result.workers[1]).toMatchObject({
      installation: "missing",
      authentication: "unknown",
      reason: "Codex is unavailable. Install it or check `GHOST_CODEX_BINARY`.",
      usage: { state: "invalid", stale: true },
    });
  });

  it("keeps a transient Claude probe failure distinct from a missing executable", async () => {
    const usageDir = scratch("ghost-worker-usage-missing-");
    const catalog = new WorkerCatalog({
      usageDir,
      claudeCodeProbe: {
        read: async () => {
          throw new Error("auth probe failed for /owner/private/claude");
        },
      },
      resolveCodexExecutable: async () => "/codex",
    });

    const result = await catalog.list();
    expect(result.workers[0]).toMatchObject({
      installation: "unknown",
      authentication: "unknown",
      reason: "Could not verify Claude Code. Run `claude auth status --json` to diagnose it.",
      usage: { state: "missing", updatedAt: null, stale: true },
    });
    expect(result.workers[1]).toMatchObject({
      installation: "installed",
      usage: { state: "missing", updatedAt: null, stale: true },
    });
    expect(JSON.stringify(result)).not.toContain("/owner/private/claude");
  });

  it("reports a categorically missing Claude executable without exposing its configured path", async () => {
    const catalog = new WorkerCatalog({
      usageDir: scratch("ghost-worker-usage-missing-claude-"),
      claudeCodeProbe: {
        read: async () => {
          throw new GhostError(
            "claude_code_missing",
            "Claude Code is not installed at /owner/private/claude.",
            503,
          );
        },
      },
      resolveCodexExecutable: async () => "/codex",
    });

    const result = await catalog.list();
    expect(result.workers[0]).toMatchObject({
      installation: "missing",
      authentication: "unknown",
      reason: "Install Claude Code, then run `claude auth login`.",
    });
    expect(JSON.stringify(result)).not.toContain("/owner/private/claude");
  });

  it("rejects a nonpositive staleness window", () => {
    expect(() => new WorkerCatalog({ staleAfterMs: 0 })).toThrow(RangeError);
  });
});

describe("worker executable and state paths", () => {
  it("resolves only executable files from absolute PATH entries", async () => {
    const root = scratch("ghost-worker-executable-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const executable = join(bin, "codex");
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(executable, 0o700);

    await expect(resolveWorkerExecutable("codex", {
      PATH: `relative:${bin}`,
    })).resolves.toBe(executable);
    await expect(resolveWorkerExecutable("./codex", { PATH: bin })).rejects.toThrow(
      "must be absolute",
    );
  });

  it("uses only an absolute XDG state home", () => {
    expect(defaultOmarchyUsageDir("/owner", { XDG_STATE_HOME: "/state" })).toBe(
      "/state/omarchy/agents/usage",
    );
    expect(defaultOmarchyUsageDir("/owner", { XDG_STATE_HOME: "relative" })).toBe(
      "/owner/.local/state/omarchy/agents/usage",
    );
  });
});
