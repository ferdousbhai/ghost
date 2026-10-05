import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { connectMcpServer, serveMcpTools } from "../src/mcp-stdio.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A server that completes the handshake, logs every message, and answers `exit` by exiting. */
function silentServer(): { command: string; seen: () => Array<{ method?: string; params?: Record<string, unknown> }> } {
  const dir = mkdtempSync(join(tmpdir(), "ghost-mcp-"));
  dirs.push(dir);
  const log = join(dir, "seen.jsonl");
  const command = join(dir, "server");
  writeFileSync(command, `#!${process.execPath}
import { appendFileSync } from "node:fs";
for await (const line of console) {
  appendFileSync(${JSON.stringify(log)}, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  if (message.method === "exit") process.exit(3);
}
`);
  chmodSync(command, 0o755);
  return { command, seen: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

describe("MCP stdio client", () => {
  it("cancels a call that times out or is aborted, telling the server which", async () => {
    const server = silentServer();
    const client = await connectMcpServer(server.command, process.env, { name: "ghost", version: "1" });
    await expect(client.request("tools/call", {}, { timeoutMs: 20 })).rejects.toThrow("no answer in 20 ms");
    const controller = new AbortController();
    const aborted = client.request("tools/call", {}, { signal: controller.signal });
    controller.abort(new Error("owner stopped"));
    await expect(aborted).rejects.toThrow("owner stopped");
    await client.request("exit", {}).catch(() => {});
    await client.closed;
    expect(server.seen().filter((message) => message.method === "notifications/cancelled").map((message) => message.params))
      .toEqual([{ requestId: 2, reason: "no answer in 20 ms" }, { requestId: 3, reason: "owner stopped" }]);
  });

  it("fails calls in flight when the server exits, and every call after", async () => {
    const client = await connectMcpServer(silentServer().command, process.env, { name: "ghost", version: "1" });
    await expect(client.request("exit", {})).rejects.toThrow("exited (3)");
    await expect(client.request("tools/list", {})).rejects.toThrow("exited (3)");
  });

  it("rejects when the server cannot start", async () => {
    await expect(connectMcpServer("/nonexistent/ghost-desktop", process.env, { name: "ghost", version: "1" })).rejects.toThrow("ENOENT");
  });
});

describe("MCP stdio server", () => {
  it("aborts a cancelled call without answering it", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    let signal: AbortSignal | undefined;
    const served = serveMcpTools({
      name: "t",
      version: "1",
      list: async () => [],
      call: (_name, _args, _client, callSignal) => {
        signal = callSignal;
        return new Promise((resolve) => callSignal.addEventListener("abort", () => resolve({ content: [] })));
      },
    }, input, (line) => lines.push(line));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`);
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" })}\n`);
    await served;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signal?.aborted).toBe(true);
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ jsonrpc: "2.0", id: 8, result: {} }]);
  });
});
