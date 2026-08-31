import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as testClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAgentSdkLoader,
  type ClaudeAgentSdkModule,
} from "../src/claude-agent-sdk-loader.js";
import {
  ClaudeNativeHarnessProbe,
  CodexNativeHarnessProbe,
  NativeHarnessCatalog,
  PiNativeHarnessProbe,
  type NativeHarnessFreshProbe,
  type NativeHarnessProbeResult,
} from "../src/native-harness-catalog.js";
import type {
  NativeHarnessExecutable,
  NativeHarnessId,
} from "../src/native-harness-identity.js";

const roots: string[] = [];

class StubClaudeAgentSdkLoader extends ClaudeAgentSdkLoader {
  constructor(private readonly implementation: () => Promise<ClaudeAgentSdkModule>) {
    super({ ownerHome: "/tmp" });
  }

  override load(): Promise<ClaudeAgentSdkModule> {
    return this.implementation();
  }
}

function validClaudeAgentSdkLoader(): ClaudeAgentSdkLoader {
  return new StubClaudeAgentSdkLoader(async () => testClaudeAgentSdk);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ghost-native-catalog-test-"));
  roots.push(path);
  return path;
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o700);
}

function fakeCodex(input: {
  base: string;
  account?: unknown;
  requiresOpenaiAuth?: boolean;
  appOutput?: string;
  versionFile?: string;
}): { binary: string; log: string } {
  const binary = join(input.base, "codex");
  const log = join(input.base, "codex.log");
  const account = input.account === undefined ? { type: "chatgpt", email: "owner@example.test" }
    : input.account;
  const appOutput = input.appOutput ?? [
    JSON.stringify({ id: "ghost-initialize", result: {} }),
    JSON.stringify({
      id: "ghost-account",
      result: { account, requiresOpenaiAuth: input.requiresOpenaiAuth ?? true },
    }),
  ].join("\n") + "\n";
  const versionFile = input.versionFile ?? join(input.base, "codex-version");
  if (input.versionFile === undefined) writeFileSync(versionFile, "0.151.0\n");
  writeExecutable(binary, `
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const record = { args, cwd: process.cwd(), entries: readdirSync("."), env: process.env };
if (args[0] === "--version") {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + "\\n");
  process.stdout.write("codex-cli " + readFileSync(${JSON.stringify(versionFile)}, "utf8"));
} else if (args[0] === "app-server") {
  record.input = "";
  let responded = false;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    record.input += line + "\\n";
    if (!responded) {
      process.stdout.write(${JSON.stringify(appOutput)});
      responded = true;
    }
  }
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + "\\n");
} else {
  process.exitCode = 2;
}
`);
  return { binary, log };
}

function fakePi(base: string, version = "0.84.2\n"): { binary: string; log: string } {
  const binary = join(base, "pi");
  const log = join(base, "pi.log");
  writeExecutable(binary, `
import { appendFileSync, readdirSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), entries: readdirSync("."), env: process.env,
}) + "\\n");
process.stdout.write(${JSON.stringify(version)});
`);
  return { binary, log };
}

function fakeClaude(base: string): { binary: string; log: string } {
  const binary = join(base, "claude");
  const log = join(base, "claude.log");
  writeExecutable(binary, `
import { appendFileSync, readdirSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args, cwd: process.cwd(), entries: readdirSync("."), env: process.env,
}) + "\\n");
if (args[0] === "--version") process.stdout.write("2.1.251 (Claude Code)\\n");
else {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    authMethod: "future-native-method",
    accountId: "private-account-id",
  }));
}
`);
  return { binary, log };
}

function logRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("native harness probes", () => {
  it("uses the Claude native environment without principal auto-memory policy", async () => {
    const base = root();
    const { binary, log } = fakeClaude(base);
    const result = await new ClaudeNativeHarnessProbe({
      sdkLoader: validClaudeAgentSdkLoader(),
      binaryPath: binary,
      environment: {
        HOME: "/home/owner",
        PATH: process.env.PATH,
        ANTHROPIC_BASE_URL: "https://router.invalid",
        ANTHROPIC_API_KEY: "must-not-cross",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "ambient-value",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
      },
    }).readFresh();

    expect(result).toMatchObject({
      id: "claude-code",
      version: "2.1.251",
      authentication: "authenticated",
    });
    for (const row of logRows(log)) {
      const env = row.env as NodeJS.ProcessEnv;
      expect(env.ANTHROPIC_BASE_URL).toBe("https://router.invalid");
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("ghostd/0.0.1");
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(row.entries).toEqual([]);
      expect(row.cwd).toMatch(/\/ghost-native-probe-/u);
    }
  });

  it.each(["missing", "rejecting"] as const)(
    "fails Claude catalogue closed before the CLI when its SDK loader is %s",
    async (kind) => {
      const base = root();
      const { binary, log } = fakeClaude(base);
      const sdkLoader = kind === "missing"
        ? new ClaudeAgentSdkLoader({ ownerHome: base, xdgDataHome: join(base, "data") })
        : new StubClaudeAgentSdkLoader(async () => {
          throw new Error("SDK load rejected");
        });
      const claude = new ClaudeNativeHarnessProbe({ sdkLoader, binaryPath: binary });
      const catalog = new NativeHarnessCatalog({
        claudeAgentSdkLoader: sdkLoader,
        probes: {
          "claude-code": claude,
          codex: new MutableProbe("codex", "authenticated"),
          pi: new MutableProbe("pi", "unknown"),
        },
      });

      expect((await catalog.list())[0]).toEqual({
        id: "claude-code",
        availability: "unavailable",
        authentication: "unknown",
      });
      expect(existsSync(log)).toBe(false);
      await expect(catalog.readForStart("claude-code")).rejects.toBeInstanceOf(Error);
      expect(existsSync(log)).toBe(false);
    },
  );

  it("uses the injected production SDK loader before a valid Claude CLI", async () => {
    const base = root();
    const { binary, log } = fakeClaude(base);
    const sdkLoader = validClaudeAgentSdkLoader();
    const catalog = new NativeHarnessCatalog({
      claudeAgentSdkLoader: sdkLoader,
      claudeCode: {
        binaryPath: binary,
        environment: { HOME: "/home/owner", PATH: process.env.PATH },
      },
    });

    await expect(catalog.readForStart("claude-code")).resolves.toMatchObject({
      id: "claude-code",
      authentication: "authenticated",
    });
    expect(logRows(log).map((row) => row.args)).toEqual([
      ["--version"],
      ["--setting-sources", "", "--safe-mode", "--strict-mcp-config", "auth", "status", "--json"],
    ]);
  });

  it("makes the principal SDK loader mandatory for production construction", () => {
    expect(() => new ClaudeNativeHarnessProbe({} as never)).toThrow(
      "requires the principal SDK loader",
    );
    expect(() => new NativeHarnessCatalog({} as never)).toThrow(
      "requires the principal SDK loader",
    );
  });

  it("runs only Codex initialize, initialized, and account/read without project cwd", async () => {
    const base = root();
    const { binary, log } = fakeCodex({ base });
    const result = await new CodexNativeHarnessProbe({
      binaryPath: binary,
      environment: {
        HOME: "/home/owner",
        PATH: process.env.PATH,
        CODEX_HOME: "/home/owner/.codex",
        OPENAI_API_KEY: "must-not-cross",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
      },
    }).readFresh();

    expect(result).toMatchObject({
      id: "codex",
      version: "0.151.0",
      authentication: "authenticated",
    });
    const rows = logRows(log);
    expect(rows.map((row) => row.args)).toEqual([["--version"], ["app-server"]]);
    for (const row of rows) {
      const env = row.env as NodeJS.ProcessEnv;
      expect(env.CODEX_HOME).toBe("/home/owner/.codex");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(row.entries).toEqual([]);
      expect(row.cwd).toMatch(/\/ghost-native-probe-/u);
    }
    const messages = String(rows[1]!.input).trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
    ]);
    expect(messages[2]).toMatchObject({ params: { refreshToken: false } });
    expect(String(rows[1]!.input)).not.toMatch(/supportedAgents|project|hook|mcp|memory/iu);
  });

  it("reports Pi authentication unknown and keeps its probe side-effect free", async () => {
    const base = root();
    const { binary, log } = fakePi(base);
    const result = await new PiNativeHarnessProbe({
      binaryPath: binary,
      environment: {
        HOME: "/home/owner",
        PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: "/home/owner/.pi/agent",
        PI_PACKAGE_DIR: "/home/owner/.pi/package",
        PI_CONFIG_FILES: "/tmp/inject",
        ANTHROPIC_API_KEY: "must-not-cross",
      },
    }).readFresh();

    expect(result).toMatchObject({ id: "pi", version: "0.84.2", authentication: "unknown" });
    const [row] = logRows(log);
    expect(row!.args).toEqual(["--version"]);
    expect(row!.entries).toEqual([]);
    expect(row!.cwd).toMatch(/\/ghost-native-probe-/u);
    expect(row!.env).toMatchObject({
      PI_CODING_AGENT_DIR: "/home/owner/.pi/agent",
      PI_PACKAGE_DIR: "/home/owner/.pi/package",
    });
    expect((row!.env as NodeJS.ProcessEnv).PI_CONFIG_FILES).toBeUndefined();
    expect((row!.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("keeps Codex external/no-account auth descriptive instead of calling it logged out", async () => {
    const base = root();
    const { binary } = fakeCodex({ base, account: null, requiresOpenaiAuth: false });
    const result = await new CodexNativeHarnessProbe({
      binaryPath: binary,
      environment: { PATH: process.env.PATH },
    }).readFresh();

    expect(result.authentication).toBe("unknown");
  });

  it.each([
    "not-json\n",
    `${JSON.stringify({ id: "ghost-initialize", result: {} })}\n`,
    `${JSON.stringify({ id: "unexpected", result: {} })}\n`
      + `${JSON.stringify({ id: "ghost-account", result: { account: null, requiresOpenaiAuth: true } })}\n`,
    `${JSON.stringify({ id: "ghost-initialize", result: {} })}\n`
      + `${JSON.stringify({ id: "ghost-account", method: "server/request", params: {} })}\n`,
    `${JSON.stringify({ id: "ghost-initialize", result: {} })}\n`
      + `${JSON.stringify({ id: "ghost-account", result: { account: {}, requiresOpenaiAuth: true } })}\n`,
  ])("fails closed for malformed Codex app-server output %#", async (appOutput) => {
    const base = root();
    const { binary } = fakeCodex({ base, appOutput });
    await expect(new CodexNativeHarnessProbe({
      binaryPath: binary,
      environment: { HOME: "/home/owner", PATH: process.env.PATH },
      timeoutMs: 100,
    }).readFresh()).rejects.toBeInstanceOf(Error);
  });

  it.each([
    "codex-cli 0.151.0-beta.1\n",
    "codex-cli 0.151.0\nsecret-second-line\n",
    "codex-cli 01.2.3\n",
  ])("rejects malformed Codex version %j", async (version) => {
    const base = root();
    const versionFile = join(base, "version");
    writeFileSync(versionFile, version);
    const { binary } = fakeCodex({ base, versionFile });
    await expect(new CodexNativeHarnessProbe({
      binaryPath: binary,
      environment: { PATH: process.env.PATH },
    }).readFresh()).rejects.toThrow("invalid stable version");
  });

  it("binds version and account rotations into the private runtime identity", async () => {
    const base = root();
    const versionFile = join(base, "version");
    writeFileSync(versionFile, "0.151.0\n");
    const { binary } = fakeCodex({ base, versionFile });
    const first = await new CodexNativeHarnessProbe({
      binaryPath: binary,
      environment: { PATH: process.env.PATH },
    }).readFresh();
    writeFileSync(versionFile, "0.152.0\n");
    const second = await new CodexNativeHarnessProbe({
      binaryPath: binary,
      environment: { PATH: process.env.PATH },
    }).readFresh();

    expect(first.executable.identity).toBe(second.executable.identity);
    expect(first.version).toBe("0.151.0");
    expect(second.version).toBe("0.152.0");
    expect(second.runtimeIdentity).not.toBe(first.runtimeIdentity);
  });
});

function privateResult(
  id: NativeHarnessId,
  authentication: NativeHarnessProbeResult["authentication"],
): NativeHarnessProbeResult {
  const executable: NativeHarnessExecutable = Object.freeze({
    path: `/private/${id}`,
    identity: `${id}-filesystem-identity`,
    literalBoundary: true,
  });
  return Object.freeze({
    id,
    executable,
    version: "private-version",
    authentication,
    runtimeIdentity: `${id}-runtime-identity`,
    accountFingerprint: `${id}-private-account`,
  });
}

class MutableProbe implements NativeHarnessFreshProbe {
  calls = 0;
  failure?: Error;

  constructor(
    readonly id: NativeHarnessId,
    private readonly authentication: NativeHarnessProbeResult["authentication"],
  ) {}

  async readFresh(): Promise<NativeHarnessProbeResult> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return privateResult(this.id, this.authentication);
  }
}

describe("native harness catalogue", () => {
  it("projects only bounded status and never leaks private probe evidence or raw errors", async () => {
    const claude = new MutableProbe("claude-code", "authenticated");
    const codex = new MutableProbe("codex", "logged_out");
    const pi = new MutableProbe("pi", "unknown");
    pi.failure = new Error("private path /owner and token SECRET-SENTINEL");
    const catalog = new NativeHarnessCatalog({
      claudeAgentSdkLoader: validClaudeAgentSdkLoader(),
      probes: { "claude-code": claude, codex, pi },
    });

    const statuses = await catalog.list();

    expect(statuses).toEqual([
      { id: "claude-code", availability: "available", authentication: "authenticated" },
      { id: "codex", availability: "available", authentication: "logged_out" },
      { id: "pi", availability: "unavailable", authentication: "unknown" },
    ]);
    expect(Object.isFrozen(statuses)).toBe(true);
    expect(statuses.every(Object.isFrozen)).toBe(true);
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toMatch(/private|version|path|account|SECRET-SENTINEL/u);
    expect(statuses.every((status) => Object.keys(status).length === 3)).toBe(true);
  });

  it("never lets the bounded display cache authorize a start", async () => {
    const claude = new MutableProbe("claude-code", "authenticated");
    const codex = new MutableProbe("codex", "authenticated");
    const pi = new MutableProbe("pi", "unknown");
    const catalog = new NativeHarnessCatalog({
      claudeAgentSdkLoader: validClaudeAgentSdkLoader(),
      probes: { "claude-code": claude, codex, pi },
      ttlMs: 5_000,
    });
    expect((await catalog.list())[1]).toMatchObject({ availability: "available" });
    codex.failure = new Error("logged out after display probe");

    expect((await catalog.list())[1]).toMatchObject({ availability: "available" });
    expect(codex.calls).toBe(1);
    await expect(catalog.readForStart("codex")).rejects.toThrow("logged out");
    expect(codex.calls).toBe(2);
    catalog.invalidate();
    expect((await catalog.list())[1]).toEqual({
      id: "codex",
      availability: "unavailable",
      authentication: "unknown",
    });
    expect(codex.calls).toBe(3);
  });
});
