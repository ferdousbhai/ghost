import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnEvent } from "../src/turn-events.js";
import { startTestDaemon, type TestDaemon } from "./helpers/fixtures.js";

const CLI = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
let daemon: TestDaemon;
let client: Client | undefined;

beforeEach(async () => {
  daemon = await startTestDaemon({ ghost: "casper", openSession: "conv-1" });
});

afterEach(async () => {
  await liveTurn?.end();
  liveTurn = undefined;
  await client?.close();
  client = undefined;
  await daemon.listening.close();
  await daemon.host.disposeAll();
  daemon.harness.cleanup();
  daemon.temp.cleanup();
});

/** The environment a harness runs `ghost mcp serve` with. */
function harnessEnv(session = "conv-1"): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: daemon.temp.ownerHome,
    ...(daemon.env as Record<string, string>),
    GHOST: "casper",
    GHOST_SESSION: session,
  };
}

/** A harness's view: `ghost mcp serve` spawned over stdio. */
async function connect(session?: string): Promise<Client> {
  client = new Client({ name: "harness", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "serve"], env: harnessEnv(session) }));
  return client;
}

let liveTurn: { end: () => Promise<void> } | undefined;

/** Hold an owner `!` turn open in a conversation. */
async function startLiveTurn(sessionId = "conv-1"): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  const controller = new AbortController();
  const turn = daemon.host.runTurn("casper", {
    sessionId,
    prompt: "!sleep 30",
    signal: controller.signal,
    emit: (event) => events.push(event),
  });
  await until(() => (events.some((event) => event.type === "tool_execution_start") ? true : null));
  liveTurn = { end: async () => { controller.abort(); await turn.catch(() => {}); } };
  return events;
}

async function until<T>(read: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

/** Replace one of the ghost's tools in the host's cache, after it has been loaded once. */
async function replaceTool(name: string, execute: (...args: never[]) => Promise<unknown>): Promise<void> {
  await daemon.host.sessionTools("casper", "conv-1");
  const cache = (daemon.host as unknown as { tools: Map<string, Promise<{ tools: Map<string, Record<string, unknown>> }>> }).tools;
  const { tools } = await cache.values().next().value!;
  tools.set(name, { ...tools.get(name)!, execute });
}

describe("ghost mcp serve", () => {
  it("lists the ghost's browser and desktop tools, and nothing it no longer serves", async () => {
    const { tools } = await (await connect()).listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["ghost_browser", "desktop_look", "desktop_act"]));
    expect(names).not.toContain("ask");
    expect(tools.find((tool) => tool.name === "ghost_browser")?.inputSchema).toMatchObject({ type: "object" });
  });

  it("stops when the harness ends stdin, aborting a call still in flight", async () => {
    let aborted = false;
    await replaceTool("ghost_browser", async (_id: never, _params: never, signal: never) => {
      const abort = signal as AbortSignal | undefined;
      await new Promise<void>((resolve) => {
        if (abort?.aborted) resolve();
        abort?.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted = true;
      return { content: [{ type: "text", text: "aborted" }] };
    });
    // A killed harness leaves both pipes closed, with no SIGTERM to the server.
    const child = spawn(process.execPath, [CLI, "mcp", "serve"], { env: harnessEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "1" } } });
    await until(() => (stdout.includes('"id":1') ? true : null));
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "ghost_browser", arguments: { action: "tabs" } } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.stdin.end();
    child.stdout.destroy();
    expect(await exited).toBe(0);
    await until(() => (aborted ? true : null));
  });

  it("serves a new conversation whose first `!` command is still running", async () => {
    // A conversation with no message yet is not listed; the id the daemon
    // handed the shell still binds.
    await startLiveTurn("fresh-1");
    expect((await daemon.host.listSessions("casper")).some((session) => session.id === "fresh-1")).toBe(false);
    const { tools } = await (await connect("fresh-1")).listTools();
    expect(tools.map((tool) => tool.name)).toContain("ghost_browser");
  });

  it("returns a tool's own failure as a tool error", async () => {
    const harness = await connect();
    const browser = await harness.callTool({ name: "ghost_browser", arguments: { action: "tabs" } });
    expect(browser.isError).toBe(true);
    // No relay is paired here: the browser tool's own refusal.
    expect(JSON.stringify(browser.content)).toMatch(/relay/iu);
    const direct = await daemon.host.callSessionTool("casper", "conv-1", "ghost_browser", { action: "tabs" });
    expect(browser.content).toEqual(direct.content);
  });

  it("names each serve process as its own caller, so harnesses take turns on the desktop", async () => {
    const callers: Array<string | undefined> = [];
    await replaceTool("ghost_browser", async (_id: never, _params: never, _signal: never, ctx: never) => {
      callers.push((ctx as { caller?: string }).caller);
      return { content: [{ type: "text", text: "ok" }] };
    });
    await (await connect()).callTool({ name: "ghost_browser", arguments: { action: "tabs" } });
    await (await connect()).callTool({ name: "ghost_browser", arguments: { action: "tabs" } });
    await daemon.host.callSessionTool("casper", "conv-1", "ghost_browser", { action: "tabs" });
    await daemon.host.callSessionTool("casper", null, "ghost_browser", { action: "tabs" });
    expect(callers[0]).toMatch(/^harness [0-9a-f]{8}$/u);
    expect(callers[1]).toMatch(/^harness [0-9a-f]{8}$/u);
    expect(callers[1]).not.toBe(callers[0]);
    expect(callers[2]).toBe("conversation conv-1");
    expect(callers[3]).toBe("a delegated run");
  });
});

describe("desktop tools over ghost mcp serve", () => {
  it("reach ghost-desktop with the serve process as the caller, which keys its lease", async () => {
    const result = await (await connect()).callTool({ name: "desktop_look", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toMatch(/\\"caller\\":\\"harness [0-9a-f]{8}\\"/u);
  });
});

describe("SessionHost.callSessionTool", () => {
  it("gives an owner `!` command the conversation's identity, as the harness's shell has", async () => {
    const events: TurnEvent[] = [];
    await daemon.host.runTurn("casper", {
      sessionId: "conv-1",
      prompt: "!printf '%s|%s' \"$GHOST\" \"$GHOST_SESSION\"",
      emit: (event) => events.push(event),
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_execution_end",
      toolName: "bash",
      isError: false,
      summary: "casper|conv-1",
    }));
  });

  it("refuses a tool the ghost does not have", async () => {
    await expect(daemon.host.callSessionTool("casper", "conv-1", "rm_rf", {})).rejects.toMatchObject({ status: 404 });
  });
});
