import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { logger as ompLogger } from "@oh-my-pi/pi-utils";
import { describe, expect, it } from "vitest";

interface CapturedLog {
  message: string;
  context?: Record<string, unknown>;
}

interface RefreshHooks {
  observedCredential?: {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    tokenUrl: string;
  };
  onRefreshFailure?: (error: unknown) => void;
}

const storedCredential = {
  type: "oauth" as const,
  access: "expired-access-token",
  refresh: "refresh-token",
  expires: 0,
  tokenUrl: "https://oauth.invalid/token",
};

function remoteConfig(
  credentialId: string,
  url = "http://127.0.0.1:1/mcp",
): MCPServerConfig {
  return {
    type: "http",
    url,
    timeout: 100,
    auth: { type: "oauth", credentialId },
  };
}

function captureOmpLogs(): { events: CapturedLog[]; dispose(): void } {
  const events: CapturedLog[] = [];
  const dispose = ompLogger.registerLogSink((event) => {
    events.push({ message: event.message, context: event.context });
  });
  return { events, dispose };
}

describe("hosted OMP MCP OAuth log redaction", () => {
  it("redacts credential identifiers when startup credential resolution fails", async () => {
    const credentialId = "MCP_OAUTH_RESOLUTION_CREDENTIAL_ID_SENTINEL";
    const errorText = "MCP_OAUTH_RESOLUTION_ERROR_SENTINEL";
    const manager = new MCPManager(process.cwd(), null, { redactErrors: true });
    manager.setAuthStorage({
      get: () => storedCredential,
      refreshStoredOAuthCredential: async () => {
        throw new Error(errorText);
      },
    } as unknown as AuthStorage);
    const captured = captureOmpLogs();

    try {
      const result = await manager.connectServers(
        { oauth_resolution_fixture: remoteConfig(credentialId) },
        {},
      );
      expect(result.errors.get("oauth_resolution_fixture")).toBe("mcp_connection_failed");
      const warning = captured.events.find((event) =>
        event.message === "Failed to resolve OAuth credential"
      );
      expect(warning?.context).toEqual({ code: "mcp_connection_failed" });
      expect(JSON.stringify(captured.events)).not.toContain(credentialId);
      expect(JSON.stringify(captured.events)).not.toContain(errorText);
    } finally {
      captured.dispose();
      await manager.disconnectAll().catch(() => {});
    }
  });

  it("redacts credential identifiers from refresh and definitive-removal warnings", async () => {
    const refreshCredentialId = "MCP_OAUTH_REFRESH_CREDENTIAL_ID_SENTINEL";
    const removedCredentialId = "MCP_OAUTH_REMOVED_CREDENTIAL_ID_SENTINEL";
    const refreshErrorText = "MCP_OAUTH_REFRESH_ERROR_SENTINEL";
    const manager = new MCPManager(process.cwd(), null, { redactErrors: true });
    manager.setAuthStorage({
      get: () => storedCredential,
      refreshStoredOAuthCredential: async (
        credentialId: string,
        hooks: RefreshHooks,
      ) => {
        if (credentialId === refreshCredentialId) {
          hooks.onRefreshFailure?.(new Error(refreshErrorText));
          return {
            credential: hooks.observedCredential,
            refreshed: false,
            removed: false,
          };
        }
        return { credential: undefined, refreshed: false, removed: true };
      },
    } as unknown as AuthStorage);
    const captured = captureOmpLogs();

    try {
      await manager.prepareConfig(remoteConfig(refreshCredentialId));
      await manager.prepareConfig(remoteConfig(removedCredentialId));

      const refreshWarning = captured.events.find((event) =>
        event.message === "MCP OAuth refresh failed, using existing token"
      );
      const removalWarning = captured.events.find((event) =>
        event.message === "MCP OAuth refresh failed definitively; cleared credential"
      );
      expect(refreshWarning?.context).toEqual({ code: "mcp_connection_failed" });
      expect(removalWarning?.context).toEqual({ code: "mcp_connection_failed" });
      const logs = JSON.stringify(captured.events);
      expect(logs).not.toContain(refreshCredentialId);
      expect(logs).not.toContain(removedCredentialId);
      expect(logs).not.toContain(refreshErrorText);
    } finally {
      captured.dispose();
      await manager.disconnectAll().catch(() => {});
    }
  });

  it("applies the same credential redaction during a live server reconnect", async () => {
    const credentialId = "MCP_OAUTH_RECONNECT_CREDENTIAL_ID_SENTINEL";
    const refreshErrorText = "MCP_OAUTH_RECONNECT_REFRESH_ERROR_SENTINEL";
    let refreshes = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET") return new Response(null, { status: 405 });
        if (request.method === "DELETE") return new Response(null, { status: 202 });
        const message = await request.json() as { id?: string | number; method?: string };
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        const result = message.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-reconnect-fixture", version: "1.0.0" },
            }
          : { tools: [] };
        return Response.json({ jsonrpc: "2.0", id: message.id, result });
      },
    });
    const manager = new MCPManager(process.cwd(), null, { redactErrors: true });
    manager.setAuthStorage({
      get: () => storedCredential,
      refreshStoredOAuthCredential: async (_id: string, hooks: RefreshHooks) => {
        refreshes += 1;
        if (refreshes > 1) hooks.onRefreshFailure?.(new Error(refreshErrorText));
        return {
          credential: hooks.observedCredential,
          refreshed: false,
          removed: false,
        };
      },
    } as unknown as AuthStorage);
    const captured = captureOmpLogs();

    try {
      const config = remoteConfig(credentialId, server.url.href);
      const initial = await manager.connectServers({ oauth_reconnect_fixture: config }, {});
      expect(initial.connectedServers).toEqual(["oauth_reconnect_fixture"]);
      expect(await manager.reconnectServer("oauth_reconnect_fixture", { manual: true }))
        .not.toBeNull();
      expect(refreshes).toBe(2);
      const warning = captured.events.find((event) =>
        event.message === "MCP OAuth refresh failed, using existing token"
      );
      expect(warning?.context).toEqual({ code: "mcp_connection_failed" });
      const logs = JSON.stringify(captured.events);
      expect(logs).not.toContain(credentialId);
      expect(logs).not.toContain(refreshErrorText);
    } finally {
      captured.dispose();
      await manager.disconnectAll().catch(() => {});
      await server.stop(true);
    }
  });

  it("retains credential identifiers in ordinary non-hosted OMP diagnostics", async () => {
    const credentialId = "ordinary-mcp-oauth-credential";
    const refreshError = new Error("ordinary refresh diagnostic");
    const manager = new MCPManager(process.cwd());
    manager.setAuthStorage({
      get: () => storedCredential,
      refreshStoredOAuthCredential: async (_credentialId: string, hooks: RefreshHooks) => {
        hooks.onRefreshFailure?.(refreshError);
        return {
          credential: hooks.observedCredential,
          refreshed: false,
          removed: false,
        };
      },
    } as unknown as AuthStorage);
    const captured = captureOmpLogs();

    try {
      await manager.prepareConfig(remoteConfig(credentialId));
      const warning = captured.events.find((event) =>
        event.message === "MCP OAuth refresh failed, using existing token"
      );
      expect(warning?.context).toEqual({ credentialId, error: refreshError });
    } finally {
      captured.dispose();
      await manager.disconnectAll().catch(() => {});
    }
  });
});
