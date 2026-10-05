import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * MCP's stdio transport, as far as a tools server and its client need it:
 * one JSON-RPC 2.0 message per line, carrying initialize, ping, tools/list,
 * tools/call, and a call's cancellation.
 */

/** Asked for by the client, and answered when a client names no version; otherwise the client's is echoed. */
const PROTOCOL_VERSION = "2025-06-18";

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: string };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content?: McpContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpToolServer {
  name: string;
  version: string;
  list(): Promise<readonly unknown[]>;
  /** `client` is the name the client gave in `initialize`; `signal` aborts on cancellation or end of input. */
  call(name: string, args: Record<string, unknown>, client: string | undefined, signal: AbortSignal): Promise<unknown>;
}

/** Serve tools on `input`/`write` until input ends, aborting every call still running then. */
export async function serveMcpTools(server: McpToolServer, input: Readable, write: (line: string) => void): Promise<void> {
  let client: string | undefined;
  const running = new Map<unknown, AbortController>();
  const reply = (id: unknown, body: object) => write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  const answer = async (method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        const info = params.clientInfo as { name?: unknown } | undefined;
        client = typeof info?.name === "string" ? info.name : undefined;
        return {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: server.name, version: server.version },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: await server.list() };
      case "tools/call":
        return server.call(String(params.name), (params.arguments ?? {}) as Record<string, unknown>, client, signal);
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  };
  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (line.trim() === "") continue;
    let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      reply(null, { error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (message.method === "notifications/cancelled") running.get(message.params?.requestId)?.abort();
    if (message.id === undefined || typeof message.method !== "string") continue;
    const { id } = message;
    const controller = new AbortController();
    running.set(id, controller);
    answer(message.method, message.params ?? {}, controller.signal)
      .then(
        (result) => controller.signal.aborted || reply(id, { result }),
        (error: { code?: number; message?: string }) =>
          controller.signal.aborted || reply(id, { error: { code: error.code ?? -32603, message: error.message ?? String(error) } }),
      )
      .finally(() => running.delete(id));
  }
  for (const controller of running.values()) controller.abort();
}

export interface McpClient {
  request(method: string, params: object, options?: { timeoutMs?: number; signal?: AbortSignal | undefined }): Promise<unknown>;
  /** Settles once the server has exited. */
  readonly closed: Promise<void>;
}

/** Spawn `command` as a stdio MCP server and complete the handshake. */
export async function connectMcpServer(command: string, env: NodeJS.ProcessEnv, clientInfo: { name: string; version: string }): Promise<McpClient> {
  const child = spawn(command, [], { env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const { promise: closed, resolve: close } = Promise.withResolvers<void>();
  let ended: Error | undefined;
  const end = (error: Error) => {
    ended ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    close();
  };
  child.once("error", end);
  child.once("exit", (code, signal) => end(new Error(`${command} exited (${signal ?? code})`)));
  // A write to a server that has died fails here; its exit settles the calls.
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id as number);
    if (!waiter) return;
    pending.delete(message.id as number);
    if (message.error) waiter.reject(new Error(message.error.message ?? "MCP error"));
    else waiter.resolve(message.result);
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  let next = 0;
  const request: McpClient["request"] = (method, params, { timeoutMs, signal } = {}) => new Promise((resolve, reject) => {
    if (ended) return reject(ended);
    if (signal?.aborted) return reject(signal.reason);
    const id = ++next;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const cancel = (reason: Error) => {
      if (!pending.delete(id)) return;
      settle();
      send({ method: "notifications/cancelled", params: { requestId: id, reason: reason.message } });
      reject(reason);
    };
    const onAbort = () => cancel(signal?.reason instanceof Error ? signal.reason : new Error("Aborted."));
    pending.set(id, {
      resolve: (value) => { settle(); resolve(value); },
      reject: (error) => { settle(); reject(error); },
    });
    if (timeoutMs) timer = setTimeout(() => cancel(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    send({ id, method, params });
  });
  try {
    await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo });
  } catch (error) {
    child.kill();
    throw error;
  }
  send({ method: "notifications/initialized" });
  return { request, closed };
}
