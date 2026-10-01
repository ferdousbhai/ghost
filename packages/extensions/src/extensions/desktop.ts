import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { GhostExtensionAPI, GhostExtensionFactory, GhostToolResult } from "../extension-api.js";
import { GhostError, type GhostErrorCode } from "../errors.js";
import { resolveToolCapabilities, untrustedTextResult, type GhostExtensionOptions } from "./shared.js";

export const DESKTOP_LOOK = "desktop_look";
export const DESKTOP_ACT = "desktop_act";

const DESKTOP_TIMEOUT_MS = 120_000;

/** The `ghost-desktop` MCP server as the desktop tools use it; a seam for tests. */
export const DESKTOP_TOOLS: readonly string[] = [DESKTOP_LOOK, DESKTOP_ACT];

/** The `ghost-desktop` MCP server as the desktop tools use it; a seam for tests. */
export interface DesktopServer {
  /** The server's tools; empty where ghost-desktop is not installed. */
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, caller: string | undefined, signal?: AbortSignal): Promise<CallToolResult>;
}

export interface DesktopExtensionOptions extends GhostExtensionOptions {
  readonly desktop?: DesktopServer;
}

/**
 * One `ghost-desktop` process per daemon, spawned by name from PATH (or
 * `$GHOST_DESKTOP`) on first use and respawned after it exits. Every
 * conversation shares it and names itself per call, which keys the
 * server's desktop lease. Its tool list is fixed, so it is read once.
 */
function spawnedDesktop(): DesktopServer {
  let client: Promise<Client> | undefined;
  const connect = () => {
    client ??= (async () => {
      const next = new Client({ name: "ghost", version: "1" }, { capabilities: {} });
      next.onclose = () => { client = undefined; };
      await next.connect(new StdioClientTransport({
        command: process.env.GHOST_DESKTOP || "ghost-desktop",
        env: { ...getDefaultEnvironment(), ...process.env } as Record<string, string>,
        stderr: "ignore",
      }));
      return next;
    })();
    client.catch(() => { client = undefined; });
    return client;
  };
  const tools = connect().then((connected) => connected.listTools()).then((listed) => listed.tools, () => []);
  return {
    listTools: () => tools,
    async callTool(name, args, caller, signal) {
      try {
        return await (await connect()).callTool(
          { name, arguments: args, ...(caller ? { _meta: { caller } } : {}) },
          undefined,
          { timeout: DESKTOP_TIMEOUT_MS, ...(signal ? { signal } : {}) },
        ) as CallToolResult;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A lost connection says nothing about whether the input happened.
        throw new GhostError(
          "conflict",
          `ghost-desktop stopped answering (${error instanceof Error ? error.message : String(error)}); the step may have run. Look before retrying.`,
        );
      }
    },
  };
}

let shared: DesktopServer | undefined;

const ERROR_CODES: Record<string, GhostErrorCode> = {
  busy: "conflict",
  locked: "forbidden",
  unavailable: "not_found",
  not_found: "not_found",
  invalid: "invalid_format",
};

async function toolResult(result: CallToolResult, vision: boolean): Promise<GhostToolResult<{ images: number }>> {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  if (result.isError) {
    const code = result._meta?.code;
    throw new GhostError((typeof code === "string" && ERROR_CODES[code]) || "conflict", text);
  }
  const images = content.flatMap((part) => (part.type === "image" ? [{ type: "image" as const, data: part.data, mimeType: part.mimeType }] : []));
  // Titles, on-screen text, and control names are the desktop's words, not the owner's.
  const fenced = await untrustedTextResult(
    images.length && !vision
      ? `${text}\nYour model cannot see images, so the ${images.length > 1 ? "frames are" : "screenshot is"} not attached; read the window with ui instead.`
      : text,
    { images: images.length },
    "desktop",
  );
  return vision ? { ...fenced, content: [...fenced.content, ...images] } : fenced;
}

/**
 * The desktop tools, served by `ghost-desktop` over MCP. Unlike an owner's
 * MCP server, its tools keep their own names and its errors reach the model
 * word for word: they carry the remediation (start the accessibility bus,
 * unlock the screen, wait for the lease).
 */
export function createDesktopExtension(options: DesktopExtensionOptions = {}): GhostExtensionFactory {
  return async (pi: GhostExtensionAPI) => {
    if (!options.desktop) shared ??= spawnedDesktop();
    const desktop = options.desktop ?? shared;
    if (!desktop) return;
    // Without ghost-desktop the list is empty and the conversation has no desktop tools.
    for (const tool of (await desktop.listTools()).filter((listed) => DESKTOP_TOOLS.includes(listed.name))) {
      pi.registerTool({
        name: tool.name,
        label: tool.name === DESKTOP_LOOK ? "Look at the desktop" : "Act on the desktop",
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema as unknown as TSchema,
        execute: async (_toolCallId, params, signal, ctx) => {
          const result = await desktop.callTool(tool.name, (params ?? {}) as Record<string, unknown>, ctx.caller, signal);
          return toolResult(result, resolveToolCapabilities(options, ctx).vision);
        },
      });
    }
  };
}
