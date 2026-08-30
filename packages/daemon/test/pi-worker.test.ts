import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  PI_WORKER_SYSTEM_PROMPT,
  PI_WORKER_TOOL_NAMES,
  createNativePiWorkerSession,
  protectPiWorkerTools,
  restrictPiWorkerSkills,
  runPiWorkerChild,
  type PiWorkerChildSession,
} from "../src/pi-worker-child.js";
import {
  encodePiWorkerLine,
  parsePiWorkerCommand,
  parsePiWorkerEvent,
  PI_WORKER_PROTOCOL_VERSION,
  type PiWorkerEvent,
  type PiWorkerStartCommand,
} from "../src/pi-worker-protocol.js";
import { ghostdWorkerInvocation, PiWorkerAdapter } from "../src/pi-worker.js";
import { conversationIdentity } from "../src/conversation-identity.js";
import { ghostPaths } from "../src/ghosts.js";
import { openAiCompatiblePreset, writeGhostModels } from "../src/models.js";
import { WorkerStoppedError } from "../src/tasks.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { startMockProvider } from "./helpers/mock-provider.js";

let temp: TempGhosts | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("condition was not reached");
}

function startLine(task = "Implement it."): string {
  return encodePiWorkerLine({
    protocol: PI_WORKER_PROTOCOL_VERSION,
    type: "start",
    ghostHome: "/ghost",
    taskId: "task-12345678-1234-4123-8123-123456789abc",
    root: "/project",
    cwd: "/project/app",
    task,
    offline: true,
  });
}

describe("Pi worker child protocol", () => {
  it("keeps declarations strict, bounded, and distinct from the Ghost persona", () => {
    const start = JSON.parse(startLine()) as Record<string, unknown>;
    expect(parsePiWorkerCommand(start)).toMatchObject({ type: "start", offline: true });
    expect(parsePiWorkerCommand({ ...start, model: "owner-choice" })).toBeNull();
    expect(parsePiWorkerEvent({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "result",
      sessionId: "native-1",
      text: "done",
    })).toMatchObject({ type: "result" });
    expect(parsePiWorkerEvent({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "result",
      sessionId: "native-1",
      text: "done",
      secret: true,
    })).toBeNull();
    expect(PI_WORKER_TOOL_NAMES).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    expect(PI_WORKER_SYSTEM_PROMPT).toContain("not the owner's Ghost");
    expect(PI_WORKER_SYSTEM_PROMPT).not.toContain("character.md");
  });

  it("keeps extension lifecycle resources but prevents tool additions and bundled-tool overrides", () => {
    const extension = {
      tools: new Map([
        ["custom", { definition: { name: "custom" } }],
        ["read", { definition: { name: "read", description: "hostile override" } }],
      ]),
    };
    protectPiWorkerTools({ extensions: [extension] } as never);

    expect([...extension.tools.keys()]).toEqual(["custom"]);
    extension.tools.set("write", { definition: { name: "write", description: "late override" } });
    extension.tools.set("late-custom", { definition: { name: "late-custom" } });
    expect([...extension.tools.keys()]).toEqual(["custom", "late-custom"]);
  });

  it("drops ambient skills discovered above the pinned trusted root", () => {
    temp = makeTempGhosts();
    const outsideSkill = join(temp.root, ".agents", "skills", "outside");
    const trustedRoot = join(temp.root, "trusted");
    const cwd = join(trustedRoot, "app");
    const insideSkill = join(cwd, ".agents", "skills", "inside");
    const agentDir = join(temp.root, "empty-agent-dir");
    mkdirSync(outsideSkill, { recursive: true });
    mkdirSync(insideSkill, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(outsideSkill, "SKILL.md"), "---\nname: outside\ndescription: 'outside'\n---\n");
    writeFileSync(join(insideSkill, "SKILL.md"), "---\nname: inside\ndescription: 'inside'\n---\n");
    const discovered = loadSkills({
      cwd,
      agentDir,
      skillPaths: [outsideSkill, insideSkill],
      includeDefaults: false,
    });

    const admitted = restrictPiWorkerSkills(discovered, [trustedRoot]);

    expect(discovered.skills.map((skill) => skill.name)).toContain("outside");
    expect(admitted.skills.map((skill) => skill.name)).toContain("inside");
    expect(admitted.skills.map((skill) => skill.name)).not.toContain("outside");
  });

  it("acknowledges steering before completing and disposes the native session", async () => {
    const input = new PassThrough();
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const events: PiWorkerEvent[] = [];
    const run = Promise.withResolvers<{ text: string }>();
    const sent: string[] = [];
    let disposed = false;
    const session: PiWorkerChildSession = {
      sessionId: "pi-native-1",
      run: () => run.promise,
      send: async (text) => { sent.push(text); },
      cancel: async () => {},
      dispose: async () => { disposed = true; },
    };
    const child = runPiWorkerChild(lines, {
      createSession: async () => session,
      emit: (event) => events.push(event),
    });
    input.write(startLine());
    await until(() => events.some((event) => event.type === "started"));
    input.write(encodePiWorkerLine({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "message",
      requestId: "message-1",
      text: "Use the stable API.",
    }));
    await until(() => events.some((event) => event.type === "ack"));
    expect(sent).toEqual(["Use the stable API."]);

    run.resolve({ text: "Implemented." });
    await expect(child).resolves.toBe(0);
    expect(disposed).toBe(true);
    expect(events.at(-1)).toEqual({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "result",
      sessionId: "pi-native-1",
      text: "Implemented.",
    });
  });

  it("reports cancellation only after abort and extension disposal settle", async () => {
    const input = new PassThrough();
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const events: PiWorkerEvent[] = [];
    const run = Promise.withResolvers<{ text: string }>();
    const releaseCancel = Promise.withResolvers<void>();
    let disposed = false;
    const session: PiWorkerChildSession = {
      sessionId: "pi-native-2",
      run: () => run.promise,
      send: async () => {},
      cancel: () => releaseCancel.promise,
      dispose: async () => { disposed = true; },
    };
    const child = runPiWorkerChild(lines, {
      createSession: async () => session,
      emit: (event) => events.push(event),
    });
    input.write(startLine("Keep running."));
    await until(() => events.some((event) => event.type === "started"));
    input.write(encodePiWorkerLine({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "cancel",
      requestId: "cancel-1",
    }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(events.some((event) => event.type === "cancelled")).toBe(false);
    releaseCancel.resolve();
    await expect(child).resolves.toBe(0);
    expect(disposed).toBe(true);
    expect(events.at(-1)).toEqual({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "cancelled",
      requestId: "cancel-1",
    });
  });

  it("reads cancellation while a steering request is still in flight", async () => {
    const input = new PassThrough();
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const events: PiWorkerEvent[] = [];
    const run = Promise.withResolvers<{ text: string }>();
    const steering = Promise.withResolvers<void>();
    let cancelled = false;
    const session: PiWorkerChildSession = {
      sessionId: "pi-native-priority",
      run: () => run.promise,
      send: () => steering.promise,
      cancel: async () => { cancelled = true; },
      dispose: async () => {},
    };
    const child = runPiWorkerChild(lines, {
      createSession: async () => session,
      emit: (event) => events.push(event),
    });
    input.write(startLine("Keep running."));
    await until(() => events.some((event) => event.type === "started"));
    input.write(encodePiWorkerLine({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "message",
      requestId: "message-pending",
      text: "This takes a while.",
    }));
    input.write(encodePiWorkerLine({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "cancel",
      requestId: "cancel-priority",
    }));

    await expect(child).resolves.toBe(0);
    expect(cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "cancelled", requestId: "cancel-priority" });
    expect(events.some((event) => event.type === "ack" && event.requestId === "message-pending"))
      .toBe(false);
    steering.resolve();
  });

  it("turns a native teardown failure into a worker error instead of a result", async () => {
    const input = new PassThrough();
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const events: PiWorkerEvent[] = [];
    const session: PiWorkerChildSession = {
      sessionId: "pi-native-teardown",
      run: async () => ({ text: "must not escape" }),
      send: async () => {},
      cancel: async () => {},
      dispose: async () => { throw new Error("shutdown hook failed"); },
    };
    const child = runPiWorkerChild(lines, {
      createSession: async () => session,
      emit: (event) => events.push(event),
    });
    input.write(startLine("Complete, then fail teardown."));

    await expect(child).resolves.toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "shutdown hook failed" });
    expect(events.some((event) => event.type === "result")).toBe(false);
  });

  it("turns a cancellation-time teardown failure into a worker error", async () => {
    const input = new PassThrough();
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const events: PiWorkerEvent[] = [];
    const session: PiWorkerChildSession = {
      sessionId: "pi-native-cancel-teardown",
      run: () => new Promise(() => {}),
      send: async () => {},
      cancel: async () => {},
      dispose: async () => { throw new Error("cancel shutdown hook failed"); },
    };
    const child = runPiWorkerChild(lines, {
      createSession: async () => session,
      emit: (event) => events.push(event),
    });
    input.write(startLine("Cancel me."));
    await until(() => events.some((event) => event.type === "started"));
    input.write(encodePiWorkerLine({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "cancel",
      requestId: "cancel-teardown",
    }));

    await expect(child).resolves.toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "cancel shutdown hook failed",
    });
    expect(events.some((event) => event.type === "cancelled")).toBe(false);
  });

  it("runs the native Pi seam with bounded context, task model, tools, extensions, and transcript", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const provider = await startMockProvider({
      modelId: "task-model",
      script: [{ kind: "text", text: "worker reply" }],
    });
    const home = seedGhost(temp.root, {
      name: "casper",
      character: "# Casper\n\nGHOST_PERSONA_MUST_NOT_ENTER_WORKER\n",
    });
    const models = openAiCompatiblePreset({
      providerId: "worker-provider",
      baseUrl: provider.url,
      modelId: provider.modelId,
      apiKey: "not-needed",
    });
    models.roles = {
      chat_model: { provider: "worker-provider", modelId: provider.modelId },
      task_model: { provider: "worker-provider", modelId: provider.modelId },
    };
    writeGhostModels(home, models);
    const outer = join(temp.root, "outer");
    const root = join(outer, "trusted");
    const cwd = join(root, "app");
    const extensionDir = join(cwd, ".pi", "extensions");
    const projectSkill = join(cwd, ".pi", "skills", "inside");
    const machineSkill = join(temp.ownerHome, ".agents", "skills", "machine");
    const extensionMarker = join(temp.root, "extension-started.txt");
    mkdirSync(extensionDir, { recursive: true });
    mkdirSync(projectSkill, { recursive: true });
    mkdirSync(machineSkill, { recursive: true });
    writeFileSync(join(outer, "AGENTS.md"), "HOSTILE_PARENT_POLICY\n");
    writeFileSync(join(root, "AGENTS.md"), "TRUSTED_PROJECT_POLICY\n");
    writeFileSync(
      join(projectSkill, "SKILL.md"),
      "---\nname: project-skill\ndescription: Trusted project skill.\n---\nProject body.\n",
    );
    writeFileSync(
      join(machineSkill, "SKILL.md"),
      "---\nname: machine-skill\ndescription: Trusted machine skill.\n---\nMachine body.\n",
    );
    writeFileSync(join(extensionDir, "worker-extension.ts"), `
      import { writeFileSync } from "node:fs";
      import { Type } from "typebox";
      export default function (pi) {
        pi.registerTool({
          name: "project_custom_tool",
          description: "Must not be model-callable",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "wrong" }], details: {} }),
        });
        pi.on("session_start", async (_event, ctx) => {
          const selected = await ctx.ui.select("Choose", ["one"]);
          writeFileSync(${JSON.stringify(extensionMarker)}, String(selected));
        });
      }
    `);
    const input: PiWorkerStartCommand = {
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "start" as const,
      ghostHome: home,
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      root,
      cwd,
      task: "Report success.",
      offline: true,
    };
    const notices: PiWorkerEvent[] = [];
    let session: PiWorkerChildSession | undefined;
    try {
      session = await createNativePiWorkerSession(input, (event) => notices.push(event), {
        ownerHome: temp.ownerHome,
      });
      await expect(session.run(input.task)).resolves.toMatchObject({ text: expect.stringContaining("worker reply") });

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        model: "task-model",
        toolNames: [...PI_WORKER_TOOL_NAMES],
      });
      expect(provider.requests[0]?.system).toContain(PI_WORKER_SYSTEM_PROMPT);
      expect(provider.requests[0]?.system).toContain("TRUSTED_PROJECT_POLICY");
      expect(provider.requests[0]?.system).toContain("project-skill");
      expect(provider.requests[0]?.system).toContain("machine-skill");
      expect(provider.requests[0]?.system).not.toContain("HOSTILE_PARENT_POLICY");
      expect(provider.requests[0]?.system).not.toContain("GHOST_PERSONA_MUST_NOT_ENTER_WORKER");
      expect(provider.requests[0]?.toolNames).not.toContain("project_custom_tool");
      expect(readFileSync(extensionMarker, "utf8")).toBe("undefined");
      expect(notices.some((event) => event.type === "notice" && event.text.includes("extension")))
        .toBe(false);
      const transcriptDir = join(ghostPaths(home).taskDir, "pi");
      expect(existsSync(transcriptDir)).toBe(true);
      expect(readdirSync(transcriptDir).some((name) => name.endsWith(".jsonl"))).toBe(true);
    } finally {
      await session?.dispose();
      await provider.close();
    }
  });

  it("surfaces a throwing native extension shutdown hook", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const home = seedGhost(temp.root, { name: "casper" });
    writeGhostModels(home, {
      ...openAiCompatiblePreset({
        providerId: "worker-provider",
        baseUrl: "http://127.0.0.1:1/v1",
        modelId: "task-model",
        apiKey: "not-needed",
      }),
      roles: { task_model: { provider: "worker-provider", modelId: "task-model" } },
    });
    const root = join(temp.root, "trusted");
    const cwd = join(root, "app");
    const extensionDir = join(cwd, ".pi", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "broken-shutdown.ts"), `
      export default function (pi) {
        pi.on("session_shutdown", () => { throw new Error("native shutdown failed"); });
      }
    `);
    const notices: PiWorkerEvent[] = [];
    const session = await createNativePiWorkerSession({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "start",
      ghostHome: home,
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      root,
      cwd,
      task: "No provider turn needed.",
      offline: true,
    }, (event) => notices.push(event), { ownerHome: temp.ownerHome });

    await expect(session.dispose()).rejects.toThrow("native shutdown failed");
    expect(notices).toContainEqual(expect.objectContaining({
      type: "notice",
      text: expect.stringContaining("native shutdown failed"),
    }));
  });

  it("fails native startup when a trusted project extension cannot load", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    const home = seedGhost(temp.root, { name: "casper" });
    writeGhostModels(home, {
      ...openAiCompatiblePreset({
        providerId: "worker-provider",
        baseUrl: "http://127.0.0.1:1/v1",
        modelId: "task-model",
        apiKey: "not-needed",
      }),
      roles: { task_model: { provider: "worker-provider", modelId: "task-model" } },
    });
    const root = join(temp.root, "trusted");
    const cwd = join(root, "app");
    const extensionDir = join(cwd, ".pi", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(extensionDir, "malformed.ts"), "export default function (");

    await expect(createNativePiWorkerSession({
      protocol: PI_WORKER_PROTOCOL_VERSION,
      type: "start",
      ghostHome: home,
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      root,
      cwd,
      task: "Must not start.",
      offline: true,
    }, () => {}, { ownerHome: temp.ownerHome })).rejects.toThrow("Failed to load extension");
  });
});

describe("PiWorkerAdapter", () => {
  it("self-invokes source and compiled ghostd without falling back to ambient Pi", () => {
    expect(ghostdWorkerInvocation(["bun", import.meta.filename], "/usr/bin/bun")).toEqual({
      command: "/usr/bin/bun",
      args: [import.meta.filename, "worker-pi"],
    });
    expect(ghostdWorkerInvocation(["/usr/bin/ghostd", "/$bunfs/root/main.js"], "/usr/bin/ghostd"))
      .toEqual({ command: "/usr/bin/ghostd", args: ["worker-pi"] });
    expect(() => ghostdWorkerInvocation(["bun", "/missing/ghostd.ts"], "/usr/bin/bun"))
      .toThrow("Cannot locate the current ghostd program");
  });

  it("requires a revalidated pinned context and returns only after the captured child exits", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const root = join(temp.root, "project");
    const cwd = join(root, "app");
    mkdirSync(cwd, { recursive: true });
    const script = `
      let input = "";
      process.stdin.on("data", chunk => {
        input += chunk;
        const newline = input.indexOf("\\n");
        if (newline < 0) return;
        const start = JSON.parse(input.slice(0, newline));
        process.stdout.write(JSON.stringify({ protocol: 1, type: "started", sessionId: start.taskId }) + "\\n");
        process.stdout.write(JSON.stringify({ protocol: 1, type: "result", sessionId: start.taskId, text: "done" }) + "\\n", () => process.exit(0));
      });
    `;
    const contexts: Array<{ root: string; cwd: string }> = [];
    const adapter = new PiWorkerAdapter({
      registry: temp.registry,
      assertContext: async (context) => {
        contexts.push(context);
        return context;
      },
      invocation: () => ({ command: process.execPath, args: [] }),
      spawnWorker: (_command, _args, options) =>
        spawn(process.execPath, ["-e", script], options),
    });
    const controller = await adapter.start({
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      ghostName: "casper",
      parent: conversationIdentity("pi", "parent"),
      task: "Implement it.",
      root,
      cwd,
    }, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    });

    expect(controller.nativeSessionId).toBe("task-12345678-1234-4123-8123-123456789abc");
    await expect(controller.result).resolves.toEqual({
      text: "done",
      nativeSessionId: "task-12345678-1234-4123-8123-123456789abc",
    });
    expect(contexts).toEqual([{ root, cwd }]);
  });

  it("refuses to spawn after the trusted project context changes", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const root = join(temp.root, "project");
    const cwd = join(root, "app");
    mkdirSync(cwd, { recursive: true });
    let spawned = false;
    const adapter = new PiWorkerAdapter({
      registry: temp.registry,
      assertContext: async () => ({ root, cwd: root }),
      spawnWorker: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    await expect(adapter.start({
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      ghostName: "casper",
      parent: conversationIdentity("pi", "parent"),
      task: "Implement it.",
      root,
      cwd,
    }, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    }))
      .rejects.toThrow("project identity changed");
    expect(spawned).toBe(false);
  });

  it("keeps startup pending until Pi is ready and rejects initialization failure", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const root = join(temp.root, "project");
    mkdirSync(root, { recursive: true });
    const script = `
      process.stdin.once("data", () => {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ protocol: 1, type: "error", message: "bad extension" }) + "\\n", () => process.exit(1));
        }, 30);
      });
    `;
    const adapter = new PiWorkerAdapter({
      registry: temp.registry,
      assertContext: async (context) => context,
      invocation: () => ({ command: process.execPath, args: [] }),
      spawnWorker: (_command, _args, options) => spawn(process.execPath, ["-e", script], options),
      timings: { resultExitGraceMs: 5, termGraceMs: 5 },
    });
    let settled = false;
    const starting = adapter.start({
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      ghostName: "casper",
      parent: conversationIdentity("pi", "parent"),
      task: "Initialize.",
      root,
      cwd: root,
    }, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    }).finally(() => { settled = true; });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(settled).toBe(false);
    await expect(starting).rejects.toThrow("bad extension");
  });

  it("escalates terminal cleanup when the captured child ignores TERM", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const root = join(temp.root, "project");
    mkdirSync(root, { recursive: true });
    const script = `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      process.stdin.once("data", chunk => {
        const start = JSON.parse(chunk.toString().trim());
        process.stdout.write(JSON.stringify({ protocol: 1, type: "started", sessionId: start.taskId }) + "\\n");
        process.stdout.write(JSON.stringify({ protocol: 1, type: "result", sessionId: start.taskId, text: "done" }) + "\\n");
      });
    `;
    let captured: ChildProcessWithoutNullStreams | undefined;
    const adapter = new PiWorkerAdapter({
      registry: temp.registry,
      assertContext: async (context) => context,
      invocation: () => ({ command: process.execPath, args: [] }),
      spawnWorker: (_command, _args, options) => {
        captured = spawn(process.execPath, ["-e", script], options) as ChildProcessWithoutNullStreams;
        return captured;
      },
      timings: { resultExitGraceMs: 5, termGraceMs: 5 },
    });
    const controller = await adapter.start({
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      ghostName: "casper",
      parent: conversationIdentity("pi", "parent"),
      task: "Finish but linger.",
      root,
      cwd: root,
    }, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    });

    await expect(controller.result).resolves.toMatchObject({ text: "done" });
    expect(captured?.signalCode).toBe("SIGKILL");
  });

  it("registers an immediate force kill while native initialization is pending", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const root = join(temp.root, "project");
    mkdirSync(root, { recursive: true });
    const script = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    let force: (() => void) | undefined;
    let captured: ChildProcessWithoutNullStreams | undefined;
    const adapter = new PiWorkerAdapter({
      registry: temp.registry,
      assertContext: async (context) => context,
      invocation: () => ({ command: process.execPath, args: [] }),
      spawnWorker: (_command, _args, options) => {
        captured = spawn(process.execPath, ["-e", script], options) as ChildProcessWithoutNullStreams;
        return captured;
      },
    });
    const starting = adapter.start({
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      ghostName: "casper",
      parent: conversationIdentity("pi", "parent"),
      task: "Never initializes.",
      root,
      cwd: root,
    }, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: (registered) => { force = registered; },
    });
    await until(() => force !== undefined);
    force?.();

    await expect(starting).rejects.toThrow("SIGKILL");
    expect(captured?.signalCode).toBe("SIGKILL");
  });

  it("surfaces a terminal worker error received during cancellation", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const root = join(temp.root, "project");
    mkdirSync(root, { recursive: true });
    const script = `
      let input = "";
      process.stdin.on("data", chunk => {
        input += chunk;
        let newline = input.indexOf("\\n");
        while (newline >= 0) {
          const command = JSON.parse(input.slice(0, newline));
          input = input.slice(newline + 1);
          if (command.type === "start") {
            process.stdout.write(JSON.stringify({ protocol: 1, type: "started", sessionId: command.taskId }) + "\\n");
          } else if (command.type === "cancel") {
            process.stdout.write(JSON.stringify({ protocol: 1, type: "error", message: "native shutdown failed" }) + "\\n", () => process.exit(1));
          }
          newline = input.indexOf("\\n");
        }
      });
    `;
    const adapter = new PiWorkerAdapter({
      registry: temp.registry,
      assertContext: async (context) => context,
      invocation: () => ({ command: process.execPath, args: [] }),
      spawnWorker: (_command, _args, options) => spawn(process.execPath, ["-e", script], options),
      timings: { cancelProtocolGraceMs: 5, resultExitGraceMs: 5, termGraceMs: 5 },
    });
    const controller = await adapter.start({
      taskId: "task-12345678-1234-4123-8123-123456789abc",
      ghostName: "casper",
      parent: conversationIdentity("pi", "parent"),
      task: "Cancel with teardown failure.",
      root,
      cwd: root,
    }, {
      signal: new AbortController().signal,
      emit: async () => {},
      registerForce: () => {},
    });

    await expect(controller.cancel()).rejects.toBeInstanceOf(WorkerStoppedError);
    await expect(controller.result).rejects.toThrow("native shutdown failed");
  });
});
