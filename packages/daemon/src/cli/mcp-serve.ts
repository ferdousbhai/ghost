import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SessionToolDescriptor, SessionToolResult } from "../session-host.js";
import type { ParsedCliArgs } from "./args.js";
import { resolveTarget } from "./common.js";
import type { CliContext } from "./types.js";

/**
 * `ghost mcp serve`: this conversation's own tools (ask, browser, screen,
 * desktop) as a stdio MCP server for a harness `ghost delegate` launched. The
 * conversation is fixed at start (`-s`, then `$GHOST_SESSION`), so a delegated
 * run's questions reach the conversation that started it; every call runs in
 * the daemon, through the same tools the ghost uses in-session.
 */
export async function mcpServeCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const { path } = await resolveTarget(ctx.client, ctx, parsed);
  const server = new Server({ name: "ghost", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = (await ctx.client.request<{ tools: SessionToolDescriptor[] }>("GET", `${path}/tools`)).body;
    return { tools: tools as never };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const result = (await ctx.client.request<SessionToolResult>(
      "POST",
      `${path}/tools/${encodeURIComponent(name)}`,
      { arguments: args ?? {} },
      { timeoutMs: 0, signal: extra.signal },
    )).body;
    return result as never;
  });
  const { promise: closed, resolve } = Promise.withResolvers<void>();
  server.onclose = resolve;
  // The transport reports only a close it made itself. When the harness ends
  // stdin, close the server, which aborts a call still in flight so the
  // daemon withdraws a question the run can no longer receive.
  process.stdin.once("end", () => void server.close().then(resolve, resolve));
  await server.connect(new StdioServerTransport());
  await closed;
  return 0;
}
