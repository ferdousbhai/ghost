#!/usr/bin/env bun
// A stand-in ghost-desktop for daemon tests, so no test ever starts the real
// one against the owner's desktop. GHOST_DESKTOP points the bridge here.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const schema = { type: "object", properties: {}, additionalProperties: true };
const server = new Server({ name: "ghost-desktop", version: "test" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "desktop_look", description: "Fake desktop look.", inputSchema: schema },
    { name: "desktop_act", description: "Fake desktop act.", inputSchema: schema },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify({ tool: request.params.name, caller: request.params._meta?.caller ?? null }) }],
}));
await server.connect(new StdioServerTransport());
