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
import type {
  Options as ClaudeQueryOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeAgentSdkLoader,
  type ClaudeAgentSdkModule,
} from "../src/claude-agent-sdk-loader.js";
import { ClaudeTaskAdapter } from "../src/claude-task-adapter.js";
import type { NativeHarnessProbeResult } from "../src/native-harness-catalog.js";
import type {
  TaskAdapterContext,
  TaskAdapterControl,
  TaskBindingReceipt,
} from "../src/tasks.js";
import { directTaskScope } from "./helpers/task-scope.js";

const roots: string[] = [];
const binding: TaskBindingReceipt = {
  version: 1,
  root: "/project",
  rootIdentity: "1:2",
  cwd: "/project/exact",
  cwdIdentity: "1:3",
  generation: 1,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class StubSdkLoader extends ClaudeAgentSdkLoader {
  constructor(private readonly loadSdk: (signal?: AbortSignal) => Promise<ClaudeAgentSdkModule>) {
    super({ ownerHome: "/tmp" });
  }

  override load(signal?: AbortSignal): Promise<ClaudeAgentSdkModule> {
    return this.loadSdk(signal);
  }
}

function fakeClaude(resistant = false) {
  const root = mkdtempSync(join(tmpdir(), "ghost-claude-task-"));
  roots.push(root);
  const path = join(root, "claude");
  const log = join(root, "spawn.json");
  const pids = join(root, "pids");
  writeFileSync(path, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
writeFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), env: process.env,
}));
if (${JSON.stringify(resistant)}) {
  process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(pids)}, process.pid + " " + child.pid);
}
setInterval(() => {}, 1000);
`);
  chmodSync(path, 0o700);
  return { root, path, log, pids };
}

function probe(path: string): NativeHarnessProbeResult {
  return {
    id: "claude-code",
    executable: { path, identity: "1:2:3", literalBoundary: true },
    version: "2.1.251",
    authentication: "authenticated",
    runtimeIdentity: "runtime",
  };
}

type SdkMode = "complete" | "followup" | "wrong-cwd" | "wrong-spawn" | "error" | "blocked";

function fakeSdk(input: {
  mode: SdkMode;
  executable: string;
  cwd: string;
  capturedOptions: ClaudeQueryOptions[];
  messages: SDKUserMessage[];
  interrupts: { count: number };
}): ClaudeAgentSdkModule {
  return {
    query: (({ prompt, options }: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      options?: ClaudeQueryOptions;
    }) => {
      if (typeof prompt === "string" || !options?.spawnClaudeCodeProcess) {
        throw new Error("invalid fake invocation");
      }
      input.capturedOptions.push(options);
      const closed = deferred<void>();
      const iterator = prompt[Symbol.asyncIterator]();
      const run = async function* (): AsyncGenerator<SDKMessage> {
        options.spawnClaudeCodeProcess?.({
          command: input.executable,
          args: ["--sdk-native"],
          cwd: input.mode === "wrong-spawn" ? "/wrong" : input.cwd,
          env: options.env ?? {},
          signal: options.abortController?.signal ?? new AbortController().signal,
        });
        const spawnRecord = join(input.cwd, "spawn.json");
        for (let attempt = 0; attempt < 200 && !existsSync(spawnRecord); attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        if (!existsSync(spawnRecord)) throw new Error("fake Claude process did not start");
        const first = await iterator.next();
        if (first.done) throw new Error("missing initial message");
        input.messages.push(first.value);
        yield {
          type: "system",
          subtype: "init",
          cwd: input.mode === "wrong-cwd" ? "/wrong" : input.cwd,
          permissionMode: "bypassPermissions",
          session_id: "claude-native-session",
        } as SDKMessage;
        if (input.mode === "wrong-cwd") {
          await closed.promise;
          return;
        }
        if (input.mode === "followup") {
          const second = await Promise.race([
            iterator.next(),
            closed.promise.then(() => ({ done: true, value: undefined }) as const),
          ]);
          if (second.done) return;
          input.messages.push(second.value);
        } else if (input.mode === "blocked") {
          await closed.promise;
          return;
        }
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_use", id: "tool", name: "Bash", input: { secret: "raw-tool-secret" } }] },
          session_id: "claude-native-session",
        } as SDKMessage;
        if (input.mode === "error") {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["raw-provider-secret"],
            session_id: "claude-native-session",
          } as SDKMessage;
          return;
        }
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "safe answer",
          session_id: "claude-native-session",
        } as SDKMessage;
      };
      const query = run() as Query;
      Object.assign(query, {
        async interrupt() { input.interrupts.count += 1; },
        close() { closed.resolve(); },
      });
      return query;
    }) as ClaudeAgentSdkModule["query"],
    createSdkMcpServer: (() => { throw new Error("unused"); }) as ClaudeAgentSdkModule["createSdkMcpServer"],
    tool: (() => { throw new Error("unused"); }) as ClaudeAgentSdkModule["tool"],
  };
}

function taskContext(): {
  context: TaskAdapterContext;
  control(): TaskAdapterControl;
} {
  const controller = new AbortController();
  let registered: TaskAdapterControl | undefined;
  return {
    context: {
      signal: controller.signal,
      scope: directTaskScope(),
      register(control) { registered = control; },
      async emit() {},
    },
    control() {
      if (!registered) throw new Error("missing control");
      return registered;
    },
  };
}

function harness(
  mode: SdkMode,
  resistant = false,
) {
  const fake = fakeClaude(resistant);
  const capturedOptions: ClaudeQueryOptions[] = [];
  const messages: SDKUserMessage[] = [];
  const interrupts = { count: 0 };
  const sdk = fakeSdk({
    mode,
    executable: fake.path,
    cwd: fake.root,
    capturedOptions,
    messages,
    interrupts,
  });
  const loader = new StubSdkLoader(async () => sdk);
  const adapter = new ClaudeTaskAdapter({
    catalog: { async readForStart(id: "claude-code", signal: AbortSignal) {
      expect(id).toBe("claude-code"); expect(signal).toBeInstanceOf(AbortSignal); return probe(fake.path);
    } },
    sdkLoader: loader,
    environment: {
      PATH: process.env.PATH,
      HOME: fake.root,
      ANTHROPIC_CONFIG_DIR: join(fake.root, "claude-home"),
      ANTHROPIC_API_KEY: "must-not-cross",
      SECRET_SENTINEL: "must-not-cross",
    },
  });
  return { adapter, fake, capturedOptions, messages, interrupts };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return !["Z", "X"].includes(stat.slice(close + 2, close + 3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("missing pid file");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("Claude delegated task adapter", () => {
  it("uses only native defaults plus bypass mode and passes an opaque agent unchanged", async () => {
    const opaqueAgent = "owner-defined-agent";
    const fixture = harness("complete");
    const context = taskContext();
    const handle = await fixture.adapter.start({
      id: "task-1", task: "do the work", agent: opaqueAgent, cwd: fixture.fake.root, binding,
    }, context.context);
    await expect(handle.result).resolves.toBe("safe answer");

    const options = fixture.capturedOptions[0] as ClaudeQueryOptions;
    expect(options).toMatchObject({
      cwd: fixture.fake.root,
      pathToClaudeCodeExecutable: fixture.fake.path,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      agent: opaqueAgent,
    });
    for (const policy of [
      "settingSources", "systemPrompt", "tools", "skills", "agents", "mcpServers",
      "allowedTools", "disallowedTools", "canUseTool", "model", "extraArgs",
    ]) expect(options).not.toHaveProperty(policy);
    expect(options.env?.ANTHROPIC_CONFIG_DIR).toBe(join(fixture.fake.root, "claude-home"));
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.SECRET_SENTINEL).toBeUndefined();
    expect(fixture.messages[0]?.priority).toBe("now");
    const spawned = JSON.parse(readFileSync(fixture.fake.log, "utf8"));
    expect(spawned).toMatchObject({ args: ["--sdk-native"], cwd: fixture.fake.root });
  });

  it("delivers a follow-up through the native priority-now stream", async () => {
    const fixture = harness("followup");
    const context = taskContext();
    const handle = await fixture.adapter.start({
      id: "task-2", task: "start", cwd: fixture.fake.root, binding,
    }, context.context);
    await handle.followUp("change direction");
    await expect(handle.result).resolves.toBe("safe answer");
    expect(fixture.messages.map((message) => ({
      priority: message.priority,
      text: (message.message.content[0] as { text: string }).text,
    }))).toEqual([
      { priority: "now", text: "start" },
      { priority: "now", text: "change direction" },
    ]);
  });

  it("fails generically on a cwd mismatch or provider error without raw detail", async () => {
    for (const mode of ["wrong-cwd", "wrong-spawn", "error"] as const) {
      const fixture = harness(mode);
      const context = taskContext();
      let thrown: unknown;
      try {
        const handle = await fixture.adapter.start({
          id: "task-3", task: "start", cwd: fixture.fake.root, binding,
        }, context.context);
        await handle.result;
      } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({ message: "Claude delegated task failed." });
      expect(String((thrown as Error).message)).not.toContain("raw-provider-secret");
      expect(String((thrown as Error).message)).not.toContain("raw-tool-secret");
      await context.control().quiescence;
    }
  });

  it("fences an SDK loader that resolves after cancellation before native spawn", async () => {
    const fake = fakeClaude();
    const context = taskContext();
    let loaderSignal: AbortSignal | undefined;
    const capturedOptions: ClaudeQueryOptions[] = [];
    const sdk = fakeSdk({
      mode: "complete",
      executable: fake.path,
      cwd: fake.root,
      capturedOptions,
      messages: [],
      interrupts: { count: 0 },
    });
    const release = deferred<ClaudeAgentSdkModule>();
    const loader = new StubSdkLoader((signal) => {
      loaderSignal = signal;
      return release.promise;
    });
    const adapter = new ClaudeTaskAdapter({
      catalog: { async readForStart() { return probe(fake.path); } },
      sdkLoader: loader,
      environment: { PATH: process.env.PATH, HOME: fake.root },
    });
    const starting = adapter.start({
      id: "task-4", task: "start", cwd: fake.root, binding,
    }, context.context);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await context.control().force();
    release.resolve(sdk);
    await expect(starting).rejects.toMatchObject({ message: "Claude delegated task failed." });
    expect(loaderSignal?.aborted).toBe(true);
    expect(existsSync(fake.log)).toBe(false);
    expect(capturedOptions).toEqual([]);
  });

  it("interrupts and quiesces a resistant SDK-owned process group", async () => {
    const fixture = harness("blocked", true);
    const context = taskContext();
    const handle = await fixture.adapter.start({
      id: "task-5", task: "start", cwd: fixture.fake.root, binding,
    }, context.context);
    void handle.result.catch(() => undefined);
    await waitForFile(fixture.fake.pids);
    await context.control().force();
    await context.control().quiescence;
    const pids = readFileSync(fixture.fake.pids, "utf8").split(/\s+/u).map(Number);
    expect(pids.filter(pidExists)).toEqual([]);
    expect(fixture.interrupts.count).toBe(1);
  });
});
