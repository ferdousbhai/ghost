import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SessionToolDescriptor, SessionToolResult } from "../session-host.js";
import { flagString, type ParsedCliArgs } from "./args.js";
import { CliError, EXIT_CODE } from "./client.js";
import { preferredSessionId, resolveGhost, resolveTarget, sessionPath } from "./common.js";
import type { CliContext } from "./types.js";

/**
 * `ghost mcp serve`: the ghost's own tools (browser, desktop) as a stdio MCP
 * server, for the harness carrying a conversation and for a run `ghost
 * delegate` launched. The conversation is fixed at start (`-s`, then
 * `$GHOST_SESSION`); every call runs in the daemon.
 */
export async function mcpServeCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  // A conversation whose first turn is still running is not listed yet, so an
  // unlisted id (`-s`, or the `$GHOST_SESSION` the daemon set) binds as given;
  // the daemon checks it on every call.
  const path = await resolveTarget(ctx.client, ctx, parsed).then((target) => target.path, async (error: unknown) => {
    const requested = preferredSessionId(ctx.runtime, flagString(parsed, "session"));
    if (!requested || !(error instanceof CliError && error.exitCode === EXIT_CODE.notFound)) throw error;
    return sessionPath((await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"))).name, requested);
  });
  const server = new Server({ name: "ghost", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = (await ctx.client.request<{ tools: SessionToolDescriptor[] }>("GET", `${path}/tools`)).body;
    return { tools: tools as never };
  });
  // One id per serve process keys the desktop lease, so two harnesses bound to
  // the same conversation still take turns steering the desktop.
  const runId = randomUUID().slice(0, 8);
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const caller = `${server.getClientVersion()?.name ?? "delegated run"} ${runId}`;
    const result = (await ctx.client.request<SessionToolResult>(
      "POST",
      `${path}/tools/${encodeURIComponent(name)}`,
      { arguments: args ?? {}, caller },
      { timeoutMs: 0, signal: extra.signal },
    )).body;
    return result as never;
  });
  const { promise: closed, resolve } = Promise.withResolvers<void>();
  server.onclose = resolve;
  // The transport reports only a close it made itself. When the harness ends
  // stdin, close the server, which aborts a call still in flight.
  process.stdin.once("end", () => void server.close().then(resolve, resolve));
  await server.connect(new StdioServerTransport());
  await closed;
  return 0;
}
