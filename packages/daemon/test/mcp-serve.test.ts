import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiMessagesEvent } from "../src/pi-messages.js";
import { startTestDaemon, type TestDaemon } from "./helpers/fixtures.js";

const CLI = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
let daemon: TestDaemon;
let client: Client | undefined;

beforeEach(async () => {
  daemon = await startTestDaemon({ ghost: "casper", openSession: "conv-1" });
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await daemon.listening.close();
  await daemon.host.disposeAll();
  await daemon.provider.close();
  daemon.temp.cleanup();
});

const QUESTION = {
  header: "Deploy",
  question: "Ship it now?",
  options: [{ label: "Yes", description: "Deploy" }, { label: "No", description: "Wait" }],
  multiSelect: false,
};

/** The environment `ghost delegate` hands a harness, and the harness its MCP servers. */
function harnessEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: daemon.temp.ownerHome,
    ...(daemon.env as Record<string, string>),
    GHOST: "casper",
    GHOST_SESSION: "conv-1",
  };
}

/** A harness's view: `ghost mcp serve` spawned over stdio, as a delegated run would. */
async function connect(): Promise<Client> {
  client = new Client({ name: "harness", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "serve"], env: harnessEnv() }));
  return client;
}

async function until<T>(read: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

describe("ghost mcp serve", () => {
  it("lists the conversation's own tools", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ask", "ghost_browser", "ghost_screen", "ghost_desktop"]));
    expect(tools.find((tool) => tool.name === "ask")?.inputSchema).toMatchObject({ type: "object" });
  });

  it("asks the owner in the launching conversation and returns the answer", async () => {
    const harness = await connect();
    const call = harness.callTool({ name: "ask", arguments: { questions: [QUESTION] } });
    const pending = await until(() => daemon.host.pendingAsk("casper", "conv-1"));
    expect(pending.questions[0]?.question).toBe("Ship it now?");
    daemon.host.answerAsk("casper", "conv-1", pending.id, {
      kind: "submit",
      results: [{ id: pending.questions[0]?.id, selectedOptions: ["Yes"] }],
    });
    const result = await call;
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("Yes");
  });

  it("stops when the harness ends stdin, withdrawing a question still in flight", async () => {
    // A killed harness leaves both pipes closed, with no SIGTERM to the server.
    const child = spawn(process.execPath, [CLI, "mcp", "serve"], { env: harnessEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "1" } } });
    await until(() => (stdout.includes('"id":1') ? true : null));
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "ask", arguments: { questions: [QUESTION] } } });
    await until(() => daemon.host.pendingAsk("casper", "conv-1"));
    child.stdin.end();
    child.stdout.destroy();
    expect(await exited).toBe(0);
    await until(() => (daemon.host.pendingAsk("casper", "conv-1") === null ? true : null));
  });

  it("returns a tool's own failure, and a schema error, as tool errors", async () => {
    const harness = await connect();
    const browser = await harness.callTool({ name: "ghost_browser", arguments: { action: "tabs" } });
    expect(browser.isError).toBe(true);
    // No relay is paired here: the browser tool's own refusal, not a schema error.
    expect(JSON.stringify(browser.content)).toMatch(/relay/iu);
    const direct = await daemon.host.callSessionTool("casper", "conv-1", "ghost_browser", { action: "tabs" });
    expect(browser.content).toEqual(direct.content);

    const invalid = await harness.callTool({ name: "ask", arguments: { questions: "no" } });
    expect(invalid.isError).toBe(true);
  });
});

describe("SessionHost.callSessionTool", () => {
  it("shows a delegated call as a tool card in the live turn stream", async () => {
    const events: PiMessagesEvent[] = [];
    const stream = (event: PiMessagesEvent) => events.push(event);
    // Stand in for an owner turn whose Bash call is running `ghost delegate`.
    const hosted = (daemon.host as unknown as { sessions: Map<string, { streamEmit?: typeof stream }> })
      .sessions.values().next().value!;
    hosted.streamEmit = stream;
    await daemon.host.callSessionTool("casper", "conv-1", "ghost_browser", { action: "tabs" });
    expect(events.map((event) => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
    expect(events[0]).toMatchObject({ toolName: "ghost_browser", intent: "Called by a delegated run" });
    expect(events[1]).toMatchObject({ toolName: "ghost_browser", isError: true });
  });

  it("refuses a tool the ghost does not have", async () => {
    await expect(daemon.host.callSessionTool("casper", "conv-1", "rm_rf", {})).rejects.toMatchObject({ status: 404 });
  });
});
