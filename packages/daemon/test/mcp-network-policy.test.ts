import { afterEach, expect, it, vi } from "vitest";
import * as z from "zod";
import { GhostMcpManager } from "../src/mcp-manager.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

it.each(["http", "sse"] as const)("keeps origin-locked headers on %s notification GETs from following redirects", async (type) => {
  let targetRequests = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    targetRequests++;
    return new Response(null, { status: 405 });
  } });
  cleanups.push(() => { target.stop(true); });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${target.port}/redirected` } });
    const message = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(await request.json());
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { tools: [] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "Mcp-Session-Id": "disposable-fixture" } });
  } });
  cleanups.push(() => { source.stop(true); });
  const originalFetch = globalThis.fetch;
  const gets: Array<{ status: number; redirect: RequestInit["redirect"] }> = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (init?.method === "GET" || init?.method === undefined) gets.push({ status: response.status, redirect: init?.redirect });
    return response;
  });
  const manager = new GhostMcpManager({ cwd: "/tmp" });
  cleanups.push(() => manager.disconnectAll());
  await manager.connectServers({ fixture: { type, url: `http://127.0.0.1:${source.port}/mcp`, headers: { "X-Private-Fixture": "disposable-secret" }, headerPolicy: "origin-locked", timeout: 1000 } });
  await vi.waitFor(() => expect(gets.length).toBeGreaterThan(0));
  expect(gets).toEqual([{ status: 302, redirect: "manual" }]);
  expect(targetRequests).toBe(0);
});
