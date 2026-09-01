import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeHarnessStatus } from "../src/native-harness-catalog.js";
import { runCli } from "./helpers/cli.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture(): {
  home: string;
  list: ReturnType<typeof vi.fn<() => Promise<readonly NativeHarnessStatus[]>>>;
  fetch: ReturnType<typeof vi.fn>;
} {
  const root = mkdtempSync(join(tmpdir(), "ghost-delegation-cli-test-"));
  roots.push(root);
  const home = join(root, "owner-home-does-not-exist");
  const list = vi.fn(async () => [
    {
      id: "claude-code" as const,
      availability: "available" as const,
      authentication: "authenticated" as const,
      privateExecutable: "/must/not/print",
    },
    {
      id: "codex" as const,
      availability: "unavailable" as const,
      authentication: "unknown" as const,
      privateError: "provider secret",
    },
    {
      id: "pi" as const,
      availability: "available" as const,
      authentication: "unknown" as const,
    },
  ] as readonly NativeHarnessStatus[]);
  const fetch = vi.fn(async (): Promise<Response> => {
    throw new Error("delegation status must not contact ghostd");
  });
  return { home, list, fetch };
}

describe("ghost delegation", () => {
  it("prints concise local status without daemon, ghost-home, config, hook, or cwd effects", async () => {
    const { home, list, fetch } = fixture();
    const cwd = process.cwd();
    const result = await runCli(["delegation"], {
      home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".state"),
        ANTHROPIC_API_KEY: "must-not-cross",
      },
      fetch,
      nativeHarnesses: { list },
    });

    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: [
        "harness      availability  authentication",
        "claude-code  available     authenticated",
        "codex        unavailable   unknown",
        "pi           available     unknown",
        "",
      ].join("\n"),
    });
    expect(list).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(false);
    expect(process.cwd()).toBe(cwd);
  });

  it("emits only the bounded public catalogue shape as JSON", async () => {
    const { home, list, fetch } = fixture();
    const result = await runCli(["delegation", "--json"], {
      home,
      env: { HOME: home },
      fetch,
      nativeHarnesses: { list },
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      harnesses: [
        { id: "claude-code", availability: "available", authentication: "authenticated" },
        { id: "codex", availability: "unavailable", authentication: "unknown" },
        { id: "pi", availability: "available", authentication: "unknown" },
      ],
    });
    expect(result.stdout).not.toContain("private");
    expect(result.stdout).not.toContain("secret");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(false);
  });

  it("keeps help offline and rejects positionals and unknown verbs before probing", async () => {
    const { home, list, fetch } = fixture();
    const options = { home, env: { HOME: home }, fetch, nativeHarnesses: { list } };

    const help = await runCli(["delegation", "--help"], options);
    expect(help).toMatchObject({ code: 0, stderr: "" });
    expect(help.stdout).toContain("Usage: ghost delegation");
    expect((await runCli(["delegation", "mutate"], options))).toMatchObject({
      code: 2,
      stdout: "",
    });
    expect((await runCli(["delegations"], options))).toMatchObject({
      code: 2,
      stdout: "",
      stderr: "ghost: Unknown command: delegations\n",
    });
    expect(list).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(false);
  });
});
