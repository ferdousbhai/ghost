import { randomUUID } from "node:crypto";
import { serveMcpTools } from "@ghost/extensions";
import type { SessionToolDescriptor, SessionToolResult } from "../session-host.js";
import { flagString, type ParsedCliArgs } from "./args.js";
import { preferredSessionId, resolveGhost, resolveTarget, sessionPath } from "./common.js";
import type { CliContext } from "./types.js";

/**
 * `ghost mcp serve`: the ghost's own tools (browser, desktop) as a stdio MCP
 * server, for the harness carrying a conversation and for a run `ghost
 * delegate` launched. The conversation is fixed at start (`-s`, then
 * `$GHOST_SESSION`); every call runs in the daemon.
 */
export async function mcpServeCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  // An id (`-s`, or the `$GHOST_SESSION` the daemon set) binds as given, without
  // listing every conversation first on each harness pass; the daemon checks it
  // on every call.
  const requested = preferredSessionId(ctx.runtime, flagString(parsed, "session"));
  const path = requested
    ? sessionPath((await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"))).name, requested)
    : (await resolveTarget(ctx.client, ctx, parsed)).path;
  // One id per serve process keys the desktop lease, so two harnesses bound to
  // the same conversation still take turns steering the desktop.
  const runId = randomUUID().slice(0, 8);
  await serveMcpTools({
    name: "ghost",
    version: "1",
    list: async () => (await ctx.client.request<{ tools: SessionToolDescriptor[] }>("GET", `${path}/tools`)).body.tools,
    call: async (name, args, client, signal) => (await ctx.client.request<SessionToolResult>(
      "POST",
      `${path}/tools/${encodeURIComponent(name)}`,
      { arguments: args, caller: `${client ?? "delegated run"} ${runId}` },
      { timeoutMs: 0, signal },
    )).body,
  }, process.stdin, (line) => process.stdout.write(line));
  return 0;
}
