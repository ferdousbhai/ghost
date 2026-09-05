import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type {
  Options as ClaudeQueryOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as testClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import {
  createBrowserExtension,
  createScreenExtension,
  GHOST_BROWSER,
  GHOST_SCREEN,
} from "@ghost/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeClaudeCodeTools,
  claudeCodeConnectionMethod,
  claudeCodeSubscriptionType,
  claudeSessionMetadataPath,
  CLAUDE_SESSION_METADATA_MAX_BYTES,
  CLAUDE_CODE_BINARY_ENV,
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_TOOL_CAPABILITIES,
  ClaudeCodeProbe,
  ClaudeCodeProcessError,
  readClaudeCodeAuthStatus,
  readClaudeCodeVersion,
  readClaudeSessionMetadataFile,
  resolveClaudeCodeExecutable,
  type ClaudeCodeAuthStatus,
  type ClaudeCodeQueryInput,
} from "../src/claude-code.js";
import { claudeSdkTranscriptPath } from "../src/claude-sdk-files.js";
import { captureClaudeCodeEnvironment } from "../src/env-scrub.js";
import { ghostPaths } from "../src/ghosts.js";
import {
  PresentationHistoryStore,
  presentationHistoryPath,
} from "../src/presentation-history.js";
import { ReviewJournalStore, reviewJournalPath } from "../src/review-journal.js";
import { GhostHookRunner } from "../src/hooks.js";
import type { Logger } from "../src/log.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { setGhostModelRole } from "../src/models.js";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import {
  loadProjectDeclarativeSnapshot,
  PROJECT_SCAN_MAX_ENTRIES,
} from "../src/project-resources.js";
import {
  declarativePromptSnapshot,
  mergeProjectDeclarativeSnapshots,
} from "../src/declarative-snapshot.js";
import { SessionHost, type SessionHostOptions } from "../src/session-host.js";
import { makeFakeCatalogRuntime } from "./helpers/fake-catalog-runtime.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { recordingLogger } from "./helpers/recording-logger.js";
let temp: TempGhosts | null = null;
let host: SessionHost | null = null;
const FAKE_QUERY_EXIT = Symbol("fake-query-exit");
const STABLE_TEST_ACCOUNT = "a".repeat(64);
const readSupportedClaudeVersion = async () => CLAUDE_CODE_MINIMUM_VERSION;

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
  vi.unstubAllEnvs();
});

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function filesystemTreeContains(root: string, needle: string): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (filesystemTreeContains(path, needle)) return true;
    } else if (entry.isFile() && readFileSync(path).includes(Buffer.from(needle))) {
      return true;
    }
  }
  return false;
}

/**
 * A warm query the way the real SDK behaves: one `result` per owner prompt,
 * with the stream left open for the next one. Pass `prompts` to drive it turn
 * by turn — draining that channel eagerly would deadlock, because a warm
 * query's input stays open for the life of the process. Omit it for a query
 * that only ever serves one turn.
 */
function fakeQuery(
  messages: SDKMessage[] | ((turn: number) => SDKMessage[]),
  lifecycle: { interrupted: number; closed: number },
  prompts?: AsyncIterable<SDKUserMessage>,
  onPrompt?: (message: SDKUserMessage) => void | Promise<void>,
  processExit = Promise.withResolvers<void>(),
  resolveExitOnClose = true,
): Query {
  let transportClosed = false;
  const forTurn = (turn: number): SDKMessage[] =>
    typeof messages === "function" ? messages(turn) : messages;
  const stream = (async function* () {
    if (!prompts) {
      for (const message of forTurn(1)) yield message;
      return;
    }
    let turn = 0;
    for await (const prompt of prompts) {
      await onPrompt?.(prompt);
      // Synthetic context carries no turn of its own, exactly as the SDK treats
      // a `shouldQuery: false` message.
      if ((prompt as { shouldQuery?: boolean }).shouldQuery === false) continue;
      turn += 1;
      for (const message of forTurn(turn)) yield message;
    }
  })();
  return Object.assign(stream, {
    interrupt: async () => {
      if (transportClosed) throw new Error("SDK control transport is closed");
      lifecycle.interrupted += 1;
    },
    close: () => {
      if (transportClosed) return;
      transportClosed = true;
      lifecycle.closed += 1;
      if (resolveExitOnClose) processExit.resolve();
    },
    [FAKE_QUERY_EXIT]: processExit.promise,
  }) as unknown as Query;
}

function observeFakeQueryExit(query: Query): Promise<void> {
  return (query as Query & { [FAKE_QUERY_EXIT]?: Promise<void> })[FAKE_QUERY_EXIT]
    ?? Promise.resolve();
}

interface TestMcpResult {
  isError?: boolean;
  content: Array<{ text?: string }>;
}

async function _invokeClaudeMcpTool(
  options: ClaudeQueryOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<TestMcpResult> {
  const servers = options.mcpServers as Record<string, {
    type: string;
    instance?: {
      _registeredTools?: Record<string, {
        handler(args: unknown, extra: unknown): Promise<unknown>;
      }>;
    };
  }>;
  const internal = Object.values(servers).find((server) =>
    server.type === "sdk" && server.instance?._registeredTools?.[name]
  );
  const tool = internal?.instance?._registeredTools?.[name];
  if (!tool) throw new Error(`Missing warm Claude task tool ${name}`);
  return await tool.handler(args, {}) as TestMcpResult;
}

function _mcpDetails(result: TestMcpResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
}

function responseMessages(sessionId: string, text: string, numTurns = 1): SDKMessage[] {
  return [
    sdkMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "start",
      session_id: sessionId,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    }),
    sdkMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "delta",
      session_id: sessionId,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    }),
    sdkMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "stop",
      session_id: sessionId,
      event: { type: "content_block_stop", index: 0 },
    }),
    sdkMessage({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: numTurns,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      result: text,
      uuid: "result",
      session_id: sessionId,
    }),
  ];
}

function errorResultMessage(
  sessionId: string,
  subtype: "error_during_execution" | "error_max_turns",
  numTurns: number,
): SDKMessage {
  return sdkMessage({
    type: "result",
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: numTurns,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors: [`simulated ${subtype}`],
    uuid: `result-${subtype}`,
    session_id: sessionId,
  });
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function setupClaudeHost(options: {
  authStatus?: ClaudeCodeAuthStatus;
  readAuthStatus?: (
    binaryPath: string,
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<ClaudeCodeAuthStatus>;
  readVersion?: (
    binaryPath: string,
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<string>;
  environment?: Readonly<NodeJS.ProcessEnv>;
  binaryPath?: string;
  probe?: ClaudeCodeProbe;
  createQuery?: (
    input: ClaudeCodeQueryInput,
    lifecycle: { queries: number; interrupted: number; closed: number },
  ) => Query;
  hooks?: GhostHookRunner;
  logger?: Logger;
  machineSkill?: { name: string; description: string; body: string };
  warmIdleTtlMs?: number;
  exitWaitTimeoutMs?: number;
  useSdkSpawnExitBoundary?: boolean;
  browserSessionClose?: SessionHostOptions["browserSessionClose"];
  scheduleCommandRunner?: SessionHostOptions["scheduleCommandRunner"];
  transactionMarkerLstat?: SessionHostOptions["transactionMarkerLstat"];
  transactionWriter?: SessionHostOptions["transactionWriter"];
  prepare?: (fixture: NonNullable<typeof temp>) => void;
} = {}) {
  temp = makeTempGhosts();
  options.prepare?.(temp);
  const dir = seedGhost(temp.root, {
    name: "casper",
    character: "# Casper\n\nYou are Casper, a letterpress printer.\n",
  });
  const paths = ghostPaths(dir);
  mkdirSync(paths.agentDir, { recursive: true });
  setGhostModelRole(paths.home, "chat_model", "claude-code", "default");
  const machineSkills = join(temp.ownerHome, ".agents", "skills");
  if (options.machineSkill) {
    const skillDir = join(machineSkills, options.machineSkill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${options.machineSkill.name}\ndescription: ${options.machineSkill.description}\n---\n\n${options.machineSkill.body}\n`,
    );
  }

  const seenOptions: ClaudeQueryOptions[] = [];
  const seenPrompts: SDKUserMessage[] = [];
  const lifecycle = { queries: 0, interrupted: 0, closed: 0 };
  const scheduleUnitDir = join(temp.ownerHome, ".xdg-config", "systemd", "user");
  host = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    scheduleUnitDir,
    scheduleRuntimeUnitDir: join(temp.ownerHome, ".runtime", "systemd", "user"),
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
    machineSkillPaths: options.machineSkill ? [machineSkills] : [],
    offline: true,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.browserSessionClose
      ? { browserSessionClose: options.browserSessionClose }
      : {}),
    ...(options.scheduleCommandRunner
      ? { scheduleCommandRunner: options.scheduleCommandRunner }
      : {}),
    ...(options.transactionMarkerLstat
      ? { transactionMarkerLstat: options.transactionMarkerLstat }
      : {}),
    ...(options.transactionWriter ? { transactionWriter: options.transactionWriter } : {}),
    claudeCode: {
      loadSdk: async () => testClaudeAgentSdk,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.warmIdleTtlMs === undefined
        ? {}
        : { warmIdleTtlMs: options.warmIdleTtlMs }),
      ...(options.exitWaitTimeoutMs === undefined
        ? {}
        : { exitWaitTimeoutMs: options.exitWaitTimeoutMs }),
      ...(options.probe
        ? { probe: options.probe }
        : {
          binaryPath: options.binaryPath ?? process.execPath,
          readVersion: options.readVersion ?? readSupportedClaudeVersion,
          readAuthStatus: options.readAuthStatus ?? (async () => {
            const status = options.authStatus ?? {
              loggedIn: true,
              authMethod: "claude.ai",
              subscriptionType: "max",
            };
            return status.loggedIn
              ? { accountFingerprint: STABLE_TEST_ACCOUNT, ...status }
              : status;
          }),
        }),
      createQuery: (input) => {
        lifecycle.queries += 1;
        seenOptions.push(input.options);
        if (options.createQuery) return options.createQuery(input, lifecycle);
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          responseMessages(sessionId, "Hello from the plan."),
          lifecycle,
          input.prompt,
          (message) => { seenPrompts.push(message); },
        );
      },
      ...(options.useSdkSpawnExitBoundary ? {} : { observeQueryExit: observeFakeQueryExit }),
    },
  });
  return { paths, scheduleUnitDir, seenOptions, seenPrompts, lifecycle };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = statLine.lastIndexOf(")");
    const state = commandEnd < 0 ? "" : statLine.slice(commandEnd + 2, commandEnd + 3);
    return state !== "Z" && state !== "X";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function expectPidsGone(path: string): Promise<void> {
  const pids = readFileSync(path, "utf8").trim().split(/\s+/u).map(Number);
  const deadline = Date.now() + 2_000;
  while (pids.some(pidExists) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  expect(pids).not.toEqual([]);
  expect(pids.filter(pidExists)).toEqual([]);
}

function storedClaudeV3(input: {
  conversationId: string;
  root: string;
  cwd?: string;
  mcpServers: Record<string, unknown>;
  mcpResources?: unknown;
  instruction?: string;
  declarative?: Record<string, unknown>;
}): string {
  const identity = statSync(input.root, { bigint: true });
  return `${JSON.stringify({
    version: 3,
    runtime: "claude-code",
    conversationId: input.conversationId,
    sessionId: `sdk-${input.conversationId}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    ownerTurnCount: 1,
    cwd: input.cwd ?? input.root,
    projectSnapshot: {
      root: input.root,
      identity: { dev: String(identity.dev), ino: String(identity.ino) },
      declarative: input.declarative ?? {
        instructions: [{
          path: join(input.root, "AGENTS.md"),
          content: input.instruction ?? "PINNED-PROJECT-SNAPSHOT",
        }],
        skills: [],
        rules: [],
        prompts: [],
        commands: [],
      },
      mcpServers: input.mcpServers,
      ...(input.mcpResources !== undefined ? { mcpResources: input.mcpResources } : {}),
      resourceWarnings: [],
      mcpWarnings: [],
    },
  })}\n`;
}

function storedClaudeV1(conversationId: string): string {
  return `${JSON.stringify({
    version: 1,
    runtime: "claude-code",
    conversationId,
    sessionId: `sdk-${conversationId}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    ownerTurnCount: 1,
  })}\n`;
}

function storedUnboundClaudeV3(conversationId: string): Record<string, unknown> {
  return {
    version: 3,
    runtime: "claude-code",
    conversationId,
    sessionId: `sdk-${conversationId}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    ownerTurnCount: 1,
    cwd: temp!.ownerHome,
    projectSnapshot: {
      root: null,
      declarative: {
        instructions: [],
        skills: [],
        rules: [],
        prompts: [],
        commands: [],
      },
      mcpServers: {},
      resourceWarnings: [],
      mcpWarnings: [],
    },
  };
}

describe("Claude Code executable/auth probe", () => {
  it("canonicalizes a discovered executable from a relative PATH before project cwd changes", async () => {
    temp = makeTempGhosts();
    const bin = join(temp.root, "relative-bin");
    mkdirSync(bin);
    const executable = join(bin, "claude");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const relativePath = relative(process.cwd(), bin);
    // Keep enough directory depth that resolving the startup-relative PATH
    // against this later cwd cannot clamp the `..` segments at `/` and land
    // on the same absolute path by accident.
    const ascentCount = relativePath.split("/").filter((part) => part === "..").length;
    const projectCwd = join(temp.root, "owner-project", ...Array(ascentCount + 1).fill("nested"));
    mkdirSync(projectCwd, { recursive: true });

    const resolved = await resolveClaudeCodeExecutable(undefined, {
      HOME: temp.ownerHome,
      PATH: relativePath,
    });

    expect(resolved).toBe(executable);
    expect(resolved.startsWith("/")).toBe(true);
    expect(resolve(projectCwd, relativePath, "claude")).not.toBe(resolved);
  });

  it("detects discovered symlink retargets and literal-wrapper replacement in place", async () => {
    temp = makeTempGhosts();
    const bin = join(temp.root, "bin");
    mkdirSync(bin);
    const firstTarget = join(temp.root, "claude-one");
    const secondTarget = join(temp.root, "claude-two");
    const discovered = join(bin, "claude");
    for (const path of [firstTarget, secondTarget]) {
      writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    symlinkSync(firstTarget, discovered);
    const authenticated = async (): Promise<ClaudeCodeAuthStatus> => ({
      loggedIn: true,
      authMethod: "claude.ai",
      accountFingerprint: STABLE_TEST_ACCOUNT,
    });
    const discoveredProbe = new ClaudeCodeProbe({
      environment: { HOME: temp.ownerHome, PATH: bin },
      readVersion: readSupportedClaudeVersion,
      readAuthStatus: authenticated,
    });
    const first = await discoveredProbe.readForTurn();
    rmSync(discovered);
    symlinkSync(secondTarget, discovered);
    const second = await discoveredProbe.readForTurn();
    expect(first.binaryPath).toBe(firstTarget);
    expect(second.binaryPath).toBe(secondTarget);
    expect(second.executableIdentity).not.toBe(first.executableIdentity);

    const wrapper = join(temp.root, "owner-wrapper");
    symlinkSync(firstTarget, wrapper);
    const wrapperProbe = new ClaudeCodeProbe({
      binaryPath: wrapper,
      environment: { HOME: temp.ownerHome, PATH: "/usr/bin" },
      readVersion: readSupportedClaudeVersion,
      readAuthStatus: authenticated,
    });
    const wrapperFirst = await wrapperProbe.readForTurn();
    rmSync(wrapper);
    symlinkSync(secondTarget, wrapper);
    const wrapperRetargeted = await wrapperProbe.readForTurn();
    expect(wrapperFirst.binaryPath).toBe(wrapper);
    expect(wrapperRetargeted.binaryPath).toBe(wrapper);
    expect(wrapperRetargeted.executableIdentity).not.toBe(wrapperFirst.executableIdentity);

    writeFileSync(secondTarget, "#!/bin/sh\n# replaced in place\nexit 0\n", { mode: 0o700 });
    const wrapperReplaced = await wrapperProbe.readForTurn();
    expect(wrapperReplaced.binaryPath).toBe(wrapper);
    expect(wrapperReplaced.executableIdentity).not.toBe(
      wrapperRetargeted.executableIdentity,
    );
  });

  it("passes the dedicated environment through mise executable resolution", async () => {
    temp = makeTempGhosts();
    const bin = join(temp.root, "bin");
    mkdirSync(bin);
    const launcher = join(bin, "claude");
    const native = join(temp.ownerHome, "native-claude");
    const observed = join(temp.ownerHome, "mise-observed");
    writeFileSync(launcher, "#!/usr/bin/env -S mise x claude --\n", { mode: 0o700 });
    writeFileSync(native, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(
      join(bin, "mise"),
      `#!/bin/sh
printf '%s' "$ANTHROPIC_BASE_URL" > "$HOME/mise-observed"
printf '%s' "$PWD" > "$HOME/mise-cwd"
/usr/bin/stat -c '%a' "$PWD" > "$HOME/mise-cwd-mode"
printf '%s\\n' "$HOME/native-claude"
`,
      { mode: 0o700 },
    );
    const environment = captureClaudeCodeEnvironment({
      HOME: temp.ownerHome,
      PATH: `${bin}:/usr/bin`,
      ANTHROPIC_BASE_URL: "https://mise-router.invalid",
      ANTHROPIC_API_KEY: "mise-secret-must-not-cross",
      OPENAI_API_KEY: "unrelated-secret",
    });

    await expect(resolveClaudeCodeExecutable(undefined, environment)).resolves.toBe(native);
    expect(readFileSync(observed, "utf8")).toBe("https://mise-router.invalid");
    const miseCwd = readFileSync(join(temp.ownerHome, "mise-cwd"), "utf8");
    expect(readFileSync(join(temp.ownerHome, "mise-cwd-mode"), "utf8").trim()).toBe("700");
    expect(existsSync(miseCwd)).toBe(false);
  });

  it("hard-kills a TERM-ignoring mise resolver and its pipe-holding descendant", async () => {
    temp = makeTempGhosts();
    const bin = join(temp.root, "bin");
    mkdirSync(bin);
    const pids = join(temp.ownerHome, "mise-pids");
    writeFileSync(
      join(bin, "claude"),
      "#!/usr/bin/env -S mise x claude --\n",
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "mise"),
      "#!/bin/sh\ntrap '' TERM\n"
        + "/bin/sh -c 'trap \"\" TERM; while :; do /bin/sleep 10; done' &\n"
        + "descendant=$!\nprintf '%s %s' \"$$\" \"$descendant\" > \"$HOME/mise-pids\"\n"
        + "wait\n",
      { mode: 0o700 },
    );
    const started = Date.now();

    await expect(resolveClaudeCodeExecutable(undefined, {
      HOME: temp.ownerHome,
      PATH: `${bin}:/usr/bin`,
    }, { timeoutMs: 250 })).rejects.toThrow("could not resolve mise's underlying");

    expect(Date.now() - started).toBeLessThan(1_750);
    await expectPidsGone(pids);
  });

  it("never unwraps an explicit export-and-mise owner wrapper", async () => {
    temp = makeTempGhosts();
    const bin = join(temp.root, "bin");
    mkdirSync(bin);
    const wrapper = join(temp.ownerHome, "claude-owner-wrapper");
    const native = join(temp.ownerHome, "native-claude");
    writeFileSync(
      wrapper,
      "#!/bin/sh\nexport CLAUDE_FUTURE_AUTH=from-owner-store\nexec mise x -- claude \"$@\"\n",
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "mise"),
      "#!/bin/sh\nshift 3\nexec \"$HOME/native-claude\" \"$@\"\n",
      { mode: 0o700 },
    );
    writeFileSync(
      native,
      "#!/bin/sh\ntest \"$CLAUDE_FUTURE_AUTH\" = from-owner-store || exit 17\n"
        + "if [ \"$1\" = --version ]; then\n"
        + "  printf '%s' \"$*\" > \"$HOME/wrapper-version-args\"\n"
        + "  printf '%s\\n' '2.1.251 (Claude Code)'\n"
        + "else\n"
        + "  printf '%s' \"$*\" > \"$HOME/wrapper-auth-status-args\"\n"
        + "  printf '%s\\n' '{\"loggedIn\":true,\"authMethod\":\"future_native_sso\"}'\n"
        + "fi\n",
      { mode: 0o700 },
    );
    vi.stubEnv(CLAUDE_CODE_BINARY_ENV, wrapper);
    const probe = new ClaudeCodeProbe({
      environment: { HOME: temp.ownerHome, PATH: `${bin}:/usr/bin` },
    });

    await expect(probe.read()).resolves.toMatchObject({
      binaryPath: wrapper,
      cliVersion: CLAUDE_CODE_MINIMUM_VERSION,
      authStatus: { loggedIn: true, authMethod: "future_native_sso" },
    });
    expect(readFileSync(join(temp.ownerHome, "wrapper-version-args"), "utf8")).toBe(
      "--version",
    );
    expect(readFileSync(join(temp.ownerHome, "wrapper-auth-status-args"), "utf8")).toBe(
      "--setting-sources  --safe-mode --strict-mcp-config auth status --json",
    );
  });

  it.each([
    CLAUDE_CODE_MINIMUM_VERSION,
    "2.1.252",
    "2.2.0",
    "3.0.0",
  ])("accepts canonical stable Claude Code version %s", async (version) => {
    temp = makeTempGhosts();
    const executable = join(temp.root, `claude-version-${version}`);
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\n' '${version} (Claude Code)'\n`,
      { mode: 0o700 },
    );

    await expect(readClaudeCodeVersion(executable, {
      HOME: temp.ownerHome,
      PATH: "/usr/bin",
    })).resolves.toBe(version);
  });

  it.each([
    ["older", "printf '%s\\n' '2.1.250 (Claude Code)'\n", "older than required"],
    ["prerelease", "printf '%s\\n' '2.1.251-beta.1 (Claude Code)'\n", "invalid stable version"],
    ["malformed", "printf '%s\\n' 'Claude Code 2.1.251'\n", "invalid stable version"],
    ["multiline", "printf '%s\\n' '2.1.251 (Claude Code)' 'unexpected'\n", "invalid stable version"],
    ["exit-two", "printf '%s\\n' '2.1.251 (Claude Code)'\nexit 2\n", "Failed to read Claude Code version"],
    ["signal", "printf '%s\\n' '2.1.251 (Claude Code)'\nkill -TERM $$\n", "Failed to read Claude Code version"],
    ["timeout", "printf '%s\\n' '2.1.251 (Claude Code)'\nexec sleep 5\n", "Failed to read Claude Code version"],
  ] as const)("rejects %s Claude Code version output", async (slug, script, message) => {
    temp = makeTempGhosts();
    const executable = join(temp.root, `claude-version-${slug}`);
    writeFileSync(executable, `#!/bin/sh\n${script}`, { mode: 0o700 });

    await expect(readClaudeCodeVersion(
      executable,
      { HOME: temp.ownerHome, PATH: "/usr/bin" },
      slug === "timeout" ? { timeoutMs: 25 } : {},
    )).rejects.toThrow(message);
  });

  it("hard-kills a TERM-ignoring version probe and its pipe-holding descendant", async () => {
    temp = makeTempGhosts();
    const executable = join(temp.root, "claude-version-hangs");
    const pids = join(temp.ownerHome, "version-pids");
    writeFileSync(
      executable,
      "#!/bin/sh\ntrap '' TERM\n"
        + "/bin/sh -c 'trap \"\" TERM; while :; do /bin/sleep 10; done' &\n"
        + "descendant=$!\nprintf '%s %s' \"$$\" \"$descendant\" > \"$HOME/version-pids\"\n"
        + "printf '%s\\n' '2.1.251 (Claude Code)'\nwait\n",
      { mode: 0o700 },
    );
    const started = Date.now();

    await expect(readClaudeCodeVersion(executable, {
      HOME: temp.ownerHome,
      PATH: "/usr/bin",
    }, { timeoutMs: 250 })).rejects.toThrow("Failed to read Claude Code version");

    expect(Date.now() - started).toBeLessThan(1_750);
    await expectPidsGone(pids);
  });

  it("fails closed before auth when the executable version is unsupported", async () => {
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "/resolved/claude",
      resolveExecutable: async (binary) => binary!,
      inspectExecutable: async (path) => `test:${path}`,
      readVersion: async () => {
        throw new ClaudeCodeProcessError("unsupported Claude Code version");
      },
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true };
      },
    });

    await expect(probe.read()).rejects.toThrow("unsupported Claude Code version");
    expect(authReads).toBe(0);
  });

  it("keeps only bounded non-secret metadata from the CLI auth status", async () => {
    temp = makeTempGhosts();
    const executable = join(temp.root, "claude-auth-status");
    const sentinel = "must-not-leave-cli-status";
    const accountSentinel = "owner-account@example.invalid";
    writeFileSync(
      executable,
      `#!/bin/sh
printf '%s' "$*" > "$HOME/auth-status-args"
printf '%s' "$PWD" > "$HOME/auth-status-cwd"
/usr/bin/stat -c '%a' "$PWD" > "$HOME/auth-status-cwd-mode"
: > .npmrc
printf '%s\\n' '${JSON.stringify({
        loggedIn: true,
        authMethod: " future_native_sso ",
        apiProvider: "owner-router",
        subscriptionType: "enterprise",
        email: accountSentinel,
        apiKey: sentinel,
        credentials: { token: sentinel },
      })}'\n`,
      { mode: 0o700 },
    );

    const status = await readClaudeCodeAuthStatus(executable, {
      HOME: temp.ownerHome,
      PATH: "/usr/bin",
    });

    expect(status).toEqual({
      loggedIn: true,
      authMethod: "future_native_sso",
      apiProvider: "owner-router",
      subscriptionType: "enterprise",
    });
    expect(JSON.stringify(status)).not.toContain(sentinel);
    expect(JSON.stringify(status)).not.toContain(accountSentinel);
    expect(status.accountFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(status)).not.toContain("accountFingerprint");
    expect(readFileSync(join(temp.ownerHome, "auth-status-args"), "utf8")).toBe(
      "--setting-sources  --safe-mode --strict-mcp-config auth status --json",
    );
    const authCwd = readFileSync(join(temp.ownerHome, "auth-status-cwd"), "utf8");
    expect(readFileSync(join(temp.ownerHome, "auth-status-cwd-mode"), "utf8").trim()).toBe("700");
    expect(existsSync(authCwd)).toBe(false);
    expect(claudeCodeConnectionMethod(status)).toBe("owner-router");
    expect(claudeCodeSubscriptionType(status)).toBe("enterprise");
    expect(claudeCodeConnectionMethod({
      loggedIn: true,
      authMethod: `unsafe\n${sentinel}`,
    })).toBe("external");
    expect(claudeCodeSubscriptionType({
      loggedIn: true,
      subscriptionType: `unsafe\n${sentinel}`,
    })).toBeUndefined();
  });

  it("accepts the CLI's documented exit-one logged-out result", async () => {
    temp = makeTempGhosts();
    const executable = join(temp.root, "claude-auth-logged-out");
    writeFileSync(
      executable,
      "#!/bin/sh\nprintf '%s\\n' '{\"loggedIn\":false,\"authMethod\":\"none\"}'\nexit 1\n",
      { mode: 0o700 },
    );

    await expect(readClaudeCodeAuthStatus(executable, {
      HOME: temp.ownerHome,
      PATH: "/usr/bin",
    })).resolves.toEqual({ loggedIn: false, authMethod: "none" });
  });

  it("hard-kills a TERM-ignoring auth probe and its pipe-holding descendant", async () => {
    temp = makeTempGhosts();
    const executable = join(temp.root, "claude-auth-hangs");
    const pids = join(temp.ownerHome, "auth-pids");
    writeFileSync(
      executable,
      "#!/bin/sh\ntrap '' TERM\n"
        + "/bin/sh -c 'trap \"\" TERM; while :; do /bin/sleep 10; done' &\n"
        + "descendant=$!\nprintf '%s %s' \"$$\" \"$descendant\" > \"$HOME/auth-pids\"\n"
        + "printf '%s' \"$PWD\" > \"$HOME/auth-cwd\"\n"
        + "printf '%s\\n' '{\"loggedIn\":true}'\nwait\n",
      { mode: 0o700 },
    );
    const started = Date.now();

    await expect(readClaudeCodeAuthStatus(executable, {
      HOME: temp.ownerHome,
      PATH: "/usr/bin",
    }, { timeoutMs: 250 })).rejects.toThrow(
      "Failed to read Claude Code authentication status",
    );

    expect(Date.now() - started).toBeLessThan(1_750);
    await expectPidsGone(pids);
    expect(existsSync(readFileSync(join(temp.ownerHome, "auth-cwd"), "utf8"))).toBe(false);
  });

  it.each([
    [
      "exit zero with loggedIn false",
      "zero-false",
      "printf '%s\\n' '{\"loggedIn\":false}'\n",
      undefined,
      "disagreed with exit 0",
    ],
    [
      "exit one with loggedIn true",
      "one-true",
      "printf '%s\\n' '{\"loggedIn\":true}'\nexit 1\n",
      undefined,
      "disagreed with exit 1",
    ],
    [
      "exit two even when stdout says loggedIn true",
      "two-true",
      "printf '%s\\n' '{\"loggedIn\":true}'\nexit 2\n",
      undefined,
      "Failed to read Claude Code authentication status",
    ],
    [
      "a signal even when stdout says loggedIn true",
      "signal-true",
      "printf '%s\\n' '{\"loggedIn\":true}'\nkill -TERM $$\n",
      undefined,
      "Failed to read Claude Code authentication status",
    ],
    [
      "a timeout even when stdout says loggedIn true",
      "timeout-true",
      "printf '%s\\n' '{\"loggedIn\":true}'\nexec sleep 5\n",
      25,
      "Failed to read Claude Code authentication status",
    ],
    [
      "malformed JSON on exit zero",
      "malformed",
      "printf '%s\\n' 'not-json'\n",
      undefined,
      "returned invalid JSON",
    ],
  ] as const)("rejects %s", async (_label, slug, script, timeoutMs, message) => {
    temp = makeTempGhosts();
    const executable = join(temp.root, `claude-auth-${slug}`);
    writeFileSync(executable, `#!/bin/sh\n${script}`, { mode: 0o700 });

    await expect(readClaudeCodeAuthStatus(
      executable,
      { HOME: temp.ownerHome, PATH: "/usr/bin" },
      timeoutMs === undefined ? {} : { timeoutMs },
    )).rejects.toThrow(message);
  });

  it("uses the same credential-free environment for resolution, version, and auth", async () => {
    const source = {
      HOME: "/home/owner",
      PATH: "/usr/bin",
      ANTHROPIC_AUTH_TOKEN: "router-secret",
      CLAUDE_CODE_USE_VERTEX: "1",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/owner/vertex.json",
      OPENROUTER_API_KEY: "unrelated-secret",
      GHOST_TEST_MODE: "private-test-flag",
      LD_PRELOAD: "/tmp/inject.so",
    } satisfies NodeJS.ProcessEnv;
    const seen: Readonly<NodeJS.ProcessEnv>[] = [];
    const probe = new ClaudeCodeProbe({
      binaryPath: "claude",
      environment: source,
      resolveExecutable: async (_binary, environment) => {
        seen.push(environment);
        return "/resolved/claude";
      },
      inspectExecutable: async (path) => `test:${path}`,
      readVersion: async (_binary, environment) => {
        seen.push(environment);
        return CLAUDE_CODE_MINIMUM_VERSION;
      },
      readAuthStatus: async (_binary, environment) => {
        seen.push(environment);
        return { loggedIn: true, authMethod: "api_key", apiProvider: "vertex" };
      },
    });

    await expect(probe.read()).resolves.toMatchObject({
      authStatus: { loggedIn: true, authMethod: "api_key", apiProvider: "vertex" },
    });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[1]).toEqual(seen[2]);
    expect(seen[0]).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: "1",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/owner/vertex.json",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
    expect(seen[0]?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(seen[0]?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(seen[0]?.OPENROUTER_API_KEY).toBeUndefined();
    expect(seen[0]?.GHOST_TEST_MODE).toBeUndefined();
    expect(seen[0]?.LD_PRELOAD).toBeUndefined();
  });

  it("single-flights concurrent work and retains one successful snapshot until TTL expiry", async () => {
    let now = 100;
    let resolutions = 0;
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "configured-claude",
      readVersion: readSupportedClaudeVersion,
      ttlMs: 5_000,
      now: () => now,
      resolveExecutable: async (configured) => {
        resolutions += 1;
        expect(configured).toBe("configured-claude");
        return "/resolved/claude";
      },
      inspectExecutable: async (path) => `test:${path}`,
      readAuthStatus: async (binary) => {
        authReads += 1;
        expect(binary).toBe("/resolved/claude");
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });

    const [first, concurrent] = await Promise.all([probe.read(), probe.read()]);
    expect(first).toEqual(concurrent);
    expect({ resolutions, authReads }).toEqual({ resolutions: 1, authReads: 1 });

    now = 5_099;
    await probe.read();
    expect({ resolutions, authReads }).toEqual({ resolutions: 1, authReads: 1 });

    now = 5_100;
    await probe.read();
    expect({ resolutions, authReads }).toEqual({ resolutions: 2, authReads: 2 });
  });

  it("single-flights and briefly caches failure without poisoning a later retry", async () => {
    const gate = Promise.withResolvers<void>();
    let now = 100;
    let authReads = 0;
    let fail = true;
    const probe = new ClaudeCodeProbe({
      binaryPath: "claude",
      readVersion: readSupportedClaudeVersion,
      ttlMs: 1_000,
      now: () => now,
      resolveExecutable: async () => "/resolved/claude",
      inspectExecutable: async (path) => `test:${path}`,
      readAuthStatus: async () => {
        authReads += 1;
        await gate.promise;
        if (fail) throw new Error("transient auth probe failure");
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });

    const first = probe.read();
    const concurrent = probe.read();
    gate.resolve();
    await expect(first).rejects.toThrow("transient auth probe failure");
    await expect(concurrent).rejects.toThrow("transient auth probe failure");
    expect(authReads).toBe(1);

    fail = false;
    await expect(probe.read()).rejects.toThrow("transient auth probe failure");
    expect(authReads).toBe(1);

    now = 1_100;
    await expect(probe.read()).resolves.toMatchObject({
      binaryPath: "/resolved/claude",
      authStatus: { loggedIn: true, authMethod: "claude.ai" },
    });
    expect(authReads).toBe(2);
  });

  it("requires the optional SDK before reporting Claude harness availability", async () => {
    let executableReads = 0;
    const sdkError = new Error("install exact owner SDK boundary");
    const probe = new ClaudeCodeProbe({
      loadSdk: async () => {
        throw sdkError;
      },
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => {
        executableReads += 1;
        return "/resolved/claude";
      },
      inspectExecutable: async (path) => `test:${path}`,
      readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
    });

    await expect(probe.read()).rejects.toBe(sdkError);
    expect(executableReads).toBe(0);
  });

  it("retries a repaired pre-import SDK failure after the shared probe cache expires", async () => {
    let now = 0;
    let installed = false;
    let sdkLoads = 0;
    const missing = new Error("SDK install is missing before import");
    const probe = new ClaudeCodeProbe({
      now: () => now,
      readVersion: readSupportedClaudeVersion,
      loadSdk: async () => {
        sdkLoads += 1;
        if (!installed) throw missing;
        return testClaudeAgentSdk;
      },
      resolveExecutable: async () => "/resolved/claude",
      inspectExecutable: async (path) => `test:${path}`,
      readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
    });

    await expect(probe.read()).rejects.toBe(missing);
    installed = true;
    now = 4_999;
    await expect(probe.read()).rejects.toBe(missing);
    expect(sdkLoads).toBe(1);

    now = 5_000;
    await expect(probe.read()).resolves.toMatchObject({
      binaryPath: "/resolved/claude",
      authStatus: { loggedIn: true, authMethod: "claude.ai" },
    });
    expect(sdkLoads).toBe(2);
  });

  it("never returns or retains a successful probe from before invalidation", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "claude",
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => "/resolved/claude",
      inspectExecutable: async (path) => `test:${path}`,
      readAuthStatus: async () => {
        authReads += 1;
        if (authReads === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          return { loggedIn: true, authMethod: "claude.ai" };
        }
        return { loggedIn: false };
      },
    });

    const stale = probe.read();
    await firstStarted.promise;
    probe.invalidate();
    const current = await probe.read();
    expect(current.authStatus.loggedIn).toBe(false);

    releaseFirst.resolve();
    expect((await stale).authStatus.loggedIn).toBe(false);
    expect((await probe.read()).authStatus.loggedIn).toBe(false);
    expect(authReads).toBe(2);
  });

  it("rejects a cache lifetime outside the short bounded range", () => {
    expect(() => new ClaudeCodeProbe({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => new ClaudeCodeProbe({ ttlMs: 30_001 })).toThrow(RangeError);
  });
});

describe("Claude session sidecar confinement", () => {
  it("accepts the exact byte boundary and rejects oversized, linked, and special files", async () => {
    temp = makeTempGhosts();
    const fixtureDir = join(temp.root, "claude-sidecar-reader");
    mkdirSync(fixtureDir);

    const exact = join(fixtureDir, "exact.json");
    writeFileSync(exact, Buffer.alloc(CLAUDE_SESSION_METADATA_MAX_BYTES, 0x78), {
      mode: 0o600,
    });
    await expect(readClaudeSessionMetadataFile(exact)).resolves.toHaveLength(
      CLAUDE_SESSION_METADATA_MAX_BYTES,
    );

    const oversized = join(fixtureDir, "oversized.json");
    writeFileSync(oversized, Buffer.alloc(CLAUDE_SESSION_METADATA_MAX_BYTES + 1, 0x78), {
      mode: 0o600,
    });
    await expect(readClaudeSessionMetadataFile(oversized))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const wrongMode = join(fixtureDir, "wrong-mode.json");
    writeFileSync(wrongMode, "{}", { mode: 0o600 });
    chmodSync(wrongMode, 0o640);
    await expect(readClaudeSessionMetadataFile(wrongMode))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const invalidUtf8 = join(fixtureDir, "invalid-utf8.json");
    writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    await expect(readClaudeSessionMetadataFile(invalidUtf8))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const symlink = join(fixtureDir, "symlink.json");
    symlinkSync(exact, symlink);
    await expect(readClaudeSessionMetadataFile(symlink))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const hardLinkSource = join(fixtureDir, "hard-link-source.json");
    const hardLink = join(fixtureDir, "hard-link.json");
    writeFileSync(hardLinkSource, "{}", { mode: 0o600 });
    linkSync(hardLinkSource, hardLink);
    await expect(readClaudeSessionMetadataFile(hardLink))
      .rejects.toMatchObject({ code: "claude_session_invalid" });

    const fifo = join(fixtureDir, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);
    await expect(readClaudeSessionMetadataFile(fifo))
      .rejects.toMatchObject({ code: "claude_session_invalid" });
  });

  it("rejects descriptor-time mutation and pathname replacement", async () => {
    temp = makeTempGhosts();
    const fixtureDir = join(temp.root, "claude-sidecar-races");
    mkdirSync(fixtureDir);

    const mutated = join(fixtureDir, "mutated.json");
    writeFileSync(mutated, "pinned", { mode: 0o600 });
    await expect(readClaudeSessionMetadataFile(mutated, (path) => {
      writeFileSync(path, "changed-size", { mode: 0o600 });
    })).rejects.toMatchObject({ code: "claude_session_invalid" });

    const swapped = join(fixtureDir, "swapped.json");
    const displaced = join(fixtureDir, "displaced.json");
    writeFileSync(swapped, "pinned", { mode: 0o600 });
    await expect(readClaudeSessionMetadataFile(swapped, (path) => {
      renameSync(path, displaced);
      writeFileSync(path, "pinned", { mode: 0o600 });
    })).rejects.toMatchObject({ code: "claude_session_invalid" });
  });
});

describe("Claude Code native harness runtime", () => {
  it("exposes only the resource snapshot of a live warm query", async () => {
    setupClaudeHost({
      machineSkill: {
        name: "obsidian-cli",
        description: "Use the official Obsidian CLI.",
        body: "Use obsidian for shared notes.",
      },
    });
    const conversationId = "resource-snapshot";

    await expect(host!.admittedResources("casper", conversationId, "claude-code"))
      .rejects.toMatchObject({ code: "session_resources_unavailable", status: 409 });
    await host!.runTurn("casper", {
      sessionId: conversationId,
      prompt: "Start the native session.",
      emit: () => {},
    });

    expect(await host!.admittedResources("casper", conversationId, "claude-code"))
      .toMatchObject({
        runtime: "claude-code",
        obsidian: {
          path: join(temp!.ownerHome, ".agents", "skills", "obsidian-cli", "SKILL.md"),
          status: "admitted",
        },
        skills: [expect.objectContaining({
          name: "obsidian-cli",
          source: "machine",
          status: "admitted",
        })],
      });

    await host!.close("casper", conversationId);
    await expect(host!.admittedResources("casper", conversationId, "claude-code"))
      .rejects.toMatchObject({ code: "session_resources_unavailable", status: 409 });
  });

  it("keeps wrapper-injected credentials beyond Ghost while using it for every CLI path", async () => {
    const wrapperRoot = mkdtempSync(join(tmpdir(), "ghost-owner-claude-wrapper-"));
    const wrapper = join(wrapperRoot, "claude-wrapper");
    const native = join(wrapperRoot, "claude-native");
    const invocationLog = join(wrapperRoot, "invocations");
    const childObservation = join(wrapperRoot, "native-child-observation");
    const sentinel = "wrapper-post-launch-secret-sentinel";
    const logger = recordingLogger();
    try {
      writeFileSync(
        wrapper,
        `#!/bin/sh
printf '%s\\n' "$*" >> '${invocationLog}'
export CLAUDE_WRAPPER_SENTINEL='${sentinel}'
exec '${native}' "$@"
`,
        { mode: 0o700 },
      );
      writeFileSync(
        native,
        `#!/bin/sh
test "$CLAUDE_WRAPPER_SENTINEL" = '${sentinel}' || exit 19
if [ "$1" = --version ]; then
  printf '%s\\n' '${CLAUDE_CODE_MINIMUM_VERSION} (Claude Code)'
elif [ "$1" = --fake-native-child ]; then
  printf '%s' "$CLAUDE_WRAPPER_SENTINEL" > '${childObservation}'
else
  printf '%s\\n' '{"loggedIn":true,"authMethod":"future_native_sso","email":"owner@example.invalid"}'
fi
`,
        { mode: 0o700 },
      );
      const environment = {
        HOME: wrapperRoot,
        PATH: "/usr/bin",
        CLAUDE_WRAPPER_SENTINEL: "ambient-value-must-not-cross",
        ANTHROPIC_API_KEY: "ambient-api-key-must-not-cross",
      } satisfies NodeJS.ProcessEnv;
      const probe = new ClaudeCodeProbe({ binaryPath: wrapper, environment });
      const { paths, seenOptions } = setupClaudeHost({
        environment,
        probe,
        logger,
        createQuery: (input, lifecycle) => {
          execFileSync(
            input.options.pathToClaudeCodeExecutable!,
            ["--fake-native-child"],
            { env: input.options.env },
          );
          const sessionId = input.options.sessionId ?? input.options.resume;
          if (!sessionId) throw new Error("test query received no session id");
          return fakeQuery(
            responseMessages(sessionId, "wrapper child completed"),
            lifecycle,
            input.prompt,
          );
        },
      });
      const events: PiMessagesEvent[] = [];
      const turn = (prompt: string) => host!.runTurn("casper", {
        sessionId: "owner-wrapper-boundary",
        prompt,
        emit: (event) => events.push(event),
      });

      await turn("first cold turn");
      await turn("warm turn");
      await host!.close("casper", "owner-wrapper-boundary");
      await turn("second cold turn");

      expect(readFileSync(childObservation, "utf8")).toBe(sentinel);
      const invocations = readFileSync(invocationLog, "utf8").trim().split("\n");
      expect(invocations.filter((args) => args === "--version")).toHaveLength(3);
      expect(invocations.filter((args) => args.endsWith("auth status --json"))).toHaveLength(3);
      expect(invocations.filter((args) => args === "--fake-native-child")).toHaveLength(2);
      expect(seenOptions).toHaveLength(2);
      for (const options of seenOptions) {
        expect(options.pathToClaudeCodeExecutable).toBe(wrapper);
        expect(options.env?.CLAUDE_WRAPPER_SENTINEL).toBeUndefined();
        expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
      }
      const publicProbeMetadata = await probe.read();
      const modelApiPayload = await new ModelCatalog({
        registry: temp!.registry,
        offline: true,
        createRuntime: async () => makeFakeCatalogRuntime({ models: [], credentialed: [] }),
        claudeCodeProbe: probe,
      }).listModels("casper", { provider: "claude-code" });
      for (const observable of [
        JSON.stringify(events),
        JSON.stringify(logger.records),
        JSON.stringify(publicProbeMetadata),
        JSON.stringify(modelApiPayload),
        readFileSync(claudeSessionMetadataPath(
          paths.sessionDir,
          "owner-wrapper-boundary",
        ), "utf8"),
      ]) {
        expect(observable).not.toContain(sentinel);
      }
      expect(filesystemTreeContains(paths.home, sentinel)).toBe(false);
    } finally {
      rmSync(wrapperRoot, { recursive: true, force: true });
    }
  });

  it("passes only reviewed non-secret Claude selectors into SDK queries", async () => {
    const secret = "native-claude-secret-sentinel";
    const logger = recordingLogger();
    let probeEnvironment: Readonly<NodeJS.ProcessEnv> | undefined;
    const environment = {
      HOME: "/home/owner",
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: secret,
      ANTHROPIC_BASE_URL: "https://router.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_ACCESS_KEY_ID: "native-aws-id",
      AWS_SECRET_ACCESS_KEY: "native-aws-secret",
      AWS_SESSION_TOKEN: "native-aws-session",
      AWS_PROFILE: "owner-bedrock",
      AWS_SHARED_CREDENTIALS_FILE: "/home/owner/.aws/credentials",
      OPENAI_API_KEY: "unrelated-openai-secret",
      GHOSTD_API_TOKEN: "ghost-private-token",
      PI_CONFIG_FILES: "/tmp/pi-injection",
      NODE_OPTIONS: "--require=/tmp/runtime-injection.cjs",
      CLAUDE_CODE_PROCESS_WRAPPER: "/tmp/claude-injection",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
    } satisfies NodeJS.ProcessEnv;
    const { paths, seenOptions } = setupClaudeHost({
      environment,
      logger,
      readAuthStatus: async (_binaryPath, captured) => {
        probeEnvironment = captured;
        return {
          loggedIn: true,
          authMethod: "api_key",
          accountFingerprint: STABLE_TEST_ACCOUNT,
        };
      },
    });

    await host!.runTurn("casper", {
      sessionId: "native-auth-query",
      prompt: "Use the installed Claude harness.",
      emit: () => {},
    });

    const queryEnv = seenOptions[0]?.env;
    expect(queryEnv).toBe(probeEnvironment);
    expect(queryEnv).toMatchObject({
      ANTHROPIC_BASE_URL: "https://router.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "owner-bedrock",
      AWS_SHARED_CREDENTIALS_FILE: "/home/owner/.aws/credentials",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: "ghostd/0.0.1",
    });
    for (const name of [
      "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "OPENAI_API_KEY",
      "GHOSTD_API_TOKEN",
      "PI_CONFIG_FILES",
      "NODE_OPTIONS",
      "CLAUDE_CODE_PROCESS_WRAPPER",
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
    ]) {
      expect(queryEnv?.[name]).toBeUndefined();
    }
    expect(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "native-auth-query"),
      "utf8",
    )).not.toContain(secret);
    expect(seenOptions[0]).toMatchObject({
      settingSources: [],
      skills: [],
      plugins: [],
      strictMcpConfig: true,
    });
    expect(Object.keys(seenOptions[0]?.mcpServers ?? {})).toEqual(["ghost"]);

    // A warm turn reuses the same query. Explicit close then makes the next
    // turn cold, but both launches retain the one daemon-start snapshot.
    await host!.runTurn("casper", {
      sessionId: "native-auth-query",
      prompt: "Continue warm.",
      emit: () => {},
    });
    expect(seenOptions).toHaveLength(1);
    await host!.close("casper", "native-auth-query");
    await host!.runTurn("casper", {
      sessionId: "native-auth-query",
      prompt: "Resume cold.",
      emit: () => {},
    });
    expect(seenOptions).toHaveLength(2);
    expect(seenOptions[1]?.env).toBe(seenOptions[0]?.env);
    expect(JSON.stringify(logger.records)).not.toContain(secret);
    expect(JSON.stringify(logger.records)).not.toContain("native-aws-secret");
  });

  it("returns image blocks from screen and browser screenshots across the tool bridge", async () => {
    const { paths } = setupClaudeHost();
    vi.stubEnv("OMARCHY_SCREENSHOT_DIR", join(temp!.root, "screenshots"));
    let browserPage: { url: string; title: string } | undefined;
    const resolver = vi.fn(async (hostname: string) => {
      expect(hostname).toBe("example.com");
      return [{ address: "1.1.1.1", family: 4 }] as const;
    });
    const browser = {
      name: "claude-bridge-test",
      current: async () => browserPage,
      open: async (url: string) => {
        browserPage = { url, title: "Bridge fixture" };
        return browserPage;
      },
      screenshot: async () => ({
        ...(browserPage ?? { url: "about:blank", title: "" }),
        bytes: Buffer.from(TINY_PNG_BASE64, "base64"),
      }),
      close: async () => {
        browserPage = undefined;
        return true;
      },
    } as never;
    const helper = {
      hello: async () => ({}),
      capabilities: async () => ({}),
      request: async () => ({
        png_base64: TINY_PNG_BASE64,
        width: 1,
        height: 1,
        backend: "bridge-fixture",
        background_safe: true,
      }),
      dispose: async () => {},
    } as never;
    const screenExtension = createScreenExtension({
      home: paths.home,
      helper,
      capabilities: CLAUDE_CODE_TOOL_CAPABILITIES,
    });
    const browserExtension = createBrowserExtension({
      home: paths.home,
      backend: () => browser,
      browser: { idleTimeoutMs: 0, resolver },
      capabilities: CLAUDE_CODE_TOOL_CAPABILITIES,
    });
    const tools = await bridgeClaudeCodeTools({
      ghost: async (api) => {
        await screenExtension(api);
        await browserExtension(api);
      },
      toolNames: [GHOST_SCREEN, GHOST_BROWSER],
    }, paths.home, testClaudeAgentSdk);
    const call = async (name: string, args: Record<string, unknown>) => {
      const definition = tools.find((candidate) => candidate.name === name);
      if (!definition) throw new Error(`Missing bridged tool ${name}`);
      return definition.handler(args as never, {});
    };

    const screen = await call(GHOST_SCREEN, { prompt: "What is visible?" });
    const opened = await call(GHOST_BROWSER, { action: "open", url: "https://example.com" });
    // The session verifies both before and after navigation to close DNS
    // rebinding; both checks stay on this injected, offline resolver.
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(opened.content).toContainEqual({
      type: "text",
      text: "Opened https://example.com/\nBridge fixture",
    });
    expect(browserPage).toEqual({ url: "https://example.com/", title: "Bridge fixture" });
    const browserShot = await call(GHOST_BROWSER, { action: "screenshot" });
    await call(GHOST_BROWSER, { action: "close" });

    expect(screen.content).toContainEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
    expect(browserShot.content).toContainEqual({
      type: "image",
      data: TINY_PNG_BASE64,
      mimeType: "image/png",
    });
  });

  it("expires an idle Claude session and rebuilds its persona on cold resume", async () => {
    const { paths, seenOptions, lifecycle } = setupClaudeHost({ warmIdleTtlMs: 20 });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "conversation-idle",
      prompt,
      emit: () => {},
    });

    await turn("first");
    expect(lifecycle.queries).toBe(1);
    expect(lifecycle.closed).toBe(0);

    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    writeFileSync(
      join(paths.home, "memory", "idle-session-memory.md"),
      "The owner expects idle sessions to refresh.\n",
      "utf8",
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lifecycle.closed).toBe(1);

    // Cold again: a second query that resumes the id the sidecar kept.
    await turn("after the idle timeout");
    expect(lifecycle.queries).toBe(2);
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-idle");
    expect(seenOptions[1]?.resume).toBe(
      (JSON.parse(readFileSync(sidecar, "utf8")) as { sessionId: string }).sessionId,
    );
    const resumedPrompt = JSON.stringify(seenOptions[1]?.systemPrompt);
    expect(resumedPrompt).toContain("bookbinder");
    expect(resumedPrompt).toContain("idle-session-memory");
  });

  it("claims a warm query before async setup can cross its idle deadline", async () => {
    const hooks = new GhostHookRunner();
    const secondHookStarted = Promise.withResolvers<void>();
    const releaseSecondHook = Promise.withResolvers<void>();
    let hookCalls = 0;
    await hooks.register((api) => {
      api.on("before_prompt", async () => {
        hookCalls += 1;
        if (hookCalls !== 2) return;
        secondHookStarted.resolve();
        await releaseSecondHook.promise;
      });
    });
    const { lifecycle } = setupClaudeHost({ hooks, warmIdleTtlMs: 40 });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "conversation-idle-boundary",
      prompt,
      emit: () => {},
    });

    await turn("first");
    const second = turn("claim the warm query");
    await secondHookStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lifecycle).toMatchObject({ queries: 1, closed: 0 });

    releaseSecondHook.resolve();
    await second;
    expect(lifecycle).toMatchObject({ queries: 1, closed: 0 });
  });

  it("expires a persona snapshot after a terminal non-success retires its query", async () => {
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      warmIdleTtlMs: 20,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          state.queries === 1
            ? [errorResultMessage(sessionId, "error_max_turns", 1)]
            : responseMessages(sessionId, "recovered"),
          state,
          input.prompt,
        );
      },
    });
    await host!.runTurn("casper", {
      sessionId: "persona-after-terminal-error",
      prompt: "fail once",
      emit: () => {},
    });
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    await host!.runTurn("casper", {
      sessionId: "persona-after-terminal-error",
      prompt: "retry after idle",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("bookbinder");
  });

  it("expires a persona snapshot after query startup fails", async () => {
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      warmIdleTtlMs: 20,
      createQuery: (input, state) => {
        if (state.queries === 1) throw new Error("simulated startup failure");
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(responseMessages(sessionId, "recovered"), state, input.prompt);
      },
    });
    await host!.runTurn("casper", {
      sessionId: "persona-after-startup-failure",
      prompt: "fail to start",
      emit: () => {},
    });
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    await host!.runTurn("casper", {
      sessionId: "persona-after-startup-failure",
      prompt: "retry after idle",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("bookbinder");
  });

  it("expires a persona snapshot after cancellation retires its query", async () => {
    const firstPrompt = Promise.withResolvers<void>();
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      warmIdleTtlMs: 20,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return state.queries === 1
          ? fakeQuery([], state, input.prompt, () => firstPrompt.resolve())
          : fakeQuery(responseMessages(sessionId, "recovered"), state, input.prompt);
      },
    });
    const controller = new AbortController();
    const first = host!.runTurn("casper", {
      sessionId: "persona-after-cancellation",
      prompt: "wait for cancellation",
      signal: controller.signal,
      emit: () => {},
    });
    await firstPrompt.promise;
    controller.abort();
    await first;
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    await host!.runTurn("casper", {
      sessionId: "persona-after-cancellation",
      prompt: "retry after idle",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("bookbinder");
  });

  it("retires a warm query whose persona changed rather than answering under a stale one", async () => {
    const { paths, seenOptions, lifecycle } = setupClaudeHost();
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "conversation-restart",
      prompt,
      emit: () => {},
    });

    await turn("first");
    expect(lifecycle.queries).toBe(1);

    // The character file is part of the prompt the query was built from, and
    // the SDK cannot be told about the change, so the process must go.
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );
    await host!.close("casper", "conversation-restart");

    await turn("second");
    expect(lifecycle.queries).toBe(2);
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("bookbinder");
  });

  it("derives the persona once per conversation, and again for a new one", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const runTurn = (sessionId: string) => host!.runTurn("casper", {
      sessionId,
      prompt: "Who are you?",
      emit: () => {},
    });
    const append = (position: number): string =>
      JSON.stringify(seenOptions[position]?.systemPrompt);

    await runTurn("conversation-1");
    expect(append(0)).not.toContain("written-between-turns");
    writeFileSync(
      join(paths.home, "memory", "written-between-turns.md"),
      "A fact the ghost learned mid-conversation.\n",
      "utf8",
    );

    // The memory index is session-start state. It is on disk, where the native
    // file tools read it; it does not rewrite a prompt prefix already read.
    await runTurn("conversation-1");
    // The turn rode the warm query, so it was answered under the very prompt
    // the session started with — there is no second set of startup options.
    expect(seenOptions).toHaveLength(1);

    // A conversation that starts after the write derives it fresh.
    await runTurn("conversation-2");
    expect(append(1)).toContain("written-between-turns");
  });

  it("shares the owner Obsidian contract while keeping two ghosts' memories private", async () => {
    const { paths, seenOptions } = setupClaudeHost({
      machineSkill: {
        name: "obsidian-cli",
        description: "Official Obsidian CLI skill.",
        body: "Use obsidian.",
      },
    });
    writeFileSync(
      join(paths.home, "memory", "casper-private.md"),
      "Casper keeps this private.\n",
      "utf8",
    );
    const minaDir = seedGhost(temp!.root, {
      name: "mina",
      character: "# Mina\n\nYou are Mina, a beekeeper.\n",
      memory: { "mina-private.md": "Mina keeps this private.\n" },
    });
    const minaPaths = ghostPaths(minaDir);
    mkdirSync(minaPaths.agentDir, { recursive: true });
    setGhostModelRole(minaPaths.home, "chat_model", "claude-code", "default");

    await host!.runTurn("casper", {
      sessionId: "casper-obsidian-boundary",
      prompt: "What state can you use?",
      emit: () => {},
    });
    await host!.runTurn("mina", {
      sessionId: "mina-obsidian-boundary",
      prompt: "What state can you use?",
      emit: () => {},
    });

    expect(seenOptions).toHaveLength(2);
    const prompts = seenOptions.map(({ systemPrompt }) => JSON.stringify(systemPrompt));
    const casperPrompt = prompts[0] ?? "";
    const minaPrompt = prompts[1] ?? "";
    const sharedSkill = join(
      temp!.ownerHome,
      ".agents",
      "skills",
      "obsidian-cli",
      "SKILL.md",
    );
    for (const prompt of [casperPrompt, minaPrompt]) {
      expect(prompt).toContain("## Owner context");
      expect(prompt).toContain("## Self-maintenance");
      expect(prompt).toContain(sharedSkill);
      expect(prompt).toContain("A vault is a folder of Markdown");
      expect(prompt.split(sharedSkill)).toHaveLength(2);
    }
    expect(casperPrompt).toContain("casper-private");
    expect(casperPrompt).not.toContain("mina-private");
    expect(minaPrompt).toContain("mina-private");
    expect(minaPrompt).not.toContain("casper-private");
  });

  it("routes an explicit claude-code role through the isolated SDK harness and resumes it", async () => {
    const { paths, scheduleUnitDir, seenOptions, lifecycle } = setupClaudeHost();
    mkdirSync(join(paths.home, "docs"), { recursive: true });
    writeFileSync(join(paths.home, "docs", "legacy.md"), "# Legacy home doc\n");
    const first: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "Who are you?",
      emit: (event) => first.push(event),
    });
    expect(first.at(-1)?.type).toBe("done");
    expect(first.some((event) => event.type === "text_delta"
      && event.delta.includes("plan"))).toBe(true);
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]).toMatchObject({
      cwd: temp!.ownerHome,
      tools: { type: "preset", preset: "claude_code" },
      skills: [],
      plugins: [],
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
      persistSession: true,
    });
    expect(seenOptions[0]?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(seenOptions[0]?.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(seenOptions[0]).not.toHaveProperty("disallowedTools");
    const permissionInput = { command: "printf owner-approved" };
    await expect(seenOptions[0]?.canUseTool?.("Bash", permissionInput, {
      signal: new AbortController().signal,
      toolUseID: "permission-test",
    })).resolves.toEqual({ behavior: "allow" });
    expect(permissionInput).toEqual({ command: "printf owner-approved" });

    const askInput = {
      questions: [{
        header: "Finish",
        question: "Which finish should I use?",
        options: [
          {
            label: "Matte",
            description: "Quiet and low-glare",
            preview: "Matte preview",
          },
          { label: "Gloss", description: "Brighter and reflective" },
        ],
        multiSelect: false,
      }],
    };
    const askPermission = seenOptions[0]?.canUseTool?.("AskUserQuestion", askInput, {
      signal: new AbortController().signal,
      toolUseID: "ask-permission-test",
    });
    const pendingAsk = host!.pendingAsk("casper", "conversation-1", "claude-code");
    if (!pendingAsk) throw new Error("Claude's permission callback did not publish its question.");
    expect(pendingAsk.questions).toEqual([expect.objectContaining({
      id: "question-1",
      question: "Which finish should I use?",
      multi: false,
    })]);
    host!.answerAsk("casper", "conversation-1", pendingAsk.id, {
      kind: "submit",
      results: [{
        id: "question-1",
        selectedOptions: ["Matte"],
        note: "Use recycled stock",
      }],
    }, "claude-code");
    await expect(askPermission).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        ...askInput,
        answers: { "Which finish should I use?": "Matte" },
        annotations: {
          "Which finish should I use?": {
            preview: "Matte preview",
            notes: "Use recycled stock",
          },
        },
      },
    });
    expect(host!.pendingAsk("casper", "conversation-1", "claude-code")).toBeNull();

    await expect(seenOptions[0]?.canUseTool?.("AskUserQuestion", { questions: [] }, {
      signal: new AbortController().signal,
      toolUseID: "malformed-ask-permission-test",
    })).resolves.toEqual({
      behavior: "deny",
      message: expect.stringContaining("malformed"),
    });

    const chatPermission = seenOptions[0]?.canUseTool?.("AskUserQuestion", askInput, {
      signal: new AbortController().signal,
      toolUseID: "chat-ask-permission-test",
    });
    const chatAsk = host!.pendingAsk("casper", "conversation-1", "claude-code");
    if (!chatAsk) throw new Error("Claude's chat redirect did not publish its question.");
    host!.answerAsk("casper", "conversation-1", chatAsk.id, { kind: "chat" }, "claude-code");
    await expect(chatPermission).resolves.toEqual({
      behavior: "deny",
      message: expect.stringContaining("discuss"),
    });

    const cancelPermission = seenOptions[0]?.canUseTool?.("AskUserQuestion", askInput, {
      signal: new AbortController().signal,
      toolUseID: "cancel-ask-permission-test",
    });
    const cancelAsk = host!.pendingAsk("casper", "conversation-1", "claude-code");
    if (!cancelAsk) throw new Error("Claude's cancellable ask did not publish its question.");
    host!.answerAsk("casper", "conversation-1", cancelAsk.id, { kind: "cancel" }, "claude-code");
    await expect(cancelPermission).resolves.toEqual({
      behavior: "deny",
      message: expect.stringContaining("dismissed"),
    });
    const systemPrompt = seenOptions[0]?.systemPrompt;
    expect(systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      append: expect.stringContaining("letterpress printer"),
    });
    if (
      typeof systemPrompt !== "object"
      || systemPrompt === null
      || !("append" in systemPrompt)
      || typeof systemPrompt.append !== "string"
    ) throw new Error("Claude Code did not receive Ghost's appended persona.");
    const appended = systemPrompt.append;
    expect(appended).toContain("## Owner context");
    expect(appended).toContain("## Self-maintenance");
    expect(appended).not.toContain(".agents/skills/obsidian-cli/SKILL.md");
    expect(appended).toContain("A vault is a folder of Markdown");
    expect(appended).toContain("Nothing there is indexed for you");
    expect(appended).toContain(scheduleUnitDir);
    expect(appended).toContain("ghost-timer-v1-6-casper-<slug>");
    expect(appended).not.toContain("~/.config/systemd/user");
    expect(appended).not.toContain("legacy.md");
    expect(seenOptions[0]?.allowedTools).toContain("mcp__ghost__ghost_browser");
    // The query stays warm between turns, so nothing is closed yet.
    expect(lifecycle.closed).toBe(0);
    const sessionId = seenOptions[0]?.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-1");
    const firstStored = JSON.parse(readFileSync(sidecar, "utf8")) as {
      created: string;
      modified: string;
    };
    expect(new Date(firstStored.created).toISOString()).toBe(firstStored.created);
    expect(new Date(firstStored.modified).toISOString()).toBe(firstStored.modified);

    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "And now?",
      emit: () => {},
    });
    // Turn two rides the same live process: no second query, no resume, and
    // Claude's transcript and MCP servers were never torn down.
    expect(seenOptions).toHaveLength(1);
    expect(lifecycle.queries).toBe(1);
    expect(lifecycle.closed).toBe(0);

    const sessions = await host!.listSessions("casper");
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "claude-code:conversation-1",
        conversationId: "conversation-1",
        runtime: "claude-code",
        title: "Claude Code",
        messageCount: 4,
      }),
    ]);
    const stored = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(stored.created).toBe(firstStored.created);
    expect(new Date(stored.created).toISOString()).toBe(stored.created);
    expect(new Date(stored.modified).toISOString()).toBe(stored.modified);
    expect(stored).toMatchObject({
      version: 3,
      cwd: temp!.ownerHome,
      projectSnapshot: {
        root: null,
        declarative: {
          instructions: [],
          skills: [],
          rules: [],
          prompts: [],
          commands: [],
        },
        mcpServers: {},
        resourceWarnings: [],
        mcpWarnings: [],
      },
    });
  });

  it("injects only always-active Ghost instructions while unbound", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    mkdirSync(join(paths.home, "skills", "unbound"), { recursive: true });
    mkdirSync(join(paths.home, "rules"), { recursive: true });
    mkdirSync(join(paths.home, "prompts"), { recursive: true });
    mkdirSync(join(paths.home, "commands"), { recursive: true });
    mkdirSync(join(paths.home, "agents"), { recursive: true });
    mkdirSync(join(paths.home, ".omp", "skills", "hidden"), { recursive: true });
    writeFileSync(join(paths.home, "AGENTS.md"), "UNBOUND-GHOST-INSTRUCTION");
    writeFileSync(
      join(paths.home, "skills", "unbound", "SKILL.md"),
      "---\nname: unbound\ndescription: visible unbound skill\n---\n\nUNBOUND-GHOST-SKILL\n",
    );
    writeFileSync(join(paths.home, "rules", "unbound.md"), "UNBOUND-GHOST-RULE");
    writeFileSync(join(paths.home, "prompts", "unbound.md"), "UNBOUND-GHOST-PROMPT");
    writeFileSync(join(paths.home, "commands", "unbound.md"), "UNBOUND-GHOST-COMMAND");
    writeFileSync(join(paths.home, "agents", "inactive.md"), "UNBOUND-INACTIVE-AGENT");
    writeFileSync(
      join(paths.home, ".omp", "skills", "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: hidden provider\n---\n\nUNBOUND-HIDDEN-SKILL\n",
    );

    await host!.runTurn("casper", {
      sessionId: "unbound-declarative",
      prompt: "use the Ghost resources",
      emit: () => {},
    });

    const append = JSON.stringify(seenOptions[0]?.systemPrompt);
    expect(append).toContain("UNBOUND-GHOST-INSTRUCTION");
    expect(append).toContain("unbound: visible unbound skill");
    expect(append).toContain(join(paths.home, "skills", "unbound", "SKILL.md"));
    expect(append).not.toContain("UNBOUND-GHOST-SKILL");
    expect(append).not.toContain("UNBOUND-GHOST-RULE");
    expect(append).not.toContain("UNBOUND-GHOST-PROMPT");
    expect(append).not.toContain("UNBOUND-GHOST-COMMAND");
    expect(append).not.toContain("UNBOUND-INACTIVE-AGENT");
    expect(append).not.toContain("UNBOUND-HIDDEN-SKILL");
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "unbound-declarative"),
      "utf8",
    ))).toMatchObject({
      projectSnapshot: {
        root: null,
        declarative: {
          instructions: [],
          skills: [],
          rules: [],
          prompts: [],
          commands: [],
        },
      },
    });
  });

  it("indexes ambient machine skills and applies Omarchy CLI-first policy without SDK discovery", async () => {
    const { seenOptions } = setupClaudeHost({
      machineSkill: {
        name: "omarchy",
        description: "Control an Omarchy desktop through its CLI.",
        body: "MACHINE-SKILL-BODY",
      },
    });

    await host!.runTurn("casper", {
      sessionId: "machine-skill-index",
      prompt: "change a desktop setting",
      emit: () => {},
    });

    const append = JSON.stringify(seenOptions[0]?.systemPrompt);
    expect(append).toContain("omarchy: Control an Omarchy desktop through its CLI.");
    expect(append).toContain("omarchy commands --json");
    expect(append).toContain("ghost_desktop");
    expect(append).not.toContain("MACHINE-SKILL-BODY");
    expect(seenOptions[0]?.skills).toEqual([]);
    expect(seenOptions[0]?.settingSources).toEqual([]);
  });

  it("pins a trusted project before the first turn and injects only its declarative resources", async () => {
    const { seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-bound");
    const projectCwd = join(project, "work");
    const approvedSkill = join(project, ".omp", "skills", "approved");
    mkdirSync(approvedSkill, { recursive: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    mkdirSync(projectCwd);
    writeFileSync(join(project, "AGENTS.md"), "Always say PROJECT-SNAPSHOT.");
    writeFileSync(
      join(approvedSkill, "SKILL.md"),
      "---\nname: approved\ndescription: approved\n---\n\nALWAYS-ACTIVE-SKILL-SNAPSHOT\n",
    );
    writeFileSync(
      join(project, ".omp", "rules", "typed-rule.md"),
      "---\nalwaysApply: true\n---\n\nTYPED-RULE-SNAPSHOT\n",
    );
    const hostile = join(temp!.root, "hostile-claude-resources");
    mkdirSync(hostile);
    writeFileSync(join(hostile, "SKILL.md"), "HOSTILE-SYMLINK-SKILL");
    symlinkSync(hostile, join(project, ".omp", "skills", "escaped"));
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        project_fixture: { type: "stdio", command: process.execPath, args: ["--version"] },
        explicit_cwd: {
          type: "stdio",
          command: process.execPath,
          args: ["--version"],
          cwd: "work",
        },
      },
    }));
    const preview = await host!.previewProject(
      "casper",
      "bound-project",
      "claude-code",
      project,
    );
    expect(preview.resources.rules).toBe(1);
    await host!.bindProject("casper", "bound-project", "claude-code", {
      root: project,
      cwd: projectCwd,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "bound-project",
      prompt: "use the project",
      emit: () => {},
    });
    expect(seenOptions[0]).toMatchObject({
      cwd: projectCwd,
      skills: [],
      settingSources: [],
      mcpServers: {
        project_fixture: { type: "stdio", command: process.execPath },
        ghost: expect.any(Object),
      },
      systemPrompt: { append: expect.stringContaining("PROJECT-SNAPSHOT") },
    });
    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("explicit_cwd");
    expect(seenOptions[0]?.mcpServers?.project_fixture).not.toHaveProperty("cwd");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).not.toContain("ALWAYS-ACTIVE-SKILL-SNAPSHOT");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).toContain("approved: approved");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).toContain("TYPED-RULE-SNAPSHOT");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).not.toContain("HOSTILE-SYMLINK-SKILL");
    writeFileSync(join(project, "AGENTS.md"), "MUTATED-AFTER-FIRST-TURN");
    writeFileSync(join(project, ".omp", "rules", "typed-rule.md"), "MUTATED-LIVE-RULE");
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { replacement: { type: "stdio", command: "never-run" } },
    }));
    // The point of this turn is that a cold start rebuilds from the stored
    // project bytes rather than reopening the project, so retire the warm
    // query first; a warm turn would never look at the mutated files at all.
    await host!.close("casper", "bound-project");
    await host!.runTurn("casper", {
      sessionId: "bound-project",
      prompt: "resume without rereading",
      emit: () => {},
    });
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("PROJECT-SNAPSHOT");
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).toContain("TYPED-RULE-SNAPSHOT");
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).not.toContain("MUTATED-AFTER-FIRST-TURN");
    expect(JSON.stringify(seenOptions[1]?.systemPrompt)).not.toContain("MUTATED-LIVE-RULE");
    expect(seenOptions[1]?.mcpServers).toMatchObject({
      project_fixture: { type: "stdio", command: process.execPath },
      ghost: expect.any(Object),
    });
    expect(seenOptions[1]?.mcpServers).not.toHaveProperty("replacement");
    const persisted = JSON.parse(readFileSync(
      claudeSessionMetadataPath(ghostPaths(temp!.registry.get("casper").dir).sessionDir, "bound-project"),
      "utf8",
    ));
    expect(persisted).toMatchObject({
      version: 3,
      projectSnapshot: {
        root: project,
        declarative: {
          instructions: [expect.objectContaining({ content: "Always say PROJECT-SNAPSHOT." })],
          skills: [expect.objectContaining({ content: expect.stringContaining("ALWAYS-ACTIVE") })],
          rules: [expect.objectContaining({ content: "TYPED-RULE-SNAPSHOT" })],
        },
        mcpServers: { project_fixture: { command: process.execPath } },
        mcpWarnings: expect.arrayContaining([
          "explicit_cwd: row rejected because Claude project MCP does not support an explicit cwd.",
        ]),
      },
    });
    await host!.disposeAll();
    const restartedOptions: ClaudeQueryOptions[] = [];
    const restartedLifecycle = { queries: 0, interrupted: 0, closed: 0 };
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      machineSkillPaths: [],
      offline: true,
      claudeCode: {
        loadSdk: async () => testClaudeAgentSdk,
        binaryPath: process.execPath,
        readVersion: readSupportedClaudeVersion,
        readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
        observeQueryExit: observeFakeQueryExit,
        createQuery: (input) => {
          restartedOptions.push(input.options);
          const sessionId = input.options.resume;
          if (!sessionId) throw new Error("restart must resume the persisted Claude id");
          return fakeQuery(responseMessages(sessionId, "restarted"), restartedLifecycle);
        },
      },
    });
    await host.runTurn("casper", {
      sessionId: "bound-project",
      prompt: "resume after daemon restart",
      emit: () => {},
    });
    expect(JSON.stringify(restartedOptions[0]?.systemPrompt)).toContain("PROJECT-SNAPSHOT");
    expect(JSON.stringify(restartedOptions[0]?.systemPrompt)).toContain("TYPED-RULE-SNAPSHOT");
    expect(JSON.stringify(restartedOptions[0]?.systemPrompt)).not.toContain("MUTATED-AFTER-FIRST-TURN");
    expect(JSON.stringify(restartedOptions[0]?.systemPrompt)).not.toContain("MUTATED-LIVE-RULE");
    expect(restartedOptions[0]?.mcpServers).toHaveProperty("project_fixture");
    expect(restartedOptions[0]?.mcpServers).not.toHaveProperty("replacement");
    expect(await host!.getProject("casper", "bound-project", "claude-code"))
      .toMatchObject({ root: project, cwd: projectCwd, canRebind: false });
    await expect(host!.reloadProject("casper", "bound-project", "claude-code", 1))
      .rejects.toMatchObject({ code: "project_rebind_requires_new_conversation" });
  });

  it("preserves inherited-object MCP names through Claude launch, persistence, and resume", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-hostile-mcp-names");
    mkdirSync(join(project, ".omp"), { recursive: true });
    const hostileServers = Object.fromEntries([
      ["__proto__", {
        type: "stdio",
        command: process.execPath,
        args: ["--version"],
        timeout: 1_000,
      }],
      ["constructor", {
        type: "http",
        url: "https://constructor.example.test/mcp",
        timeout: 1_100,
      }],
      ["toString", {
        type: "sse",
        url: "https://tostring.example.test/mcp",
        timeout: 1_200,
      }],
    ]);
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: hostileServers,
    }));
    const preview = await host!.previewProject(
      "casper",
      "hostile-mcp-names",
      "claude-code",
      project,
    );
    expect(preview.resources.mcpServers).toBe(3);
    await host!.bindProject("casper", "hostile-mcp-names", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "hostile-mcp-names",
      prompt: "use every admitted MCP server",
      emit: () => {},
    });

    const launched = seenOptions[0]?.mcpServers as Record<string, unknown>;
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(launched, name)).toBe(true);
    }
    const launchedByName = new Map(Object.entries(launched));
    expect(launchedByName.get("__proto__")).toMatchObject({
      type: "stdio",
      command: process.execPath,
      timeout: 1_000,
    });
    expect(launchedByName.get("constructor")).toMatchObject({
      type: "http",
      url: "https://constructor.example.test/mcp",
      timeout: 1_100,
    });
    expect(launchedByName.get("toString")).toMatchObject({
      type: "sse",
      url: "https://tostring.example.test/mcp",
      timeout: 1_200,
    });
    expect(Object.hasOwn(launched, "ghost")).toBe(true);
    expect(await host!.getProject("casper", "hostile-mcp-names", "claude-code"))
      .toMatchObject({ status: "ready", mcpStatus: "ready" });

    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "hostile-mcp-names");
    const persisted = JSON.parse(readFileSync(sidecar, "utf8")) as {
      projectSnapshot: { mcpServers: Record<string, unknown> };
    };
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(persisted.projectSnapshot.mcpServers, name)).toBe(true);
    }

    await host!.disposeAll();
    const resumedOptions: ClaudeQueryOptions[] = [];
    const resumedLifecycle = { interrupted: 0, closed: 0 };
    host = new SessionHost({
      registry: temp!.registry,
      ownerHome: temp!.ownerHome,
      machineSkillPaths: [],
      offline: true,
      claudeCode: {
        loadSdk: async () => testClaudeAgentSdk,
        binaryPath: process.execPath,
        readVersion: readSupportedClaudeVersion,
        readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
        observeQueryExit: observeFakeQueryExit,
        createQuery: (input) => {
          resumedOptions.push(input.options);
          const sessionId = input.options.resume;
          if (!sessionId) throw new Error("hostile-name fixture must resume its Claude id");
          return fakeQuery(responseMessages(sessionId, "resumed"), resumedLifecycle);
        },
      },
    });
    await host.runTurn("casper", {
      sessionId: "hostile-mcp-names",
      prompt: "resume every admitted MCP server",
      emit: () => {},
    });
    const resumed = resumedOptions[0]?.mcpServers as Record<string, unknown>;
    const resumedByName = new Map(Object.entries(resumed));
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(resumed, name)).toBe(true);
      expect(resumedByName.get(name)).toEqual(launchedByName.get(name));
    }
  });

  it("keeps a project MCP server named ghost distinct from Ghost's internal server", async () => {
    const { paths, seenOptions } = setupClaudeHost({
      createQuery: (input, lifecycle) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("MCP collision fixture received no session id");
        return fakeQuery([
          sdkMessage({
            type: "system",
            subtype: "init",
            session_id: sessionId,
            mcp_servers: [
              { name: "ghost", status: "failed" },
              { name: "ghost-1", status: "connected" },
            ],
          }),
          ...responseMessages(sessionId, "collision-safe"),
        ], lifecycle, input.prompt);
      },
    });
    const project = join(temp!.root, "claude-ghost-mcp-name");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        ghost: {
          type: "stdio",
          command: process.execPath,
          args: ["--version"],
        },
      },
    }));
    const preview = await host!.previewProject(
      "casper",
      "ghost-mcp-name",
      "claude-code",
      project,
    );
    expect(preview.resources.mcpServers).toBe(1);
    expect(preview.warnings).toEqual([]);
    await host!.bindProject("casper", "ghost-mcp-name", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "ghost-mcp-name",
      prompt: "keep both MCP servers distinct",
      emit: () => {},
    });

    const launched = seenOptions[0]?.mcpServers as Record<string, unknown>;
    expect(launched.ghost).toMatchObject({
      type: "stdio",
      command: process.execPath,
      args: ["--version"],
    });
    expect(launched["ghost-1"]).toMatchObject({ type: "sdk", name: "ghost-1" });
    expect(seenOptions[0]?.allowedTools).toContain("mcp__ghost-1__ghost_browser");
    expect(await host!.getProject("casper", "ghost-mcp-name", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
    const persisted = JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "ghost-mcp-name"),
      "utf8",
    )) as { projectSnapshot: { mcpServers: Record<string, unknown> } };
    expect(persisted.projectSnapshot.mcpServers.ghost).toMatchObject({
      type: "stdio",
      command: process.execPath,
    });
  });

  it("keeps Claude MCP counts, health, launch, and persistence on admitted rows only", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const disabledProject = join(temp!.root, "claude-disabled-only-mcp");
    mkdirSync(join(disabledProject, ".omp"), { recursive: true });
    const disabledMcpPath = join(disabledProject, ".omp", ".mcp.json");
    writeFileSync(disabledMcpPath, JSON.stringify({
      mcpServers: {
        disabled_only: {
          enabled: false,
          type: "stdio",
          command: process.execPath,
        },
      },
    }));
    const disabledPreview = await host!.previewProject(
      "casper",
      "disabled-only-mcp",
      "claude-code",
      disabledProject,
    );
    expect(disabledPreview.resources.mcpServers).toBe(0);
    expect(disabledPreview.warnings).toEqual([]);
    const disabledBound = await host!.bindProject(
      "casper",
      "disabled-only-mcp",
      "claude-code",
      {
        root: disabledProject,
        trustToken: disabledPreview.trustToken,
        expectedGeneration: 0,
      },
    );
    expect(disabledBound).toMatchObject({
      resources: { mcpServers: 0 },
      status: "ready",
      mcpStatus: "off",
    });
    await host!.runTurn("casper", {
      sessionId: "disabled-only-mcp",
      prompt: "run without disabled MCP",
      emit: () => {},
    });
    expect(Object.hasOwn(seenOptions[0]?.mcpServers ?? {}, "disabled_only")).toBe(false);
    expect(await host!.getProject("casper", "disabled-only-mcp", "claude-code"))
      .toMatchObject({ status: "ready", mcpStatus: "off" });
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "disabled-only-mcp"),
      "utf8",
    ))).toMatchObject({
      projectSnapshot: {
        mcpServers: {},
        mcpWarnings: [],
        mcpResources: [expect.objectContaining({
          name: "disabled_only",
          path: disabledMcpPath,
          status: "disabled",
        })],
      },
    });
    expect(await host!.admittedResources("casper", "disabled-only-mcp", "claude-code"))
      .toMatchObject({
        mcpServers: [expect.objectContaining({
          name: "disabled_only",
          path: disabledMcpPath,
          enabled: false,
          status: "disabled",
        })],
      });

    const mixedProject = join(temp!.root, "claude-mixed-mcp");
    mkdirSync(join(mixedProject, ".omp"), { recursive: true });
    writeFileSync(join(mixedProject, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        valid_row: {
          type: "stdio",
          command: process.execPath,
          args: ["--version"],
        },
        malformed_row: { type: "stdio", command: 42 },
      },
    }));
    const mixedPreview = await host!.previewProject(
      "casper",
      "mixed-mcp",
      "claude-code",
      mixedProject,
    );
    expect(mixedPreview.resources.mcpServers).toBe(1);
    expect(mixedPreview.warnings).toContainEqual(expect.stringContaining("malformed_row"));
    const mixedBound = await host!.bindProject("casper", "mixed-mcp", "claude-code", {
      root: mixedProject,
      trustToken: mixedPreview.trustToken,
      expectedGeneration: 0,
    });
    expect(mixedBound).toMatchObject({
      resources: { mcpServers: 1 },
      status: "degraded",
      mcpStatus: "degraded",
    });
    await host!.runTurn("casper", {
      sessionId: "mixed-mcp",
      prompt: "run only admitted MCP",
      emit: () => {},
    });
    expect(Object.hasOwn(seenOptions[1]?.mcpServers ?? {}, "valid_row")).toBe(true);
    expect(Object.hasOwn(seenOptions[1]?.mcpServers ?? {}, "malformed_row")).toBe(false);
    const mixedStored = JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "mixed-mcp"),
      "utf8",
    )) as {
      projectSnapshot: {
        mcpServers: Record<string, unknown>;
        mcpWarnings: string[];
        mcpResources: Array<{ name: string; status: string; reason?: string }>;
      };
    };
    expect(Object.hasOwn(mixedStored.projectSnapshot.mcpServers, "valid_row")).toBe(true);
    expect(Object.hasOwn(mixedStored.projectSnapshot.mcpServers, "malformed_row")).toBe(false);
    expect(mixedStored.projectSnapshot.mcpWarnings)
      .toContainEqual(expect.stringContaining("malformed_row"));
    expect(mixedStored.projectSnapshot.mcpResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "valid_row", status: "admitted" }),
      expect.objectContaining({
        name: "malformed_row",
        status: "skipped",
        reason: expect.any(String),
      }),
    ]));
    expect(await host!.getProject("casper", "mixed-mcp", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("keeps an observed project MCP failure degraded across warm owner turns", async () => {
    const { lifecycle } = setupClaudeHost({
      createQuery: (input, queryLifecycle) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("warm MCP fixture received no session id");
        return fakeQuery(
          (turnNumber) => [
            ...(turnNumber === 1
              ? [sdkMessage({
                  type: "system",
                  subtype: "init",
                  session_id: sessionId,
                  mcp_servers: [{ name: "broken", status: "failed" }],
                })]
              : []),
            ...responseMessages(sessionId, `turn ${turnNumber}`),
          ],
          queryLifecycle,
          input.prompt,
        );
      },
    });
    const project = join(temp!.root, "claude-warm-mcp-failure");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        broken: { type: "stdio", command: process.execPath, args: ["--version"] },
      },
    }));
    const preview = await host!.previewProject(
      "casper",
      "warm-mcp-failure",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "warm-mcp-failure", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "warm-mcp-failure",
      prompt: "first turn observes the failed startup",
      emit: () => {},
    });
    expect(await host!.getProject("casper", "warm-mcp-failure", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });

    await host!.runTurn("casper", {
      sessionId: "warm-mcp-failure",
      prompt: "second turn receives no init frame",
      emit: () => {},
    });

    expect(lifecycle.queries).toBe(1);
    expect(await host!.getProject("casper", "warm-mcp-failure", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("uses Pi's instruction merge while keeping invoked resources out of Claude's prompt", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const ghostSkill = join(paths.home, "skills", "shared");
    const retainedSkill = join(paths.home, "skills", "retained");
    mkdirSync(ghostSkill, { recursive: true });
    mkdirSync(retainedSkill, { recursive: true });
    mkdirSync(join(paths.home, "rules"), { recursive: true });
    mkdirSync(join(paths.home, "prompts"), { recursive: true });
    mkdirSync(join(paths.home, "commands"), { recursive: true });
    mkdirSync(join(paths.home, "agents"), { recursive: true });
    writeFileSync(join(paths.home, "AGENTS.md"), "GHOST-VISIBLE-INSTRUCTION");
    writeFileSync(
      join(ghostSkill, "SKILL.md"),
      "---\nname: shared\ndescription: ghost shared\n---\n\nGHOST-SHARED-SKILL\n",
    );
    writeFileSync(
      join(retainedSkill, "SKILL.md"),
      "---\nname: retained\ndescription: retained\n---\n\nGHOST-RETAINED-SKILL\n",
    );
    writeFileSync(join(paths.home, "rules", "shared.md"), "GHOST-SHARED-RULE");
    writeFileSync(join(paths.home, "prompts", "shared.md"), "GHOST-SHARED-PROMPT");
    writeFileSync(join(paths.home, "commands", "shared.md"), "GHOST-SHARED-COMMAND");
    writeFileSync(join(paths.home, "agents", "inactive.md"), "GHOST-INACTIVE-AGENT");

    mkdirSync(join(paths.home, ".claude", "skills", "ambient"), { recursive: true });
    writeFileSync(join(paths.home, ".claude", "CLAUDE.md"), "AMBIENT-GHOST-CLAUDE");
    writeFileSync(
      join(paths.home, ".claude", "skills", "ambient", "SKILL.md"),
      "---\nname: ambient\ndescription: ambient\n---\n\nAMBIENT-GHOST-SKILL\n",
    );

    const project = join(temp!.root, "claude-declarative-parity");
    const projectSkill = join(project, ".omp", "skills", "shared");
    const malformedSkill = join(project, ".omp", "skills", "retained");
    const namelessCollision = join(project, ".claude", "skills", "retained");
    mkdirSync(projectSkill, { recursive: true });
    mkdirSync(malformedSkill, { recursive: true });
    mkdirSync(namelessCollision, { recursive: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    mkdirSync(join(project, ".omp", "prompts"), { recursive: true });
    mkdirSync(join(project, ".omp", "commands"), { recursive: true });
    mkdirSync(join(project, ".omp", "agents"), { recursive: true });
    mkdirSync(join(project, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(project, ".omp", "AGENTS.md"), "PROJECT-PREFERRED-INSTRUCTION");
    writeFileSync(join(project, "AGENTS.md"), "PROJECT-SHADOWED-INSTRUCTION");
    writeFileSync(
      join(projectSkill, "SKILL.md"),
      "---\nname: shared\ndescription: project shared\n---\n\nPROJECT-SHARED-SKILL\n",
    );
    writeFileSync(
      join(malformedSkill, "SKILL.md"),
      "---\nname: [unterminated\n---\n\nPROJECT-MALFORMED-SKILL\n",
    );
    writeFileSync(
      join(namelessCollision, "SKILL.md"),
      "---\ndescription: directory names are not skill names\n---\n\nPROJECT-NAMELESS-COLLISION\n",
    );
    writeFileSync(join(project, ".omp", "rules", "shared.md"), "PROJECT-SHARED-RULE");
    writeFileSync(join(project, ".omp", "prompts", "shared.md"), "PROJECT-SHARED-PROMPT");
    writeFileSync(join(project, ".omp", "commands", "shared.md"), "PROJECT-SHARED-COMMAND");
    writeFileSync(join(project, ".omp", "agents", "inactive.md"), "PROJECT-INACTIVE-AGENT");
    writeFileSync(join(project, ".omp", "extensions", "inactive.ts"), "PROJECT-EXECUTABLE");

    const ghostSnapshot = await loadProjectDeclarativeSnapshot(paths.home, { level: "user" });
    const projectSnapshot = await loadProjectDeclarativeSnapshot(project, { level: "project" });
    const piEffective = declarativePromptSnapshot(mergeProjectDeclarativeSnapshots([
      ghostSnapshot,
      projectSnapshot,
    ]));
    expect(piEffective.instructions.map((entry) => entry.content)).toEqual([
      "GHOST-VISIBLE-INSTRUCTION",
      "PROJECT-PREFERRED-INSTRUCTION",
    ]);
    expect(piEffective.skills.map((entry) => [entry.name, entry.content])).toEqual([
      ["retained", expect.stringContaining("GHOST-RETAINED-SKILL")],
      ["shared", expect.stringContaining("PROJECT-SHARED-SKILL")],
    ]);
    expect(piEffective.rules).toEqual([
      expect.objectContaining({ name: "shared", content: "PROJECT-SHARED-RULE" }),
    ]);
    expect(piEffective.prompts).toEqual([
      expect.objectContaining({ name: "shared", content: "PROJECT-SHARED-PROMPT" }),
    ]);
    expect(piEffective.commands).toEqual([
      expect.objectContaining({ name: "shared", content: "PROJECT-SHARED-COMMAND" }),
    ]);
    expect(projectSnapshot.warnings).toContainEqual(
      expect.stringContaining("skill metadata is invalid"),
    );
    expect(projectSnapshot.warnings).toContainEqual(
      expect.stringContaining("skill name or description is missing"),
    );

    const preview = await host!.previewProject(
      "casper",
      "declarative-parity",
      "claude-code",
      project,
    );
    expect(preview.resources).toMatchObject({
      skills: 1,
      rules: 1,
      prompts: 1,
      commands: 1,
      agents: 1,
      ignoredExecutable: 1,
    });
    await host!.bindProject("casper", "declarative-parity", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    await host!.runTurn("casper", {
      sessionId: "declarative-parity",
      prompt: "use the admitted resources",
      emit: () => {},
    });

    const systemPrompt = seenOptions[0]?.systemPrompt;
    if (typeof systemPrompt !== "object"
      || systemPrompt === null
      || !("append" in systemPrompt)
      || typeof systemPrompt.append !== "string") {
      throw new Error("Claude Code did not receive its declarative prompt append.");
    }
    const append = systemPrompt.append;
    for (const entry of piEffective.instructions) expect(append).toContain(entry.content);
    for (const entry of [
      ...piEffective.skills,
      ...piEffective.rules,
      ...piEffective.prompts,
      ...piEffective.commands,
    ]) expect(append).not.toContain(entry.content);
    expect(append).not.toContain("GHOST-SHARED-SKILL");
    expect(append).not.toContain("GHOST-SHARED-RULE");
    expect(append).not.toContain("GHOST-SHARED-PROMPT");
    expect(append).not.toContain("GHOST-SHARED-COMMAND");
    expect(append).not.toContain("PROJECT-SHADOWED-INSTRUCTION");
    expect(append).not.toContain("PROJECT-MALFORMED-SKILL");
    expect(append).not.toContain("PROJECT-NAMELESS-COLLISION");
    expect(append).not.toContain("AMBIENT-GHOST-CLAUDE");
    expect(append).not.toContain("AMBIENT-GHOST-SKILL");
    expect(append).not.toContain("GHOST-INACTIVE-AGENT");
    expect(append).not.toContain("PROJECT-INACTIVE-AGENT");
    expect(append).not.toContain("PROJECT-EXECUTABLE");
  });

  it("keeps invalid UTF-8 project instructions, skills, and MCP out of Claude", async () => {
    const { seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-invalid-project-utf8");
    const invalidSkill = join(project, ".omp", "skills", "invalid");
    const validSkill = join(project, ".omp", "skills", "valid");
    mkdirSync(invalidSkill, { recursive: true });
    mkdirSync(validSkill, { recursive: true });
    writeFileSync(
      join(project, ".omp", "AGENTS.md"),
      Buffer.concat([Buffer.from("INVALID-CLAUDE-INSTRUCTION-"), Buffer.from([0x80])]),
    );
    writeFileSync(join(project, "AGENTS.md"), "VALID-CLAUDE-FALLBACK-INSTRUCTION");
    writeFileSync(
      join(invalidSkill, "SKILL.md"),
      Buffer.concat([
        Buffer.from("---\nname: invalid\ndescription: invalid\n---\n\nINVALID-CLAUDE-SKILL-"),
        Buffer.from([0x80]),
      ]),
    );
    writeFileSync(
      join(validSkill, "SKILL.md"),
      "---\nname: valid\ndescription: valid\n---\n\nVALID-CLAUDE-SKILL",
    );
    writeFileSync(
      join(project, ".omp", "mcp.json"),
      Buffer.concat([
        Buffer.from('{"mcpServers":{"invalid":{"type":"stdio","command":"INVALID-CLAUDE-MCP-'),
        Buffer.from([0x80]),
        Buffer.from('"}}}'),
      ]),
    );
    const preview = await host!.previewProject(
      "casper",
      "claude-invalid-utf8",
      "claude-code",
      project,
    );
    expect(preview.resources).toMatchObject({ instructions: 1, skills: 1, mcpServers: 0 });
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(".omp/AGENTS.md was ignored because it is not valid UTF-8"),
      expect.stringContaining(".omp/skills/invalid/SKILL.md was ignored because it is not valid UTF-8"),
      expect.stringContaining(".omp/mcp.json was ignored because it is not valid UTF-8"),
    ]));
    await host!.bindProject("casper", "claude-invalid-utf8", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "claude-invalid-utf8",
      prompt: "use only valid project resources",
      emit: () => {},
    });

    const prompt = JSON.stringify(seenOptions[0]?.systemPrompt);
    expect(prompt).toContain("VALID-CLAUDE-FALLBACK-INSTRUCTION");
    expect(prompt).not.toContain("VALID-CLAUDE-SKILL");
    expect(prompt).not.toContain("\uFFFD");
    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("invalid");
    expect(await host!.getProject("casper", "claude-invalid-utf8", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("degrades and omits project MCP timeouts below the Claude SDK floor", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-low-mcp-timeout");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        zero: { type: "stdio", command: process.execPath, timeout: 0 },
        below: { type: "stdio", command: process.execPath, timeout: 999 },
        floor: { type: "stdio", command: process.execPath, timeout: 1_000 },
        exact: { type: "stdio", command: process.execPath, timeout: 1_234 },
      },
    }));
    const preview = await host!.previewProject(
      "casper",
      "low-mcp-timeout",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "low-mcp-timeout", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "low-mcp-timeout",
      prompt: "use representable MCP timeouts",
      emit: () => {},
    });

    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("zero");
    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("below");
    expect(seenOptions[0]?.mcpServers).toMatchObject({
      floor: { timeout: 1_000 },
      exact: { timeout: 1_234 },
    });
    expect(await host!.getProject("casper", "low-mcp-timeout", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
    const stored = JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "low-mcp-timeout"),
      "utf8",
    ));
    expect(stored.projectSnapshot.mcpServers).toEqual(expect.objectContaining({
      floor: expect.objectContaining({ timeout: 1_000 }),
      exact: expect.objectContaining({ timeout: 1_234 }),
    }));
    expect(stored.projectSnapshot.mcpServers).not.toHaveProperty("zero");
    expect(stored.projectSnapshot.mcpServers).not.toHaveProperty("below");
    expect(stored.projectSnapshot.mcpWarnings).toEqual(expect.arrayContaining([
      "zero: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.",
      "below: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.",
    ]));
  });

  it("revalidates stored MCP timeout semantics before a Claude resume", async () => {
    const { paths, seenOptions, lifecycle } = setupClaudeHost();
    const project = join(temp!.root, "claude-stored-low-mcp-timeout");
    mkdirSync(project);
    const preview = await host!.previewProject(
      "casper",
      "stored-low-timeout",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "stored-low-timeout", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "stored-low-timeout");
    writeFileSync(sidecar, storedClaudeV3({
      conversationId: "stored-low-timeout",
      root: project,
      mcpServers: Object.fromEntries([
        ["__proto__", {
          type: "http",
          url: "https://mcp.example.test/below",
          timeout: 999,
          alwaysLoad: true,
        }],
        ["constructor", {
          type: "http",
          url: "https://mcp.example.test/floor",
          timeout: 1_000,
          alwaysLoad: true,
        }],
        ["toString", {
          type: "http",
          url: "https://mcp.example.test/exact",
          timeout: 1_234,
          alwaysLoad: true,
        }],
      ]),
    }), { mode: 0o600 });

    await host!.runTurn("casper", {
      sessionId: "stored-low-timeout",
      prompt: "resume with exact timeout semantics",
      emit: () => {},
    });

    expect(lifecycle.queries).toBe(1);
    expect(seenOptions[0]?.resume).toBe("sdk-stored-low-timeout");
    const resumed = seenOptions[0]?.mcpServers as Record<string, unknown>;
    expect(Object.hasOwn(resumed, "__proto__")).toBe(false);
    expect(Object.hasOwn(resumed, "constructor")).toBe(true);
    expect(Object.hasOwn(resumed, "toString")).toBe(true);
    expect(resumed.constructor).toMatchObject({ timeout: 1_000 });
    expect(resumed.toString).toMatchObject({ timeout: 1_234 });
    const repaired = JSON.parse(readFileSync(sidecar, "utf8")) as {
      projectSnapshot: {
        mcpServers: Record<string, { timeout?: number }>;
        mcpWarnings: string[];
      };
    };
    expect(Object.hasOwn(repaired.projectSnapshot.mcpServers, "__proto__")).toBe(false);
    const repairedByName = new Map(Object.entries(repaired.projectSnapshot.mcpServers));
    expect(repairedByName.get("constructor")?.timeout).toBe(1_000);
    expect(repairedByName.get("toString")?.timeout).toBe(1_234);
    expect(repaired.projectSnapshot.mcpWarnings).toContain(
      "__proto__: row rejected because Claude Code cannot preserve MCP timeouts below 1000 ms.",
    );
    expect(await host!.getProject("casper", "stored-low-timeout", "claude-code"))
      .toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("round-trips the complete credential-free serializable SDK MCP union", async () => {
    const { paths, seenOptions, lifecycle } = setupClaudeHost();
    const project = join(temp!.root, "claude-sdk-mcp-roundtrip");
    mkdirSync(project);
    const preview = await host!.previewProject(
      "casper",
      "sdk-mcp-roundtrip",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "sdk-mcp-roundtrip", "claude-code", {
      root: project,
      cwd: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });
    const mcpServers = {
      local: {
        type: "stdio",
        command: process.execPath,
        args: ["--version"],
        env: {},
        timeout: 1_000,
        alwaysLoad: true,
      },
      remote_http: {
        type: "http",
        url: "https://mcp.example.test/http",
        headers: {},
        tools: [{ name: "read", permission_policy: "always_allow" }],
        timeout: 2_000,
        alwaysLoad: false,
      },
      remote_sse: {
        type: "sse",
        url: "http://127.0.0.1:9010/events",
        tools: [{ name: "write", permission_policy: "always_ask" }],
        timeout: 3_000,
        alwaysLoad: true,
      },
    };
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "sdk-mcp-roundtrip");
    writeFileSync(sidecar, storedClaudeV3({
      conversationId: "sdk-mcp-roundtrip",
      root: project,
      mcpServers,
    }), { mode: 0o600 });

    await host!.runTurn("casper", {
      sessionId: "sdk-mcp-roundtrip",
      prompt: "resume the pinned transports",
      emit: () => {},
    });

    expect(lifecycle.queries).toBe(1);
    expect(seenOptions[0]?.resume).toBe("sdk-sdk-mcp-roundtrip");
    expect(seenOptions[0]?.mcpServers).toMatchObject(mcpServers);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 3,
      projectSnapshot: { mcpServers },
    });
    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({ conversationId: "sdk-mcp-roundtrip", runtime: "claude-code" }),
    ]);
  });

  it("rejects malformed or secret-bearing stored MCP rows before SDK launch or logging", async () => {
    const logger = recordingLogger();
    const { paths, lifecycle } = setupClaudeHost({ logger });
    const project = join(temp!.root, "claude-malformed-stored-mcp");
    mkdirSync(project);
    const sentinel = "R4-SIDECAR-SECRET-MUST-NOT-LOG";
    const cases: Array<[string, Record<string, unknown>]> = [
      ["bad-command", { bad: { type: "stdio", command: 42 } }],
      ["bad-transport", { bad: { type: "websocket", url: "https://example.test" } }],
      ["extra-secret", { bad: { type: "stdio", command: "safe", token: sentinel } }],
      ["env-secret", { bad: { type: "stdio", command: "safe", env: { TOKEN: sentinel } } }],
      ["header-secret", {
        bad: { type: "http", url: "https://example.test", headers: { authorization: sentinel } },
      }],
    ];

    for (const [conversationId, mcpServers] of cases) {
      const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
      mkdirSync(paths.sessionDir, { recursive: true });
      writeFileSync(sidecar, storedClaudeV3({ conversationId, root: project, mcpServers }), {
        mode: 0o600,
      });
      const events: PiMessagesEvent[] = [];
      await expect(host!.runTurn("casper", {
        sessionId: conversationId,
        prompt: "must fail before launch",
        emit: (event) => events.push(event),
      })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });
      expect(events).toEqual([]);
    }

    const inconsistentId = "inconsistent-mcp-resources";
    const inconsistentSidecar = claudeSessionMetadataPath(paths.sessionDir, inconsistentId);
    writeFileSync(inconsistentSidecar, storedClaudeV3({
      conversationId: inconsistentId,
      root: project,
      mcpServers: {
        safe: { type: "stdio", command: process.execPath, alwaysLoad: true },
      },
      mcpResources: [{
        name: "safe",
        path: join(project, ".omp", "mcp.json"),
        status: "disabled",
        reason: "Contradicts the executable snapshot.",
      }],
    }), { mode: 0o600 });
    await expect(host!.runTurn("casper", {
      sessionId: inconsistentId,
      prompt: "must reject inconsistent admission metadata",
      emit: () => {},
    })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });

    expect(lifecycle.queries).toBe(0);
    expect(await host!.listSessions("casper")).toEqual([]);
    expect(JSON.stringify(logger.records)).not.toContain(sentinel);
  });

  it("keeps non-MCP project scan warnings out of Claude MCP health", async () => {
    setupClaudeHost();
    const project = join(temp!.root, "claude-resource-warning-only");
    const outside = join(temp!.root, "outside-skill");
    mkdirSync(join(project, "skills"), { recursive: true });
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        bounded_fixture: { type: "stdio", command: process.execPath, args: ["--version"] },
      },
    }));
    for (let index = 0; index < PROJECT_SCAN_MAX_ENTRIES + 10; index += 1) {
      writeFileSync(join(project, ".omp", "rules", `wide-${index}.md`), `rule ${index}`);
    }
    mkdirSync(outside);
    symlinkSync(outside, join(project, "skills", "escaped"));
    const preview = await host!.previewProject(
      "casper",
      "resource-warning-only",
      "claude-code",
      project,
    );
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("symbolic links"),
      expect.stringContaining("entry limit"),
    ]));
    await host!.bindProject("casper", "resource-warning-only", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    await host!.runTurn("casper", {
      sessionId: "resource-warning-only",
      prompt: "use the safe project snapshot",
      emit: () => {},
    });

    expect(await host!.getProject("casper", "resource-warning-only", "claude-code"))
      .toMatchObject({ status: "ready", error: null, mcpStatus: "ready" });
    const stored = JSON.parse(readFileSync(
      claudeSessionMetadataPath(
        ghostPaths(temp!.registry.get("casper").dir).sessionDir,
        "resource-warning-only",
      ),
      "utf8",
    ));
    expect(stored.projectSnapshot.resourceWarnings)
      .toContainEqual(expect.stringContaining("symbolic links"));
    expect(stored.projectSnapshot.mcpWarnings).toEqual([]);
  });

  it("freezes one immutable project scan between admission and Claude execution", async () => {
    const { seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-single-project-scan");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "PINNED-BEFORE-QUERY");
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        pinned: { type: "stdio", command: process.execPath, args: ["--version"] },
      },
    }));
    const preview = await host!.previewProject("casper", "single-scan", "claude-code", project);
    await host!.bindProject("casper", "single-scan", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    const claudeRuntime = (host as unknown as {
      claudeCode: { admitProjectSnapshot(...args: unknown[]): Promise<unknown> };
    }).claudeCode;
    const scan = vi.spyOn(claudeRuntime, "admitProjectSnapshot");
    const admission = await host!.admitTurn("casper", {
      sessionId: "single-scan",
      prompt: "use the admitted snapshot",
    });
    expect(scan).toHaveBeenCalledTimes(1);
    writeFileSync(join(project, "AGENTS.md"), "MUTATED-BEFORE-QUERY");
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { replacement: { type: "stdio", command: "changed" } },
    }));
    await admission.run({ emit: () => {} });
    expect(scan).toHaveBeenCalledTimes(1);

    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).toContain("PINNED-BEFORE-QUERY");
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).not.toContain("MUTATED-BEFORE-QUERY");
    expect(seenOptions[0]?.mcpServers).toHaveProperty("pinned");
    expect(seenOptions[0]?.mcpServers).not.toHaveProperty("replacement");
  });

  it("rejects secret-bearing project MCP before query or resume metadata publication", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const project = join(temp!.root, "claude-secret-mcp");
    const sentinel = "GHOST_CLAUDE_PROJECT_SECRET_SENTINEL";
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        secret_stdio: {
          type: "stdio",
          command: process.execPath,
          args: ["--version", `$${"{CLAUDE_PROJECT_TOKEN}"}`],
          env: { CLAUDE_PROJECT_TOKEN: sentinel },
        },
      },
    }));
    const preview = await host!.previewProject(
      "casper",
      "secret-project-mcp",
      "claude-code",
      project,
    );
    await host!.bindProject("casper", "secret-project-mcp", "claude-code", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    const events: PiMessagesEvent[] = [];
    const before = await host!.getProject("casper", "secret-project-mcp", "claude-code");
    await expect(host!.runTurn("casper", {
      sessionId: "secret-project-mcp",
      prompt: "must fail before Claude starts",
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({
      code: "claude_project_mcp_secrets_unsupported",
      status: 409,
    });
    expect(events).toEqual([]);
    expect(seenOptions).toHaveLength(0);
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "secret-project-mcp",
    ))).toBe(false);
    expect(await host!.getProject("casper", "secret-project-mcp", "claude-code"))
      .toMatchObject({
        generation: before.generation,
        status: before.status,
        error: before.error,
        mcpStatus: before.mcpStatus,
        lastRefreshAt: before.lastRefreshAt,
      });
    // Project files stay outside the portable ghost home, and no expanded or
    // literal credential may be copied into that home.
    expect(filesystemTreeContains(paths.home, sentinel)).toBe(false);

    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        safe_stdio: { type: "stdio", command: process.execPath, args: ["--version"] },
      },
    }));
    await host!.runTurn("casper", {
      sessionId: "secret-project-mcp",
      prompt: "retry the validated project",
      emit: () => {},
    });
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.mcpServers).toHaveProperty("safe_stdio");
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "secret-project-mcp",
    ))).toBe(true);
    expect(filesystemTreeContains(paths.home, sentinel)).toBe(false);
  });

  it("uses SDK num_turns across resume while preserving an existing sidecar count", async () => {
    const { paths, seenOptions } = setupClaudeHost({
      createQuery: (input, lifecycle) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          (turn) => responseMessages(sessionId, `response ${turn}`, turn === 1 ? 3 : 2),
          lifecycle,
          input.prompt,
        );
      },
    });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-counted");
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(sidecar, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-counted",
      sessionId: "existing-sdk-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 8,
    })}\n`, { mode: 0o600 });

    await host!.runTurn("casper", {
      sessionId: "conversation-counted",
      prompt: "first resumed turn",
      emit: () => {},
    });
    expect(seenOptions[0]?.cwd).toBe(paths.home);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 3,
      cwd: paths.home,
      sessionId: "existing-sdk-session",
      messageCount: 14,
      ownerTurnCount: 5,
    });

    await host!.runTurn("casper", {
      sessionId: "conversation-counted",
      prompt: "second resumed turn",
      emit: () => {},
    });
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      sessionId: "existing-sdk-session",
      messageCount: 18,
      ownerTurnCount: 6,
    });
    expect((await host!.listSessions("casper"))[0]).toMatchObject({
      messageCount: 18,
    });
  });

  it("persists a terminal zero-turn resume id without fabricating messages", async () => {
    let queryNumber = 0;
    const { paths, seenOptions } = setupClaudeHost({
      createQuery: (input, lifecycle) => {
        queryNumber += 1;
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          responseMessages(sessionId, `response ${queryNumber}`, queryNumber === 1 ? 0 : 1),
          lifecycle,
          input.prompt,
        );
      },
    });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-zero-turn");

    await host!.runTurn("casper", {
      sessionId: "conversation-zero-turn",
      prompt: "first",
      emit: () => {},
    });
    const first = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(first).toMatchObject({
      sessionId: seenOptions[0]?.sessionId,
      messageCount: 0,
      ownerTurnCount: 1,
    });

    // Retiring the warm query is what makes the next turn a real resume.
    await host!.close("casper", "conversation-zero-turn");
    await host!.runTurn("casper", {
      sessionId: "conversation-zero-turn",
      prompt: "resume",
      emit: () => {},
    });
    expect(seenOptions[1]?.resume).toBe(first.sessionId);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      messageCount: 2,
      ownerTurnCount: 2,
    });
  });

  it("rejects an exhausted owner-turn counter before hooks or a query", async () => {
    const hooks = new GhostHookRunner();
    const hookTurns: number[] = [];
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        hookTurns.push(event.turn_id);
      });
    });
    const { paths, lifecycle } = setupClaudeHost({ hooks });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-owner-overflow");
    mkdirSync(paths.sessionDir, { recursive: true });
    const original = `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-owner-overflow",
      sessionId: "existing-sdk-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 2,
      ownerTurnCount: Number.MAX_SAFE_INTEGER,
    })}\n`;
    writeFileSync(sidecar, original, { mode: 0o600 });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-owner-overflow",
      prompt: "must not wrap",
      emit: (event) => events.push(event),
    });

    expect(hookTurns).toEqual([]);
    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("owner turn count overflowed"),
    });
    expect(readFileSync(sidecar, "utf8")).toBe(original);
  });

  it("treats an odd legacy message count as corrupt instead of flooring a hook id", async () => {
    const { paths, lifecycle } = setupClaudeHost();
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-odd-legacy");
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(sidecar, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-odd-legacy",
      sessionId: "existing-sdk-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 3,
    })}\n`, { mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([]);
    const events: PiMessagesEvent[] = [];
    await expect(host!.runTurn("casper", {
      sessionId: "conversation-odd-legacy",
      prompt: "must not guess",
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });
    expect(lifecycle.queries).toBe(0);
    expect(events).toEqual([]);
  });

  it.each([
    ["created", "2026-01-01T00:00:00Z"],
    ["created", "not-a-timestamp"],
    ["modified", "2026-01-01T00:00:00.000+00:00"],
    ["modified", "2026-02-30T00:00:00.000Z"],
  ] as const)(
    "rejects a noncanonical or invalid v3 %s timestamp before any Claude work",
    async (field, timestamp) => {
      let authReads = 0;
      const { paths, lifecycle } = setupClaudeHost({
        readAuthStatus: async () => {
          authReads += 1;
          return { loggedIn: true, authMethod: "claude.ai" };
        },
      });
      const conversationId = `invalid-${field}-${timestamp.length}`;
      const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
      mkdirSync(paths.sessionDir, { recursive: true });
      const metadata = storedUnboundClaudeV3(conversationId);
      metadata[field] = timestamp;
      const original = `${JSON.stringify(metadata)}\n`;
      writeFileSync(sidecar, original, { mode: 0o600 });
      const events: PiMessagesEvent[] = [];

      await expect(host!.runTurn("casper", {
        sessionId: conversationId,
        prompt: "must fail without paid Claude work",
        emit: (event) => events.push(event),
      })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });

      expect(authReads).toBe(0);
      expect(lifecycle.queries).toBe(0);
      expect(events).toEqual([]);
      expect(readFileSync(sidecar, "utf8")).toBe(original);
    },
  );

  it("revalidates resume timestamps after admission and before the Claude auth probe", async () => {
    let authReads = 0;
    const { paths, lifecycle } = setupClaudeHost({
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });
    const conversationId = "timestamp-swapped-after-admission";
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(sidecar, `${JSON.stringify(storedUnboundClaudeV3(conversationId))}\n`, {
      mode: 0o600,
    });
    const admission = await host!.admitTurn("casper", {
      sessionId: conversationId,
      prompt: "do not pay for corrupt resume state",
    });
    const changed = storedUnboundClaudeV3(conversationId);
    changed.modified = "2026-01-01T00:00:00Z";
    const invalid = `${JSON.stringify(changed)}\n`;
    writeFileSync(sidecar, invalid, { mode: 0o600 });
    const events: PiMessagesEvent[] = [];

    await admission.run({ emit: (event) => events.push(event) });

    expect(authReads).toBe(0);
    expect(lifecycle.queries).toBe(0);
    expect(events.filter((event) => event.type === "done" || event.type === "error"))
      .toEqual([expect.objectContaining({
        type: "error",
        errorMessage: expect.stringContaining("metadata contract"),
      })]);
    expect(readFileSync(sidecar, "utf8")).toBe(invalid);
  });

  it("re-probes auth for every turn and again after an explicit auth refresh", async () => {
    let authReads = 0;
    setupClaudeHost({
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });

    for (const sessionId of ["conversation-cache-a", "conversation-cache-b"]) {
      await host!.runTurn("casper", { sessionId, prompt: "hello", emit: () => {} });
    }
    expect(authReads).toBe(2);

    await host!.refreshAuth("casper");
    await host!.runTurn("casper", {
      sessionId: "conversation-cache-c",
      prompt: "hello again",
      emit: () => {},
    });
    expect(authReads).toBe(3);
  });

  it("does not reuse the catalogue auth cache for turn admission", async () => {
    let resolutions = 0;
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "configured-claude",
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => {
        resolutions += 1;
        return process.execPath;
      },
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });
    setupClaudeHost({ probe });
    const catalog = new ModelCatalog({
      registry: temp!.registry,
      offline: true,
      claudeCodeProbe: probe,
      createRuntime: async () => makeFakeCatalogRuntime({ models: [] }),
    });

    const listing = await catalog.listModels("casper", {
      scope: "catalog",
      provider: "claude-code",
    });
    expect(listing.models).toEqual([expect.objectContaining({
      provider: "claude-code",
      usable: true,
    })]);
    await host!.runTurn("casper", {
      sessionId: "conversation-shared-probe",
      prompt: "hello",
      emit: () => {},
    });

    expect({ resolutions, authReads }).toEqual({ resolutions: 2, authReads: 2 });
  });

  it("deletes a Claude Code resume sidecar, its presentation journal, and its review journal", async () => {
    const { paths } = setupClaudeHost();
    await host!.runTurn("casper", {
      sessionId: "conversation-delete",
      prompt: "Remember this",
      emit: () => {},
    });
    expect(await host!.listSessions("casper")).toHaveLength(1);
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-delete");
    const journal = presentationHistoryPath(paths.sessionDir, "claude-code", "conversation-delete");
    expect(existsSync(journal)).toBe(true);
    const identity = { runtime: "claude-code", conversationId: "conversation-delete" } as const;
    await new ReviewJournalStore().record(paths.sessionDir, identity, {
      turnId: 1,
      mode: "advisory",
      delta: {
        text: "user: remember this",
        commands: [],
        paths: [],
        source: "transcript",
        delegations: 0,
      },
      lint: [],
      notes: [],
      delivered: "none",
      continuationPass: false,
    });
    const reviewJournal = reviewJournalPath(paths.sessionDir, "claude-code", "conversation-delete");
    expect(existsSync(reviewJournal)).toBe(true);
    writeFileSync(`${sidecar}.started`, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-delete",
    })}\n`, { mode: 0o600 });

    const trashed = await host!.deleteSession("casper", "conversation-delete", "claude-code");
    const journalArtifact = trashed.artifacts.find((artifact) =>
      artifact.artifact === "presentation-history"
    );
    expect(journalArtifact).toMatchObject({ source: journal });
    expect(existsSync((journalArtifact as { trash: string }).trash)).toBe(true);
    const reviewArtifact = trashed.artifacts.find((artifact) =>
      artifact.artifact === "review-journal"
    );
    expect(reviewArtifact).toMatchObject({ source: reviewJournal });
    expect(existsSync((reviewArtifact as { trash: string }).trash)).toBe(true);
    expect(await host!.listSessions("casper")).toEqual([]);
    expect(existsSync(sidecar)).toBe(false);
    expect(existsSync(`${sidecar}.started`)).toBe(false);
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(reviewJournal)).toBe(false);
  });

  it("reads a pre-journal Claude sidecar as empty history with the prefix marked", async () => {
    const { paths } = setupClaudeHost();
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "legacy-claude"),
      storedClaudeV1("legacy-claude"),
      { mode: 0o600 },
    );
    await expect(host!.readTranscript("casper", "legacy-claude", {}, "claude-code"))
      .resolves.toMatchObject({
        id: "claude-code:legacy-claude",
        runtime: "claude-code",
        messages: [],
        total: 0,
        truncated: false,
        historyTruncated: true,
      });
  });

  it("never publishes a conversation from a presentation journal alone", async () => {
    const { paths } = setupClaudeHost();
    mkdirSync(paths.sessionDir, { recursive: true });
    const store = new PresentationHistoryStore();
    await store.recordSettledTurn(
      paths.sessionDir,
      { runtime: "claude-code", conversationId: "journal-only" },
      {
        source: {
          runtime: "claude-code",
          createdAt: "2026-01-01T00:00:00.000Z",
          resumeId: "sdk-journal-only",
        },
        sourceRevision: { kind: "claude-owner-turn", value: 1 },
        sourceOrdinal: 1,
        ownerPrompt: "orphaned",
        assistantText: "orphaned answer",
        outcome: "completed",
      },
    );
    expect(await host!.listSessions("casper")).toEqual([]);
    await expect(host!.readTranscript("casper", "journal-only", {}, "claude-code"))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("fails open on a journal write failure and heals into an honest gap", async () => {
    const logger = recordingLogger("warn");
    const { paths } = setupClaudeHost({ logger });
    mkdirSync(paths.sessionDir, { recursive: true });
    const journal = presentationHistoryPath(paths.sessionDir, "claude-code", "journal-broken");
    writeFileSync(journal, "not json\n", { mode: 0o600 });

    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "journal-broken",
      prompt: "first",
      emit: (event) => events.push(event),
    });
    expect(events.at(-1)?.type).toBe("done");
    expect(logger.records).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "conversation presentation history was not recorded",
    }));
    expect(readFileSync(journal, "utf8")).toBe("not json\n");

    // Once the broken file is out of the way, the next settled turn journals
    // with the missed ordinal marked as an omitted prefix.
    rmSync(journal);
    const retry: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "journal-broken",
      prompt: "second",
      emit: (event) => retry.push(event),
    });
    expect(retry.at(-1)?.type).toBe("done");
    expect(JSON.parse(readFileSync(journal, "utf8"))).toMatchObject({
      historyPrefixOmitted: true,
      lastSourceOrdinal: 2,
      turns: [{ sourceOrdinal: 2, ownerText: "second" }],
    });
    await expect(host!.readTranscript("casper", "journal-broken", {}, "claude-code"))
      .resolves.toMatchObject({ total: 2, historyTruncated: true });
  });

  it("publishes a first-turn settling candidate before listing the session", async () => {
    const { paths } = setupClaudeHost();
    const conversationId = "first-turn-list-recovery";
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(`${sidecar}.started`, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId,
    })}\n`, { mode: 0o600 });
    writeFileSync(`${sidecar}.settling`, storedClaudeV1(conversationId), { mode: 0o600 });

    expect(existsSync(sidecar)).toBe(false);
    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({
        conversationId,
        runtime: "claude-code",
        messageCount: 2,
      }),
    ]);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({ conversationId, messageCount: 2 });
    expect(existsSync(`${sidecar}.started`)).toBe(false);
    expect(existsSync(`${sidecar}.settling`)).toBe(false);
  });

  it("lists the recovered settling candidate instead of stale ready metadata", async () => {
    const { paths } = setupClaudeHost();
    const conversationId = "existing-list-recovery";
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
    mkdirSync(paths.sessionDir, { recursive: true });
    const ready = JSON.parse(storedClaudeV1(conversationId)) as Record<string, unknown>;
    const settling = {
      ...ready,
      sessionId: "sdk-existing-list-recovered",
      modified: "2026-02-01T00:00:00.000Z",
      messageCount: 4,
      ownerTurnCount: 2,
    };
    writeFileSync(sidecar, `${JSON.stringify(ready)}\n`, { mode: 0o600 });
    writeFileSync(`${sidecar}.started`, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId,
    })}\n`, { mode: 0o600 });
    writeFileSync(`${sidecar}.settling`, `${JSON.stringify(settling)}\n`, { mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({
        conversationId,
        messageCount: 4,
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
    ]);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject(settling);
    expect(existsSync(`${sidecar}.started`)).toBe(false);
    expect(existsSync(`${sidecar}.settling`)).toBe(false);
  });

  it("skips and logs malformed Claude Code sidecars without hiding valid sessions", async () => {
    const logger = recordingLogger("warn");
    const { paths } = setupClaudeHost({ logger });
    await host!.runTurn("casper", {
      sessionId: "conversation-valid",
      prompt: "Remember this",
      emit: () => {},
    });
    const malformedPath = join(paths.sessionDir, "claude-malformed.json");
    writeFileSync(malformedPath, "{ definitely not json\n", { encoding: "utf8", mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({
        id: "claude-code:conversation-valid",
        conversationId: "conversation-valid",
        runtime: "claude-code",
      }),
    ]);
    expect(logger.records).toContainEqual(expect.objectContaining({
      message: "skipping invalid Claude Code session metadata",
      fields: expect.objectContaining({
        path: malformedPath,
        error: expect.stringContaining("not valid Claude session metadata"),
      }),
    }));
  });

  it("listSessions skips insecure sidecar entries without hiding a valid sibling", async () => {
    const logger = recordingLogger("warn");
    const { paths } = setupClaudeHost({ logger });
    await host!.runTurn("casper", {
      sessionId: "secure-listing",
      prompt: "persist one valid row",
      emit: () => {},
    });

    const wrongMode = claudeSessionMetadataPath(paths.sessionDir, "wrong-mode-listing");
    writeFileSync(wrongMode, storedClaudeV1("wrong-mode-listing"), { mode: 0o600 });
    chmodSync(wrongMode, 0o640);

    const symlink = claudeSessionMetadataPath(paths.sessionDir, "symlink-listing");
    symlinkSync(claudeSessionMetadataPath(paths.sessionDir, "secure-listing"), symlink);

    const oversized = claudeSessionMetadataPath(paths.sessionDir, "oversized-listing");
    writeFileSync(oversized, Buffer.alloc(CLAUDE_SESSION_METADATA_MAX_BYTES + 1, 0x78), {
      mode: 0o600,
    });

    const fifo = claudeSessionMetadataPath(paths.sessionDir, "fifo-listing");
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({ conversationId: "secure-listing", runtime: "claude-code" }),
    ]);
    expect(logger.records.map((entry) => entry.fields?.path)).toEqual(expect.arrayContaining([
      wrongMode,
      symlink,
      oversized,
      fifo,
    ]));
  });

  it("never lists or resumes a Claude sidecar transplanted onto another id's hash", async () => {
    const logger = recordingLogger("warn");
    const { paths, lifecycle } = setupClaudeHost({ logger });
    await host!.runTurn("casper", {
      sessionId: "conversation-a",
      prompt: "remember A",
      emit: () => {},
    });
    const source = claudeSessionMetadataPath(paths.sessionDir, "conversation-a");
    const transplanted = claudeSessionMetadataPath(paths.sessionDir, "conversation-b");
    writeFileSync(transplanted, readFileSync(source), { mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([
      expect.objectContaining({
        id: "claude-code:conversation-a",
        conversationId: "conversation-a",
      }),
    ]);
    expect(logger.records).toContainEqual(expect.objectContaining({
      message: "skipping invalid Claude Code session metadata",
      fields: expect.objectContaining({
        path: transplanted,
        error: expect.stringContaining("sidecar filename"),
      }),
    }));

    const events: PiMessagesEvent[] = [];
    await expect(host!.runTurn("casper", {
      sessionId: "conversation-b",
      prompt: "do not resume A",
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({ code: "session_identity_mismatch", status: 409 });
    expect(lifecycle.queries).toBe(1);
    expect(events).toEqual([]);
    expect(JSON.parse(readFileSync(transplanted, "utf8"))).toMatchObject({
      conversationId: "conversation-a",
    });
  });

  it("rejects empty, overlong, and malformed stored Claude identities", async () => {
    const { paths, lifecycle } = setupClaudeHost();
    for (const conversationId of ["", "x".repeat(201)]) {
      try {
        claudeSessionMetadataPath(paths.sessionDir, conversationId);
        throw new Error("expected invalid conversation id");
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_conversation_id", status: 400 });
      }
    }

    mkdirSync(paths.sessionDir, { recursive: true });
    writeFileSync(join(paths.sessionDir, `claude-${"0".repeat(64)}.json`), `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "",
      sessionId: "stored-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      ownerTurnCount: 0,
    })}\n`, { mode: 0o600 });
    const boundedConversation = "conversation-invalid-session";
    const invalidSessionPath = claudeSessionMetadataPath(paths.sessionDir, boundedConversation);
    writeFileSync(invalidSessionPath, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: boundedConversation,
      sessionId: "x".repeat(513),
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      ownerTurnCount: 0,
    })}\n`, { mode: 0o600 });

    expect(await host!.listSessions("casper")).toEqual([]);
    const events: PiMessagesEvent[] = [];
    await expect(host!.runTurn("casper", {
      sessionId: boundedConversation,
      prompt: "must not resume malformed metadata",
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({ code: "claude_session_invalid", status: 500 });
    expect(lifecycle.queries).toBe(0);
    expect(events).toEqual([]);
  });

  it("applies session_stop continuations before the Claude turn settles", async () => {
    const hookContinuationPasses = 12;
    const hooks = new GhostHookRunner();
    const active: boolean[] = [];
    const beforeTurnIds: number[] = [];
    const turnIds: number[] = [];
    const ownerPrompts: string[] = [];
    const hookHomes: string[] = [];
    const hookCwds: string[] = [];
    const hookIdentities: string[] = [];
    await hooks.register((api) => {
      api.on("before_prompt", (event) => {
        beforeTurnIds.push(event.turn_id);
      });
      api.on("session_stop", (event) => {
        const priorPasses = turnIds.filter((turnId) => turnId === event.turn_id).length;
        active.push(event.stop_hook_active);
        turnIds.push(event.turn_id);
        ownerPrompts.push(event.owner_prompt);
        hookHomes.push(event.ghost_home);
        hookCwds.push(event.cwd);
        hookIdentities.push(`${event.runtime}:${event.conversation_runtime}:${event.conversation_id}`);
        if (priorPasses < hookContinuationPasses) {
          return { continue: true, additionalContext: "Revise it again." };
        }
      });
    });
    const providerTurns = [4, 2, 3, 1];
    const { seenOptions, lifecycle, paths } = setupClaudeHost({
      hooks,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        // Each continuation is another pass through the one warm query, so the
        // scripted turn counts are indexed by pass rather than by query.
        return fakeQuery(
          (pass) => responseMessages(sessionId, `pass ${pass}`, providerTurns[pass - 1] ?? 1),
          state,
          input.prompt,
        );
      },
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-hooks",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    // The hook owns its stopping policy and may continue beyond Ghost's former
    // host cap. Every pass is another prompt into the one warm query, not
    // another query.
    const passCount = hookContinuationPasses + 1;
    const activePerTurn = [false, ...Array(passCount - 1).fill(true)];
    expect(lifecycle.queries).toBe(1);
    expect(seenOptions).toHaveLength(1);
    expect(active).toEqual(activePerTurn);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    // The fake query reports two tokens per query.
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { totalTokens: passCount * 2 } });

    await host!.runTurn("casper", {
      sessionId: "conversation-hooks",
      prompt: "one more owner turn",
      emit: () => {},
    });
    // A second owner turn on the same warm process: still one query.
    expect(lifecycle.queries).toBe(1);
    expect(active).toEqual([...activePerTurn, ...activePerTurn]);
    expect(beforeTurnIds).toEqual([1, 2]);
    expect(turnIds).toEqual([...Array(passCount).fill(1), ...Array(passCount).fill(2)]);
    expect(ownerPrompts).toEqual([
      ...Array(passCount).fill("hello"),
      ...Array(passCount).fill("one more owner turn"),
    ]);
    expect(hookHomes).toEqual(Array(passCount * 2).fill(paths.home));
    expect(hookCwds).toEqual(Array(passCount * 2).fill(temp!.ownerHome));
    expect(hookIdentities).toEqual(Array(passCount * 2).fill(
      "claude-code:claude-code:conversation-hooks",
    ));
    // Each query runs `providerTurns[query] ?? 1` provider turns, two messages each.
    const totalProviderTurns = Array.from(
      { length: passCount * 2 },
      (_, query) => providerTurns[query] ?? 1,
    ).reduce((sum, turns) => sum + turns, 0);
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-hooks"),
      "utf8",
    ))).toMatchObject({
      messageCount: totalProviderTurns * 2,
      ownerTurnCount: 2,
    });
  });

  it("journals a settled Claude turn so its transcript is readable", async () => {
    const { paths } = setupClaudeHost();
    const events: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-journal-source",
      prompt: "Keep the source exact.",
      emit: (event) => events.push(event),
    });

    const metadata = JSON.parse(readFileSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-journal-source",
    ), "utf8")) as { created: string; sessionId: string };
    expect(JSON.parse(readFileSync(presentationHistoryPath(
      paths.sessionDir,
      "claude-code",
      "conversation-journal-source",
    ), "utf8"))).toMatchObject({
      historyPrefixOmitted: false,
      lastSourceOrdinal: 1,
      lastSourceRevision: { kind: "claude-owner-turn", value: 1 },
      turns: [{ ownerText: "Keep the source exact.", assistantText: "Hello from the plan." }],
    });
    expect(metadata.sessionId).toBeTruthy();
    await expect(host!.readTranscript(
      "casper",
      "conversation-journal-source",
      {},
      "claude-code",
    )).resolves.toMatchObject({
      id: "claude-code:conversation-journal-source",
      runtime: "claude-code",
      historyTruncated: false,
      total: 2,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Keep the source exact." }],
          entryId: "presentation:1:owner",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello from the plan." }],
          entryId: "presentation:1:assistant",
        },
      ],
    });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("injects before_prompt guidance into one Claude query", async () => {
    const hooks = new GhostHookRunner();
    let sidecar = "";
    let acknowledgedMetadata: unknown;
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "Avoid the prior warning.",
        acknowledge: () => {
          acknowledgedMetadata = JSON.parse(readFileSync(sidecar, "utf8"));
        },
      }));
    });
    const { seenOptions, seenPrompts, lifecycle, paths } = setupClaudeHost({ hooks });
    sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-before-prompt");

    await host!.runTurn("casper", {
      sessionId: "conversation-before-prompt",
      prompt: "hello",
      emit: () => {},
    });

    expect(lifecycle.queries).toBe(1);
    expect(seenOptions[0]?.systemPrompt).not.toContain("Avoid the prior warning.");
    expect(seenPrompts).toHaveLength(2);
    expect(seenPrompts[0]).toMatchObject({ isSynthetic: true, shouldQuery: false });
    expect(JSON.stringify(seenPrompts[0]?.message.content)).toContain("Avoid the prior warning.");
    expect(JSON.stringify(seenPrompts[1]?.message.content)).toContain("hello");
    expect(acknowledgedMetadata).toMatchObject({
      version: 3,
      conversationId: "conversation-before-prompt",
      ownerTurnCount: 1,
    });
  });

  it("fails open when a persisted Claude notice acknowledgement fails", async () => {
    const hooks = new GhostHookRunner();
    const logger = recordingLogger("warn");
    await hooks.register((api) => {
      api.on("before_prompt", () => ({
        additionalContext: "A durable maintenance notice.",
        acknowledge: () => {
          throw new Error("sensitive notice id");
        },
      }));
    });
    const { paths, lifecycle, seenOptions } = setupClaudeHost({ hooks, logger });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-ack-failure",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(events.at(-1)?.type).toBe("done");
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-ack-failure",
    ))).toBe(true);
    expect(logger.records).toContainEqual({
      level: "warn",
      message: "before_prompt hook acknowledgement failed",
      fields: {
        ghost: "casper",
        conversation: "conversation-ack-failure",
        runtime: "claude-code",
      },
    });
    expect(JSON.stringify(logger.records)).not.toContain("sensitive notice id");

    await host!.runTurn("casper", {
      sessionId: "conversation-ack-failure",
      prompt: "continue after the acknowledgement failure",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(lifecycle.closed).toBe(2);
    expect(seenOptions[1]?.resume).toBe(
      (JSON.parse(readFileSync(
        claudeSessionMetadataPath(paths.sessionDir, "conversation-ack-failure"),
        "utf8",
      )) as { sessionId: string }).sessionId,
    );
  });

  it("fails closed when the external CLI reports logged out and never starts a query", async () => {
    const { lifecycle } = setupClaudeHost({
      authStatus: { loggedIn: false, authMethod: "api_key" },
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: expect.stringContaining("did not report a usable native authentication method"),
    });
    expect(await host!.listSessions("casper")).toEqual([]);
  });

  it("cold-restarts across probe failure, provider/binary change, logout, and relogin", async () => {
    let failProbe = false;
    let binaryPath = "/mise/installs/claude/2.1.250/claude";
    let authStatus = {
      loggedIn: true,
      authMethod: "cloud",
      apiProvider: "bedrock",
      subscriptionType: "enterprise",
      accountFingerprint: STABLE_TEST_ACCOUNT,
    };
    const probe = new ClaudeCodeProbe({
      binaryPath: "claude",
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => binaryPath,
      inspectExecutable: async (path) => `test:${path}`,
      readAuthStatus: async () => {
        if (failProbe) {
          throw new ClaudeCodeProcessError(
            "Claude Code authentication status disagreed with exit 2.",
          );
        }
        return authStatus;
      },
    });
    const { lifecycle, seenOptions } = setupClaudeHost({ probe });
    const turn = (prompt: string, events: PiMessagesEvent[] = []) => host!.runTurn("casper", {
      sessionId: "auth-runtime-identity",
      prompt,
      emit: (event) => events.push(event),
    });

    await turn("first");
    expect(lifecycle.queries).toBe(1);

    failProbe = true;
    const failed: PiMessagesEvent[] = [];
    await turn("probe fails", failed);
    expect(failed.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("disagreed with exit 2"),
    });
    expect(lifecycle).toMatchObject({ queries: 1, closed: 1 });

    failProbe = false;
    await turn("probe recovers");
    expect(lifecycle.queries).toBe(2);

    binaryPath = "/mise/installs/claude/2.1.251/claude";
    authStatus = { ...authStatus, apiProvider: "vertex" };
    await turn("mise and provider changed");
    expect(lifecycle).toMatchObject({ queries: 3, closed: 2 });
    expect(seenOptions[2]?.pathToClaudeCodeExecutable).toBe(binaryPath);

    authStatus = { ...authStatus, loggedIn: false };
    const loggedOut: PiMessagesEvent[] = [];
    await turn("logged out", loggedOut);
    expect(loggedOut.at(-1)).toMatchObject({ type: "error" });
    expect(lifecycle).toMatchObject({ queries: 3, closed: 3 });

    authStatus = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
      subscriptionType: "max", accountFingerprint: STABLE_TEST_ACCOUNT };
    await turn("logged in again");
    expect(lifecycle.queries).toBe(4);
  });

  it("revalidates the SDK boundary before reusing a warm Claude query", async () => {
    const removed = new Error("SDK install changed; restart required");
    let installed = true;
    const probe = new ClaudeCodeProbe({
      binaryPath: process.execPath,
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => process.execPath,
      inspectExecutable: async (path) => `test:${path}`,
      readAuthStatus: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        accountFingerprint: STABLE_TEST_ACCOUNT,
      }),
      loadSdk: async () => {
        if (!installed) throw removed;
        return testClaudeAgentSdk;
      },
    });
    const { lifecycle, seenPrompts } = setupClaudeHost({ probe });
    const turn = (prompt: string, events: PiMessagesEvent[] = []) => host!.runTurn("casper", {
      sessionId: "sdk-removal-warm-query",
      prompt,
      emit: (event) => events.push(event),
    });

    await turn("start the warm query");
    installed = false;
    const events: PiMessagesEvent[] = [];
    await turn("do not reuse it after SDK removal", events);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(lifecycle.queries).toBe(1);
    expect(seenPrompts).toHaveLength(1);
  });

  it("retires warm state when the executable changes without changing its path", async () => {
    let executableIdentity = "executable-v1";
    const probe = new ClaudeCodeProbe({
      binaryPath: process.execPath,
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => process.execPath,
      inspectExecutable: async () => executableIdentity,
      readAuthStatus: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        accountFingerprint: STABLE_TEST_ACCOUNT,
      }),
    });
    const { lifecycle } = setupClaudeHost({ probe });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "executable-replaced-in-place",
      prompt,
      emit: () => {},
    });

    await turn("first");
    executableIdentity = "executable-v2";
    await turn("after replacement");

    expect(lifecycle).toMatchObject({ queries: 2, closed: 1 });
  });

  it("retires warm script state when the admitted Bun identity changes", async () => {
    const binaryPath = "/admitted/claude.mjs";
    let bunIdentity = "bun-v1";
    const probe = new ClaudeCodeProbe({
      binaryPath,
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => binaryPath,
      inspectExecutable: async (path) => path === process.execPath
        ? bunIdentity
        : "script-v1",
      readAuthStatus: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        accountFingerprint: STABLE_TEST_ACCOUNT,
      }),
    });
    const { lifecycle } = setupClaudeHost({ probe });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "bun-replaced-in-place",
      prompt,
      emit: () => {},
    });

    await turn("first");
    bunIdentity = "bun-v2";
    await turn("after Bun replacement");

    expect(lifecycle).toMatchObject({ queries: 2, closed: 1 });
  });

  it("retires warm state when the validated CLI version changes", async () => {
    let cliVersion = CLAUDE_CODE_MINIMUM_VERSION;
    const probe = new ClaudeCodeProbe({
      binaryPath: process.execPath,
      readVersion: async () => cliVersion,
      readAuthStatus: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        accountFingerprint: STABLE_TEST_ACCOUNT,
      }),
    });
    const { lifecycle } = setupClaudeHost({ probe });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "cli-version-changed",
      prompt,
      emit: () => {},
    });

    await turn("first");
    cliVersion = "2.1.252";
    await turn("after upgrade");

    expect(lifecycle).toMatchObject({ queries: 2, closed: 1 });
  });

  it("fails closed when the executable changes between auth and query startup", async () => {
    let inspections = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: process.execPath,
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => process.execPath,
      inspectExecutable: async () => {
        inspections += 1;
        return inspections <= 2 ? "authenticated-executable" : "replaced-executable";
      },
      readAuthStatus: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        accountFingerprint: STABLE_TEST_ACCOUNT,
      }),
    });
    const { lifecycle } = setupClaudeHost({ probe });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "executable-auth-query-race",
      prompt: "must not start",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("changed"),
    });
  });

  it("retires warm state when a same-label account fingerprint changes", async () => {
    let accountFingerprint = "1".repeat(64);
    const probe = new ClaudeCodeProbe({
      binaryPath: process.execPath,
      readVersion: readSupportedClaudeVersion,
      readAuthStatus: async () => ({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
        accountFingerprint,
      }),
    });
    const { lifecycle } = setupClaudeHost({ probe });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "same-label-account-change",
      prompt,
      emit: () => {},
    });

    await turn("first account");
    accountFingerprint = "2".repeat(64);
    await turn("replacement account");

    expect(lifecycle).toMatchObject({ queries: 2, closed: 1 });
  });

  it("uses a fresh cold query each turn when the CLI reports no stable account identity", async () => {
    const probe = new ClaudeCodeProbe({
      binaryPath: process.execPath,
      readVersion: readSupportedClaudeVersion,
      readAuthStatus: async () => ({
        loggedIn: true,
        authMethod: "future_native_sso",
      }),
    });
    const { lifecycle } = setupClaudeHost({ probe });
    const turn = (prompt: string) => host!.runTurn("casper", {
      sessionId: "no-stable-account-identity",
      prompt,
      emit: () => {},
    });

    await turn("first");
    await turn("second");

    expect(lifecycle).toMatchObject({ queries: 2, closed: 1 });
  });

  it.each([
    ["Claude.ai", { loggedIn: true, authMethod: "claude.ai" }],
    ["API key", { loggedIn: true, authMethod: "api_key" }],
    ["Bedrock", { loggedIn: true, authMethod: "cloud", apiProvider: "bedrock" }],
    ["Vertex", { loggedIn: true, authMethod: "cloud", apiProvider: "vertex" }],
    ["Foundry", { loggedIn: true, authMethod: "cloud", apiProvider: "foundry" }],
    ["router", { loggedIn: true, authMethod: "api_key", apiProvider: "openrouter" }],
    ["future method", { loggedIn: true, authMethod: "future_native_sso" }],
  ] as const)("runs with %s when the CLI reports it usable", async (_label, authStatus) => {
    const { lifecycle } = setupClaudeHost({ authStatus });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "native-auth-method",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("persists SDK turns and resume identity from a terminal max-turn error", async () => {
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          state.queries === 1
            ? [errorResultMessage(sessionId, "error_max_turns", 3)]
            : responseMessages(sessionId, "Recovered after the terminal error."),
          state,
          input.prompt,
        );
      },
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-max-turns",
      prompt: "keep going",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: expect.stringContaining("error_max_turns"),
    });
    const metadata = JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-max-turns"),
      "utf8",
    ));
    expect(metadata).toMatchObject({
      conversationId: "conversation-max-turns",
      sessionId: expect.any(String),
      messageCount: 6,
      ownerTurnCount: 1,
    });
    expect(lifecycle.closed).toBe(1);

    const retryEvents: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-max-turns",
      prompt: "retry cold",
      emit: (event) => retryEvents.push(event),
    });
    expect(retryEvents.at(-1)?.type).toBe("done");
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBe(metadata.sessionId);
    expect(JSON.parse(readFileSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-max-turns"),
      "utf8",
    ))).toMatchObject({ ownerTurnCount: 2, messageCount: 8 });
  });

  it("does not publish an invalid session id from a terminal SDK result", async () => {
    const invalidSessionId = "x".repeat(513);
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          state.queries === 1
            ? [errorResultMessage(invalidSessionId, "error_during_execution", 1)]
            : responseMessages(sessionId, "Recovered after invalid metadata."),
          state,
          input.prompt,
        );
      },
    });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-invalid-result-session",
      prompt: "hello",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      errorMessage: expect.stringContaining("invalid session id"),
    });
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-invalid-result-session",
    ))).toBe(false);
    expect(lifecycle.closed).toBe(1);

    await host!.runTurn("casper", {
      sessionId: "conversation-invalid-result-session",
      prompt: "start cleanly",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBeUndefined();
    expect(seenOptions[1]?.sessionId).toEqual(expect.any(String));
  });

  it("does not submit a prompt when its durable resume fence cannot be written", async () => {
    const { paths, lifecycle, seenOptions, seenPrompts } = setupClaudeHost();
    mkdirSync(paths.sessionDir, { recursive: true });
    chmodSync(paths.sessionDir, 0o500);
    const failedEvents: PiMessagesEvent[] = [];
    try {
      await host!.runTurn("casper", {
        sessionId: "conversation-metadata-write-failure",
        prompt: "this result cannot settle",
        emit: (event) => failedEvents.push(event),
      });
    } finally {
      chmodSync(paths.sessionDir, 0o700);
    }

    expect(failedEvents.at(-1)).toMatchObject({ type: "error" });
    expect(lifecycle).toMatchObject({ queries: 1, closed: 1 });
    expect(seenPrompts).toEqual([]);
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-metadata-write-failure",
    ))).toBe(false);

    const retryEvents: PiMessagesEvent[] = [];
    await host!.runTurn("casper", {
      sessionId: "conversation-metadata-write-failure",
      prompt: "retry from durable state",
      emit: (event) => retryEvents.push(event),
    });
    expect(retryEvents.at(-1)?.type).toBe("done");
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBeUndefined();
  });

  it("preserves history but cold-restarts after an existing sidecar cannot advance", async () => {
    let prompted = 0;
    let sessionDir = "";
    const { paths, lifecycle, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          responseMessages(sessionId, "durable turn"),
          state,
          input.prompt,
          () => {
            prompted += 1;
            if (prompted === 2) chmodSync(sessionDir, 0o500);
          },
        );
      },
    });
    sessionDir = paths.sessionDir;
    const sidecar = claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-existing-write-failure",
    );

    await host!.runTurn("casper", {
      sessionId: "conversation-existing-write-failure",
      prompt: "first durable turn",
      emit: () => {},
    });
    const first = JSON.parse(readFileSync(sidecar, "utf8")) as {
      sessionId: string;
    };

    const failedEvents: PiMessagesEvent[] = [];
    try {
      await host!.runTurn("casper", {
        sessionId: "conversation-existing-write-failure",
        prompt: "advance while the final write fails",
        emit: (event) => failedEvents.push(event),
      });
    } finally {
      chmodSync(paths.sessionDir, 0o700);
    }

    expect(failedEvents.at(-1)).toMatchObject({ type: "error" });
    expect(lifecycle).toMatchObject({ queries: 1, closed: 1 });
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 3,
      sessionId: first.sessionId,
      ownerTurnCount: 1,
      messageCount: 2,
    });
    expect(existsSync(`${sidecar}.started`)).toBe(true);
    expect((await host!.listSessions("casper")).find((row) =>
      row.id === "claude-code:conversation-existing-write-failure"))
      .toMatchObject({ messageCount: 2 });

    await host!.runTurn("casper", {
      sessionId: "conversation-existing-write-failure",
      prompt: "restart cold without losing durable history",
      emit: () => {},
    });
    expect(seenOptions[1]?.resume).toBeUndefined();
    expect(seenOptions[1]?.sessionId).not.toBe(first.sessionId);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 3,
      sessionId: seenOptions[1]?.sessionId,
      ownerTurnCount: 2,
      messageCount: 4,
    });
    expect(existsSync(`${sidecar}.started`)).toBe(false);
  });

  it("recovers an exact settling candidate before resuming another turn", async () => {
    const { paths, seenOptions } = setupClaudeHost();
    const conversationId = "conversation-settling-recovery";
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, conversationId);
    await host!.runTurn("casper", {
      sessionId: conversationId,
      prompt: "publish the first result",
      emit: () => {},
    });
    await host!.close("casper", conversationId);
    const first = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    const settling = {
      ...first,
      sessionId: "recovered-sdk-session",
      modified: "2026-08-30T12:00:00.000Z",
      messageCount: 4,
      ownerTurnCount: 2,
    };
    writeFileSync(`${sidecar}.started`, `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId,
    })}\n`, { mode: 0o600 });
    writeFileSync(`${sidecar}.settling`, `${JSON.stringify(settling)}\n`, { mode: 0o600 });

    await host!.runTurn("casper", {
      sessionId: conversationId,
      prompt: "continue after recovery",
      emit: () => {},
    });

    expect(seenOptions[1]?.resume).toBe("recovered-sdk-session");
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      sessionId: "recovered-sdk-session",
      messageCount: 6,
      ownerTurnCount: 3,
    });
    expect(existsSync(`${sidecar}.started`)).toBe(false);
    expect(existsSync(`${sidecar}.settling`)).toBe(false);
  });

  it("rejects the exact terminal emit failure and resumes cold afterward", async () => {
    const failure = new Error("terminal stream consumer failed");
    const { paths, lifecycle, seenOptions } = setupClaudeHost();
    const first = host!.runTurn("casper", {
      sessionId: "conversation-terminal-emit-failure",
      prompt: "settle before terminal delivery",
      emit: (event) => {
        if (event.type === "done") throw failure;
      },
    });

    await expect(first).rejects.toBe(failure);
    expect(lifecycle).toMatchObject({ queries: 1, closed: 1 });
    const metadata = JSON.parse(readFileSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-terminal-emit-failure",
    ), "utf8")) as { sessionId: string };

    await host!.runTurn("casper", {
      sessionId: "conversation-terminal-emit-failure",
      prompt: "resume from the durable result",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(2);
    expect(seenOptions[1]?.resume).toBe(metadata.sessionId);
  });

  it("fences resume while preserving persisted counts when the SDK fails before a result", async () => {
    const { paths, lifecycle } = setupClaudeHost({
      createQuery: (_input, state) => fakeQuery([], state, (async function* fail() {
        throw new Error("simulated process failure");
        // biome-ignore lint/correctness/noUnreachable: shapes the generator type.
        yield undefined as unknown as SDKUserMessage;
      })()),
    });
    const sidecar = claudeSessionMetadataPath(paths.sessionDir, "conversation-process-failure");
    mkdirSync(paths.sessionDir, { recursive: true });
    const original = `${JSON.stringify({
      version: 1,
      runtime: "claude-code",
      conversationId: "conversation-process-failure",
      sessionId: "existing-sdk-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 8,
      ownerTurnCount: 3,
    }, null, 2)}\n`;
    writeFileSync(sidecar, original, { mode: 0o600 });
    const events: PiMessagesEvent[] = [];

    await host!.runTurn("casper", {
      sessionId: "conversation-process-failure",
      prompt: "retry",
      emit: (event) => events.push(event),
    });

    expect(lifecycle.queries).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: expect.stringContaining("message stream failed"),
    });
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({
      version: 1,
      sessionId: "existing-sdk-session",
      messageCount: 8,
      ownerTurnCount: 3,
    });
    expect(existsSync(`${sidecar}.started`)).toBe(true);
  });

  it("does not start a query for an already-aborted turn", async () => {
    const { lifecycle, seenOptions } = setupClaudeHost();
    const controller = new AbortController();
    const events: PiMessagesEvent[] = [];
    controller.abort();

    await host!.runTurn("casper", {
      sessionId: "conversation-1",
      prompt: "hello",
      signal: controller.signal,
      emit: (event) => events.push(event),
    });

    expect(lifecycle).toMatchObject({ queries: 0, interrupted: 0, closed: 0 });
    expect(seenOptions).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("uses authoritative SDK abort and close during cancellation", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { lifecycle, paths, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const stream = (async function* () {
          markStarted();
          await new Promise<void>((resolve) => {
            input.options.abortController?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        })();
        return Object.assign(stream, {
          interrupt: async () => {
            state.interrupted += 1;
            throw new Error("cancellation must not send a control request");
          },
          close: () => {
            state.closed += 1;
          },
        }) as unknown as Query;
      },
    });
    const controller = new AbortController();
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-wedged",
      prompt: "hello",
      signal: controller.signal,
      emit: (event) => events.push(event),
    });
    await started;

    controller.abort();
    await turn;

    expect(seenOptions[0]?.abortController?.signal.aborted).toBe(true);
    expect(lifecycle.interrupted).toBe(0);
    expect(lifecycle.closed).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(existsSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-wedged"),
    )).toBe(false);
    // An aborted turn never settled, so nothing may enter the journal.
    expect(existsSync(
      presentationHistoryPath(paths.sessionDir, "claude-code", "conversation-wedged"),
    )).toBe(false);
  });

  it("force-closes an active query without requesting over its closed transport", async () => {
    const started = Promise.withResolvers<void>();
    const order: string[] = [];
    let transportClosed = false;
    const { lifecycle } = setupClaudeHost({
      createQuery: (input, state) => {
        const stream = (async function* () {
          started.resolve();
          await new Promise<void>((resolve) => {
            input.options.abortController?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        })();
        return Object.assign(stream, {
          interrupt: async () => {
            if (transportClosed) throw new Error("SDK control transport is closed");
            state.interrupted += 1;
            order.push("interrupt");
          },
          close: () => {
            if (transportClosed) return;
            transportClosed = true;
            state.closed += 1;
            order.push("close");
          },
        }) as unknown as Query;
      },
    });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-active-close",
      prompt: "keep running",
      emit: (event) => events.push(event),
    });
    await started.promise;

    await Promise.all([host!.close("casper", "conversation-active-close"), turn]);

    expect(order).toEqual(["close"]);
    expect(lifecycle).toMatchObject({ interrupted: 0, closed: 1 });
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("quiesces Claude, the browser, and schedules before moving a ghost home", async () => {
    const processExit = Promise.withResolvers<void>();
    const cleanupOrder: string[] = [];
    const expectHomeUnmoved = () => {
      expect(existsSync(join(temp!.root, "casper"))).toBe(true);
      expect(existsSync(join(temp!.root, "wisp"))).toBe(false);
    };
    const { lifecycle } = setupClaudeHost({
      useSdkSpawnExitBoundary: true,
      browserSessionClose: async () => {
        expectHomeUnmoved();
        cleanupOrder.push("browser");
      },
      scheduleCommandRunner: async (args) => {
        expectHomeUnmoved();
        cleanupOrder.push(`schedule:${args[1]}`);
        return { stdout: "", stderr: "", code: 0 };
      },
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        const spawnProcess = input.options.spawnClaudeCodeProcess;
        if (!spawnProcess) throw new Error("SDK spawn exit boundary was not installed");
        const child = spawnProcess({
          command: process.execPath,
          args: [
            "-e",
            "process.stdin.resume(); process.stdin.once('end', () => "
              + "setTimeout(() => process.exit(0), 80));",
          ],
          cwd: temp!.ownerHome,
          env: { ...process.env },
          signal: new AbortController().signal,
        });
        child.once("exit", () => {
          cleanupOrder.push("claude-exit");
          processExit.resolve();
        });
        const stream = (async function* () {
          for (const message of responseMessages(sessionId, "ready to close")) yield message;
        })();
        let closed = false;
        return Object.assign(stream, {
          interrupt: async () => {},
          close: () => {
            if (closed) return;
            closed = true;
            state.closed += 1;
            child.stdin.end();
          },
        }) as unknown as Query;
      },
    });
    await host!.runTurn("casper", {
      sessionId: "conversation-delayed-process-exit",
      prompt: "start the subprocess",
      emit: () => {},
    });

    const renaming = host!.renameGhost("casper", "wisp").then(() => {
      cleanupOrder.push("move");
    });
    await vi.waitFor(() => expect(lifecycle.closed).toBe(1));
    await processExit.promise;
    await renaming;
    expect(cleanupOrder.slice(0, 2)).toEqual(["claude-exit", "browser"]);
    expect(cleanupOrder.slice(2, -1).every((entry) => entry.startsWith("schedule:")))
      .toBe(true);
    expect(cleanupOrder).toContain("schedule:list-units");
    expect(cleanupOrder.at(-1)).toBe("move");
    expect(temp!.registry.list().map((ghost) => ghost.name)).toContain("wisp");
  });

  it.each([".js", ".mjs", ".tsx", ".ts", ".jsx"])(
    "uses the pinned SDK's exact Bun transform for a principal %s script",
    async (suffix) => {
      let script = "";
      let marker = "";
      setupClaudeHost({
        prepare: (fixture) => {
          script = join(fixture.ownerHome, `principal-claude${suffix}`);
          marker = join(fixture.ownerHome, `principal-claude${suffix}.started`);
          writeFileSync(script, "await Bun.write(process.env.MARKER, 'started'); setInterval(() => {}, 1000);", {
            mode: 0o700,
          });
        },
        get binaryPath() { return script; },
        useSdkSpawnExitBoundary: true,
        createQuery: (input, state) => {
          const sessionId = input.options.sessionId ?? input.options.resume;
          if (!sessionId) throw new Error("test query received no session id");
          const spawnProcess = input.options.spawnClaudeCodeProcess;
          if (!spawnProcess) throw new Error("SDK spawn boundary was not installed");
          spawnProcess({
            command: "bun",
            args: [script, "--sdk-native"],
            cwd: temp!.ownerHome,
            env: { HOME: temp!.ownerHome, PATH: "/usr/bin:/bin", MARKER: marker },
            signal: input.options.abortController!.signal,
          });
          return fakeQuery(
            responseMessages(sessionId, "principal script started"),
            state,
            input.prompt,
          );
        },
      });

      await host!.runTurn("casper", {
        sessionId: `principal-script-${suffix.slice(1)}`,
        prompt: "start",
        emit: () => {},
      });
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      await host!.close("casper", `principal-script-${suffix.slice(1)}`);
    },
  );

  it("TERM-cleans the native CLI and KILLs an orphan-resistant Bash descendant", async () => {
    let wrapper = "";
    let pids = "";
    let cleanup = "";
    const { lifecycle } = setupClaudeHost({
      prepare: (fixture) => {
        wrapper = join(fixture.ownerHome, "claude-owned-wrapper");
        const native = join(fixture.ownerHome, "claude-owned-native");
        pids = join(fixture.ownerHome, "claude-owned-pids");
        cleanup = join(fixture.ownerHome, "claude-owned-cleanup");
        writeFileSync(wrapper, `#!/bin/sh\nexec '${native}' "$@"\n`, { mode: 0o700 });
        writeFileSync(
          native,
          `#!/bin/sh
trap 'printf normal-cleanup > "${cleanup}"; exit 0' TERM
/bin/sh -c 'trap "" TERM; while :; do /bin/sleep 10; done' &
descendant=$!
printf '%s %s' "$$" "$descendant" > "${pids}"
while :; do /bin/sleep 10; done
`,
          { mode: 0o700 },
        );
      },
      useSdkSpawnExitBoundary: true,
      get binaryPath() { return wrapper; },
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        const spawnProcess = input.options.spawnClaudeCodeProcess;
        if (!spawnProcess) throw new Error("SDK process-group boundary was not installed");
        spawnProcess({
          command: wrapper,
          args: [],
          cwd: temp!.ownerHome,
          env: { HOME: temp!.ownerHome, PATH: "/usr/bin:/bin" },
          signal: input.options.abortController!.signal,
        });
        return fakeQuery(
          responseMessages(sessionId, "owned group is running"),
          state,
          input.prompt,
        );
      },
    });
    await host!.runTurn("casper", {
      sessionId: "owned-process-group",
      prompt: "start native work",
      emit: () => {},
    });
    await vi.waitFor(() => expect(existsSync(pids)).toBe(true));
    const ghostdPid = process.pid;
    const started = Date.now();

    await host!.close("casper", "owned-process-group");

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(readFileSync(cleanup, "utf8")).toBe("normal-cleanup");
    await expectPidsGone(pids);
    expect(pidExists(ghostdPid)).toBe(true);
    expect(lifecycle.closed).toBe(1);
  });

  it("fails a home move with a retryable type when SDK exit remains unconfirmed", async () => {
    const processExit = Promise.withResolvers<void>();
    setupClaudeHost({
      exitWaitTimeoutMs: 20,
      createQuery: (input, state) => {
        const sessionId = input.options.sessionId ?? input.options.resume;
        if (!sessionId) throw new Error("test query received no session id");
        return fakeQuery(
          responseMessages(sessionId, "ready to close"),
          state,
          input.prompt,
          undefined,
          processExit,
          false,
        );
      },
    });
    await host!.runTurn("casper", {
      sessionId: "conversation-exit-timeout",
      prompt: "start the subprocess",
      emit: () => {},
    });

    await expect(host!.renameGhost("casper", "wisp")).rejects.toMatchObject({
      code: "claude_code_exit_unconfirmed",
      status: 503,
    });
    expect(temp!.registry.list().map((ghost) => ghost.name)).toContain("casper");

    processExit.resolve();
    await expect(host!.renameGhost("casper", "wisp"))
      .resolves.toMatchObject({ name: "wisp" });
  });

  it("aborts and drains a pre-query turn before close can return", async () => {
    const probeStarted = Promise.withResolvers<void>();
    const releaseProbe = Promise.withResolvers<void>();
    const probe = new ClaudeCodeProbe({
      binaryPath: "configured-claude",
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => {
        probeStarted.resolve();
        await releaseProbe.promise;
        return process.execPath;
      },
      readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai" }),
    });
    const { lifecycle, paths, seenOptions } = setupClaudeHost({ probe });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-close-during-probe",
      prompt: "do not resurrect this turn",
      emit: (event) => events.push(event),
    });
    await probeStarted.promise;
    writeFileSync(
      join(paths.home, "character.md"),
      "# Casper\n\nYou are Casper, now a bookbinder.\n",
      "utf8",
    );

    let closeSettled = false;
    const closing = host!.close("casper", "conversation-close-during-probe").then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseProbe.resolve();
    await Promise.all([closing, turn]);

    expect(closeSettled).toBe(true);
    expect(lifecycle).toMatchObject({ queries: 0, closed: 0 });
    expect(seenOptions).toEqual([]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(existsSync(claudeSessionMetadataPath(
      paths.sessionDir,
      "conversation-close-during-probe",
    ))).toBe(false);
    const settledEvents = [...events];
    await Promise.resolve();
    expect(events).toEqual(settledEvents);

    await host!.runTurn("casper", {
      sessionId: "conversation-close-during-probe",
      prompt: "start after the closed turn",
      emit: () => {},
    });
    expect(lifecycle.queries).toBe(1);
    expect(JSON.stringify(seenOptions[0]?.systemPrompt)).toContain("bookbinder");
  });

  it("does not admit a query whose auth probe settles after daemon disposal", async () => {
    const probeStarted = Promise.withResolvers<void>();
    const releaseProbe = Promise.withResolvers<void>();
    let authReads = 0;
    const probe = new ClaudeCodeProbe({
      binaryPath: "configured-claude",
      readVersion: readSupportedClaudeVersion,
      resolveExecutable: async () => {
        probeStarted.resolve();
        await releaseProbe.promise;
        return process.execPath;
      },
      readAuthStatus: async () => {
        authReads += 1;
        return { loggedIn: true, authMethod: "claude.ai" };
      },
    });
    const { lifecycle, paths } = setupClaudeHost({ probe });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-held-probe",
      prompt: "hello",
      emit: (event) => events.push(event),
    });
    await probeStarted.promise;

    let disposed = false;
    const disposal = host!.disposeAll().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    releaseProbe.resolve();
    await Promise.all([disposal, turn]);
    expect(disposed).toBe(true);

    expect(authReads).toBe(1);
    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
      errorMessage: "The daemon is shutting down.",
    });
    expect(existsSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-held-probe"),
    )).toBe(false);
  });

  it("aborts and drains a turn held in pre-query hook preparation", async () => {
    const hooks = new GhostHookRunner();
    const hookStarted = Promise.withResolvers<void>();
    let hookAborted = false;
    await hooks.register((api) => {
      api.on("before_prompt", async (event) => {
        hookStarted.resolve();
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            hookAborted = true;
            resolve();
          };
          if (event.signal.aborted) onAbort();
          else event.signal.addEventListener("abort", onAbort, { once: true });
        });
      });
    });
    const { lifecycle, paths } = setupClaudeHost({ hooks });
    const events: PiMessagesEvent[] = [];
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-held-hook",
      prompt: "hello",
      emit: (event) => events.push(event),
    });
    await hookStarted.promise;

    await Promise.all([host!.disposeAll(), turn]);

    expect(hookAborted).toBe(true);
    expect(lifecycle.queries).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
      errorMessage: "The daemon is shutting down.",
    });
    expect(existsSync(
      claudeSessionMetadataPath(paths.sessionDir, "conversation-held-hook"),
    )).toBe(false);
  });

  it("aborts the SDK controller while shutting down an active query", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { lifecycle, seenOptions } = setupClaudeHost({
      createQuery: (input, state) => {
        const stream = (async function* () {
          markStarted();
          await new Promise<void>((resolve) => {
            input.options.abortController?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        })();
        return Object.assign(stream, {
          interrupt: async () => {
            state.interrupted += 1;
          },
          close: () => {
            state.closed += 1;
          },
        }) as unknown as Query;
      },
    });
    const turn = host!.runTurn("casper", {
      sessionId: "conversation-shutdown",
      prompt: "hello",
      emit: () => {},
    });
    await started;

    await host!.disposeAll();
    await turn;

    expect(seenOptions[0]?.abortController?.signal.aborted).toBe(true);
    expect(lifecycle.interrupted).toBe(0);
    expect(lifecycle.closed).toBeGreaterThanOrEqual(1);
  });
});

describe("claudeSdkTranscriptPath", () => {
  it("locates the SDK session transcript by id under the config projects tree", () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-claude-config-"));
    try {
      const projectDir = join(root, "projects", "-home-me-project");
      mkdirSync(projectDir, { recursive: true });
      const transcript = join(projectDir, "0123abcd-session.jsonl");
      writeFileSync(transcript, "");
      const homeProjectDir = join(root, ".claude", "projects", "-home-me-project");
      mkdirSync(homeProjectDir, { recursive: true });
      const homeTranscript = join(homeProjectDir, "home-session.jsonl");
      writeFileSync(homeTranscript, "");
      const env = { CLAUDE_CONFIG_DIR: root };
      expect(claudeSdkTranscriptPath("0123abcd-session", env)).toBe(transcript);
      expect(claudeSdkTranscriptPath("home-session", { HOME: root })).toBe(homeTranscript);
      expect(claudeSdkTranscriptPath("missing-session", env)).toBeUndefined();
      expect(claudeSdkTranscriptPath("../escape", env)).toBeUndefined();
      expect(claudeSdkTranscriptPath("0123abcd-session", {
        CLAUDE_CONFIG_DIR: join(root, "nope"),
      })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
