import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessHarness, parseOmarchyAgents, STALE_AFTER_MS } from "../src/harnesses.js";
import { runCli } from "./helpers/cli.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const FRESH = new Date(NOW - 60_000).toISOString();
const LATER = "2026-09-26T15:00:00Z";

function record(limits: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, ready: true, updatedAt: FRESH, usageStatusText: "", limits, ...extra };
}

function commandsJson(args: string): string {
  return JSON.stringify({
    ok: true,
    commands: [
      { route: "omarchy agent", args: "[--inline] [--pick]" },
      { route: "omarchy default agent", args },
    ],
  });
}

describe("parseOmarchyAgents", () => {
  it("reads the default-agent choices in Omarchy's order", () => {
    expect(parseOmarchyAgents(commandsJson("[pi|omp|claude|codex|cursor-agent]")))
      .toEqual(["pi", "omp", "claude", "codex", "cursor-agent"]);
  });

  it("fails loudly when Omarchy stops naming them", () => {
    expect(() => parseOmarchyAgents(JSON.stringify({ commands: [] }))).toThrow(/default-agent/u);
  });
});

describe("assessHarness", () => {
  it("is eligible without a usage record", () => {
    expect(assessHarness("pi", null, NOW)).toEqual({ id: "pi", eligible: true, reason: null, usage: null });
  });

  it("is eligible with room in every window", () => {
    const harness = assessHarness("claude", record([
      { label: "Session (5-hour)", percent: 0.4, resetsAt: LATER },
      { label: "Weekly (7-day)", percent: 0.89, resetsAt: LATER },
    ]), NOW);
    expect(harness.eligible).toBe(true);
    expect(harness.usage).toEqual({
      updatedAt: FRESH,
      stale: false,
      status: null,
      windows: [
        { label: "Session (5-hour)", percent: 0.4, resetsAt: LATER },
        { label: "Weekly (7-day)", percent: 0.89, resetsAt: LATER },
      ],
    });
  });

  it("is ineligible once a live window reaches the ceiling, naming it", () => {
    const harness = assessHarness("claude", record([
      { label: "Session (5-hour)", percent: 0.93, resetsAt: LATER },
    ]), NOW);
    expect(harness.eligible).toBe(false);
    expect(harness.reason).toBe(`Session (5-hour) 93% used, resets ${LATER}`);
  });

  it("drops a window whose reset has passed instead of trusting its stale percent", () => {
    const harness = assessHarness("grok", record([
      { label: "Weekly", percent: 1, resetsAt: "2026-09-26T11:00:00Z" },
    ]), NOW);
    expect(harness.eligible).toBe(true);
    expect(harness.usage?.windows).toEqual([]);
  });

  it("stays eligible when Omarchy has nothing to show: `ready` is not a sign-in check", () => {
    const harness = assessHarness("claude", record([], {
      ready: false,
      authHelpText: "Run `claude auth login` to restore authoritative usage.",
    }), NOW);
    expect(harness).toMatchObject({ eligible: true, reason: null, usage: { status: null } });
  });

  it("keeps an unmeasured harness eligible and carries Omarchy's note", () => {
    const harness = assessHarness("codex", record([], { usageStatusText: "Codex limits unavailable" }), NOW);
    expect(harness).toMatchObject({ eligible: true, usage: { status: "Codex limits unavailable", windows: [] } });
  });

  it("flags a stale record without changing eligibility", () => {
    const old = new Date(NOW - STALE_AFTER_MS - 1).toISOString();
    const harness = assessHarness("claude", record([], { updatedAt: old }), NOW);
    expect(harness).toMatchObject({ eligible: true, usage: { stale: true } });
  });

  it("ignores malformed windows", () => {
    const harness = assessHarness("claude", record([null, { label: "x" }, { percent: 0.99 }]), NOW);
    expect(harness).toMatchObject({ eligible: true, usage: { windows: [] } });
  });
});

describe("ghost harnesses", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function machine(): NodeJS.ProcessEnv {
    root = mkdtempSync(join(tmpdir(), "ghost-harnesses-"));
    const bin = join(root, "bin");
    const usage = join(root, "state", "omarchy", "agents", "usage");
    mkdirSync(bin);
    mkdirSync(usage, { recursive: true });
    const executable = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    writeFileSync(join(root, "commands.json"), commandsJson("[pi|omp|claude|codex|agy|hermes|grok]"));
    executable("omarchy", `cat '${join(root, "commands.json")}'`);
    // mise has installed pi's tool, nothing else.
    executable("mise", '[ "$1" = which ] && [ "$2" = pi ]');
    // pi and agy are Omarchy first-run stubs: pi's is warm, agy's cold.
    for (const name of ["pi", "agy"]) executable(name, `mise use -g --quiet "${name}" || exit 1\nexec mise x "${name}" -- "${name}" "$@"`);
    // hermes comes from its own installer, whose --check says it is not there yet.
    executable("hermes", "exit 0");
    executable("omarchy-install-hermes-cli", '[ "$1" = --check ] && exit 1');
    // claude and codex are the owner's own installs; omp and grok are absent.
    for (const name of ["claude", "codex"]) executable(name, "exit 0");
    writeFileSync(join(usage, "claude.json"), JSON.stringify(record([
      { label: "Session (5-hour)", percent: 0.95, resetsAt: "2999-01-01T00:00:00Z" },
    ], { updatedAt: new Date().toISOString() })));
    writeFileSync(join(usage, "codex.json"), JSON.stringify(record([
      { label: "Weekly", percent: 0.2, resetsAt: "2999-01-01T00:00:00Z" },
    ], { updatedAt: new Date().toISOString() })));
    return { PATH: `${bin}:/usr/bin:/bin`, XDG_STATE_HOME: join(root, "state") };
  }

  it("lists installed harnesses in Omarchy's order, skipping cold stubs, without a daemon", async () => {
    const env = machine();
    const result = await runCli(["harnesses", "--json"], { env, home: root });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { harnesses: Array<{ id: string; eligible: boolean; reason: string | null }>; refresh: string };
    expect(body.harnesses.map((harness) => [harness.id, harness.eligible])).toEqual([
      ["pi", true],
      ["claude", false],
      ["codex", true],
    ]);
    expect(body.harnesses[1]?.reason).toMatch(/^Session \(5-hour\) 95% used/u);
    expect(body.refresh).toBe("omarchy agent usage update");
  });

  it("-q prints only the eligible ids", async () => {
    const env = machine();
    const result = await runCli(["harnesses", "-q"], { env, home: root });
    expect(result.stdout).toBe("pi\ncodex\n");
  });

  it("renders a readable table", async () => {
    const env = machine();
    const result = await runCli(["harnesses"], { env, home: root });
    expect(result.stdout).toContain("claude  no: Session (5-hour) 95% used");
    expect(result.stdout).toContain("pi      eligible");
    expect(result.stdout).toContain("no usage record");
    expect(result.stdout).toContain("refresh: omarchy agent usage update");
  });

  it("fails with a clear message when omarchy is missing", async () => {
    root = mkdtempSync(join(tmpdir(), "ghost-harnesses-"));
    const result = await runCli(["harnesses"], { env: { PATH: join(root, "nowhere") }, home: root });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/^ghost: cannot list harnesses: /u);
  });
});
