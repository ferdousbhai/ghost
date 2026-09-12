import { homedir } from "node:os";
import { readBoard } from "./board.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiTokenMatches, readOrCreateApiToken } from "./api-token.js";
import { assertLoopback } from "./config.js";
import { REMOTE_MANIFEST, REMOTE_VIEWER_CSP, REMOTE_VIEWER_HTML } from "./remote-viewer.js";
import type { RemoteServe } from "./remote-serve.js";
import type { RemoteAccess, TailscaleIdentity } from "./tailscale-identity.js";
import type { AuthType, LoginManager } from "./auth.js";
import {
  requireConversationIdentity,
  type ConversationIdentity,
} from "./conversation-identity.js";
import type {
  McpCatalog,
  McpCatalogSnapshot,
  McpConnectionTest,
} from "./mcp-catalog.js";
import type { ModelSelection } from "./model-selection.js";
import {
  homeOperationsFor,
  type HomeOperationCoordinator,
} from "./home-operations.js";
import { MAX_CHARACTER_BODY_LENGTH, openGhostHome,
  resolveDocumentsDirectory,
} from "@ghost/extensions";
import {
  assertValidGhostName,
  GhostError,
  translateExtensionError,
  type GhostRegistry,
} from "./ghosts.js";
import type {
  GhostHookCommandConfig,
  GhostHookStatus,
  GhostHookRunner,
} from "./hooks.js";
import { silentLogger, type Logger } from "./log.js";
import {
  encodeSseEvent,
  parsePiMessagesRequest,
  PiMessagesRequestError,
  SSE_HEADERS,
  SSE_KEEPALIVE_COMMENT,
  SSE_KEEPALIVE_INTERVAL_MS,
  zeroUsage,
  type PiMessagesEvent,
} from "./pi-messages.js";
import { attachRelay, createRelayHub, type RelayHub } from "./relay.js";
import type { RunningSource } from "./running-source.js";
import type { UpdateAvailable } from "./update-check.js";
import type { SessionHost } from "./session-host.js";

export interface ServerOptions {
  registry: GhostRegistry;
  host: SessionHost;
  homeOperations?: HomeOperationCoordinator;
  /**
   * Provider login orchestration. Omit to leave the `/providers` and `/login`
   * routes out entirely (they 404) — a server that only ever runs turns needs
   * no login surface.
   */
  login?: LoginManager;
  /** Chat-model selection. Omit to leave the `/model` route out (it 404s). */
  models?: ModelSelection;
  /** What runs this daemon. Omitted, `GET /api/status` reports it as unknown. */
  runningSource?: RunningSource;
  /** The last update check's answer, for `GET /api/status`; omitted or null means none known. */
  update?: () => UpdateAvailable | null;
  mcp?: McpCatalog;
  hooks?: Pick<GhostHookRunner, "status" | "config" | "replaceConfig">;
  logger?: Logger;
  maxBodyBytes?: number;
  includeThinking?: boolean;
  /**
   * The browser relay. Omitted, one is built from the XDG token file unless
   * `GHOSTD_RELAY=off`; pass `null` to leave the endpoint out entirely.
   */
  relay?: RelayHub | null;
  /**
   * The bearer token every `/api` route but `GET /api/relay/status` requires.
   *
   * Omitted (the production default) it is read from — and minted into —
   * `$XDG_STATE_HOME/ghost/api-token`, so a client that reads that file is
   * authenticated and a web page that cannot read files is not. A string uses
   * that token instead, for tests that want to present one.
   *
   * `null` switches authentication off entirely. That is a **test-only**
   * escape hatch, for the many tests whose subject is routing or streaming
   * rather than auth; nothing that ships may pass it, because a daemon with
   * `apiToken: null` is exactly the CSRF hole issue #485 closed.
   */
  apiToken?: string | null;
  /** Callers reaching the daemon through `tailscale serve`; omit to admit none. */
  remote?: RemoteAccess | null;
  /** Owns the Tailscale Serve exposure and its QR code; omitted, the `/api/remote` routes 404. */
  remoteServe?: RemoteServe;
}

export interface ListeningServer {
  server: Server;
  port: number;
  address: string;
  relay: RelayHub | undefined;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
export const MAX_MODEL_QUERY_LENGTH = 256;
/**
 * A conversation name is a label in a sidebar, not a description. The cap is
 * generous for a sentence and short enough to stay a label.
 */
const MAX_CONVERSATION_TITLE_LENGTH = 120;
/** What `close()` needs from a server `createDaemonServer` built: streams to end and the relay to hang up. */
const serverState = new WeakMap<Server, {
  liveStreams: Set<ServerResponse>;
  relay: RelayHub | null | undefined;
}>();

/**
 * Same-origin is the intended deployment (the Omarchy webapp wraps
 * `http://127.0.0.1:<port>` directly), but a UI running on a dev server is a
 * different origin on the same loopback interface. Allow exactly that, and
 * nothing else — a page on a remote origin must not be able to read a
 * ghost's memory through the user's own browser.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;

/** Whether a browser origin names the host this request was addressed to. */
function sameHostOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function publicHookStatus(status: GhostHookStatus): GhostHookStatus {
  return {
    active: status.active,
    total: status.total,
    events: status.events.map(({ event, count }) => ({ event, count })),
    hooks: status.hooks.map(({ event, source, name, description, settingsKey }) => ({
      event,
      source,
      name,
      description,
      ...(source === "builtin" && settingsKey !== undefined ? { settingsKey } : {}),
    })),
  };
}

/**
 * The `{ error: { message, code } }` envelope is fixed by Ghost's HTTP contract
 * and in-repo consumers, not chosen here: the shell, CLI, and remote viewer all
 * parse the nested error from a non-2xx response. Flattening it silently breaks
 * those clients.
 */
function errorResponse(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  jsonResponse(response, status, { error: { message, code } });
}

function abortOnClose(
  request: IncomingMessage,
  response: ServerResponse,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.on("aborted", abort);
  response.on("close", abort);
  return {
    signal: controller.signal,
    release: () => {
      request.off("aborted", abort);
      response.off("close", abort);
    },
  };
}

class InvalidPathEncodingError extends Error {
  readonly code = "invalid_request";
  readonly status = 400;

  constructor() {
    super("URL path segments must use valid percent-encoding.");
    this.name = "InvalidPathEncodingError";
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) throw new InvalidPathEncodingError();
    throw error;
  }
}

function decodeConversationIdentity(segment: string): ConversationIdentity {
  return requireConversationIdentity(decodePathSegment(segment));
}

function bearerToken(header: string | string[] | undefined): string {
  if (typeof header !== "string") return "";
  const match = /^ *bearer +(\S+) *$/i.exec(header);
  return match?.[1] ?? "";
}

/**
 * `application/json`, parameters allowed (`; charset=utf-8`). The point is to
 * exclude the three types a form can post without a preflight —
 * `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data` —
 * so a mutating route cannot be reached by a simple cross-site request.
 */
function isJsonContentType(header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  return (header.split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !LOOPBACK_ORIGIN.test(origin)) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      throw new PiMessagesRequestError("payload_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    throw new PiMessagesRequestError("invalid_request", "Request body is required.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PiMessagesRequestError("invalid_request", "Request body must be JSON.");
  }
}

/**
 * The parsed request body as a JSON object. Anything else throws the
 * `invalid_request` the outer handler answers with a 400.
 */
async function readJsonObjectBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request, maxBytes);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new PiMessagesRequestError("invalid_request", "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/**
 * What `ServerOptions.apiToken` means. `undefined` is the machine-local token,
 * minted here rather than on the first authenticated request so a client that
 * starts alongside the daemon finds the file. `null` is no authentication at
 * all, which is test-only and says so out loud.
 */
function resolveApiToken(
  configured: string | null | undefined,
  logger: Logger,
): string | null {
  if (configured === null) {
    logger.warn("the HTTP API is running without authentication");
    return null;
  }
  if (configured !== undefined) return configured;
  const minted = readOrCreateApiToken();
  // The path, never the token: `ghostd api-token` is the only way to see it.
  logger.info(minted.created ? "minted the API token" : "API token loaded", {
    path: minted.path,
  });
  return minted.token;
}

export function createDaemonServer(options: ServerOptions): Server {
  const logger = options.logger ?? silentLogger;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const homeOperations = options.homeOperations ?? homeOperationsFor(options.registry);
  const liveStreams = new Set<ServerResponse>();
  // `undefined` means "decide for me"; `null` means "no relay on this server".
  const relay = options.relay === undefined
    ? createRelayHub({ ...(options.logger ? { logger: options.logger } : {}) })
    : options.relay;
  const apiToken = resolveApiToken(options.apiToken, logger);
  const remote = options.remote ?? null;
  const remoteServe = options.remoteServe;

  /**
   * The gate every `/api` request passes before it is routed: `null` when it
   * has already answered, otherwise who was admitted (a tailnet identity, or
   * `undefined` for the bearer token and the open routes).
   */
  const authenticate = async (
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    segments: readonly string[],
  ): Promise<{ identity: TailscaleIdentity | undefined } | null> => {
    const admitted = { identity: undefined };
    if (apiToken === null) return admitted;
    if (segments[0] !== "api") return admitted;
    // Deliberately open: it carries no secret, and a client with no token yet
    // may still need to ask whether the relay is up.
    if (segments[1] === "relay" && segments[2] === "status" && segments.length === 3) return admitted;

    // A page served by this daemon is loopback, or same-host through
    // `tailscale serve`; anything else is a cross-site page.
    const origin = request.headers.origin;
    if (typeof origin === "string" && !LOOPBACK_ORIGIN.test(origin) && !sameHostOrigin(origin, request.headers.host)) {
      errorResponse(response, 403, "forbidden_origin", "That origin may not call this daemon.");
      return null;
    }
    const presented = bearerToken(request.headers.authorization);
    const tokenOk = presented !== "" && apiTokenMatches(apiToken, presented);
    const identity = tokenOk ? undefined : (await remote?.identify(request)) ?? undefined;
    if (!tokenOk && !identity) {
      response.setHeader("www-authenticate", "Bearer");
      errorResponse(
        response,
        401,
        "unauthorized",
        "This API needs the machine-local bearer token. Run `ghostd api-token`.",
      );
      return null;
    }
    if (identity?.role === "guest" && method !== "GET") {
      errorResponse(response, 403, "read_only", "Tailnet guests can watch this ghost but not act for it.");
      return null;
    }
    if ((method === "POST" || method === "PUT") && !isJsonContentType(request.headers["content-type"])) {
      errorResponse(
        response,
        415,
        "unsupported_media_type",
        "Mutating requests must be application/json.",
      );
      return null;
    }
    return { identity };
  };

  const handleListGhosts = (response: ServerResponse): void => {
    jsonResponse(response, 200, options.registry.list());
  };

  /**
   * The owner's `hooks.json`, read and replaced whole. Whole-document
   * replacement keeps "groups run in file order" honest: there are no per-hook
   * ids to invent for a file that has none. The daemon's loader is the only
   * validator; a client shows its message rather than re-implementing the
   * schema.
   */
  const handleHookConfig = async (
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const hooks = options.hooks;
    const config = hooks?.config();
    if (!hooks || !config) {
      errorResponse(response, 404, "not_found", "Hook configuration is not available.");
      return;
    }
    if (method === "GET") {
      jsonResponse(response, 200, { path: config.path, document: config.document });
      return;
    }
    if (method !== "PUT") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const document = await readJsonBody(request, maxBodyBytes);
    let replaced: GhostHookCommandConfig;
    try {
      replaced = await hooks.replaceConfig(document);
    } catch (error) {
      errorResponse(response, 400, "invalid_request", (error as Error).message);
      return;
    }
    jsonResponse(response, 200, { path: replaced.path, document: replaced.document });
  };

  const handleCreateGhost = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const name = (body as { name?: unknown }).name;
    if (typeof name !== "string") {
      errorResponse(response, 400, "invalid_request", "\"name\" must be a string.");
      return;
    }
    const ghost = options.host.createGhost(name);
    logger.info("ghost created", { ghost: ghost.name });
    jsonResponse(response, 201, ghost);
  };

  /**
   * Trash one ghost. `?confirm=<name>` must repeat the name exactly: a DELETE
   * is one path segment away from every other ghost route, and this is the
   * API-level guard against an accidental or scripted one taking a persona and
   * its memory with it. The deletion itself is a move into the
   * system trash, never an erase.
   */
  const handleDeleteGhost = async (
    ghostName: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> => {
    if (url.searchParams.get("confirm") !== ghostName) {
      errorResponse(
        response,
        400,
        "confirmation_required",
        `Deleting a ghost needs its name repeated: ?confirm=${encodeURIComponent(ghostName)}.`,
      );
      return;
    }
    const releaseLoginMove = await options.login?.reserveGhostMove(ghostName);
    let releaseHomeMove: (() => void) | undefined;
    try {
      releaseHomeMove = await homeOperations.reserveMove(ghostName);
      const { trash } = await options.host.deleteGhost(ghostName);
      options.login?.forgetGhost(ghostName);
      logger.info("ghost deleted", { ghost: ghostName, trash });
      jsonResponse(response, 200, { ok: true, trash });
    } finally {
      releaseHomeMove?.();
      releaseLoginMove?.();
    }
  };

  const handleListSessions = async (
    ghostName: string,
    response: ServerResponse,
  ): Promise<void> => {
    jsonResponse(response, 200, { sessions: await options.host.listSessions(ghostName) });
  };

  /**
   * Passive conversation-list invalidations. This subscription never opens a
   * hosted session; disconnect cleanup drops both its listener and keepalive.
   */
  const handleConversationEvents = (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    options.registry.get(ghostName);
    let closed = false;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    const connection = abortOnClose(request, response);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      unsubscribe();
      liveStreams.delete(response);
      connection.release();
    };
    unsubscribe = options.host.subscribeConversationEvents(
      ghostName,
      (event) => {
        if (!closed && !response.writableEnded) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      },
      () => {
        cleanup();
        if (!response.writableEnded) response.end();
      },
    );
    response.writeHead(200, SSE_HEADERS);
    response.write(SSE_KEEPALIVE_COMMENT);
    liveStreams.add(response);
    keepalive = setInterval(() => {
      if (!closed && !response.writableEnded) response.write(SSE_KEEPALIVE_COMMENT);
    }, SSE_KEEPALIVE_INTERVAL_MS);
    connection.signal.addEventListener("abort", cleanup, { once: true });
  };

  const handleReadCharacter = async (
    ghostName: string,
    response: ServerResponse,
  ): Promise<void> => {
    const character = await homeOperations.withLease(ghostName, async () => {
      const ghost = options.registry.get(ghostName);
      try {
        return await openGhostHome(ghost.dir).readCharacter({ enforceLimit: false });
      } catch (error) {
        return translateExtensionError(error);
      }
    });
    jsonResponse(response, 200, {
      body: character?.body ?? "",
      limit: MAX_CHARACTER_BODY_LENGTH,
    });
  };

  const handleWriteCharacter = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { body: text } = body as { body?: unknown };
    if (typeof text !== "string") {
      errorResponse(response, 400, "invalid_request", '"body" must be a string.');
      return;
    }
    await homeOperations.withLease(ghostName, async () => {
      const ghost = options.registry.get(ghostName);
      try {
        await openGhostHome(ghost.dir).writeCharacter({ body: text });
      } catch (error) {
        return translateExtensionError(error);
      }
    });
    jsonResponse(response, 200, { ok: true, limit: MAX_CHARACTER_BODY_LENGTH });
  };

  const handleGreeting = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      await readJsonBody(request, maxBodyBytes);
    } catch (error) {
      // Greeting has no request fields; only a size violation is meaningful.
      if (error instanceof PiMessagesRequestError && error.code === "payload_too_large") throw error;
    }
    jsonResponse(response, 200, await options.host.greeting(ghostName));
  };

  const handleDeleteSession = async (
    ghostName: string,
    conversation: ConversationIdentity,
    response: ServerResponse,
  ): Promise<void> => {
    const { artifacts } = await options.host.deleteSession(
      ghostName,
      conversation.conversationId,
      conversation.runtime,
    );
    jsonResponse(response, 200, { ok: true, trash: artifacts });
  };

  /**
   * Pin or unpin one conversation. Idempotent, so the shell may send the state
   * it wants rather than a toggle it has to compute from a stale listing.
   */
  const handleSetSessionPin = async (
    ghostName: string,
    conversation: ConversationIdentity,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { pinned } = body as { pinned?: unknown };
    if (typeof pinned !== "boolean") {
      errorResponse(response, 400, "invalid_request", "\"pinned\" must be a boolean.");
      return;
    }
    await options.host.setPinned(
      ghostName,
      conversation.conversationId,
      pinned,
      conversation.runtime,
    );
    jsonResponse(response, 200, { ok: true, pinned });
  };

  const handleMarkSessionRead = async (
    ghostName: string,
    conversation: ConversationIdentity,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    await readJsonObjectBody(request, maxBodyBytes);
    const readAt = await options.host.markRead(
      ghostName,
      conversation.conversationId,
      undefined,
      conversation.runtime,
    );
    jsonResponse(response, 200, { ok: true, readAt });
  };

  const handleRenameSession = async (
    ghostName: string,
    conversation: ConversationIdentity,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { title } = body as { title?: unknown };
    if (typeof title !== "string") {
      errorResponse(response, 400, "invalid_request", "\"title\" must be a string.");
      return;
    }
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      errorResponse(response, 400, "invalid_request", "\"title\" must not be empty.");
      return;
    }
    if (trimmed.length > MAX_CONVERSATION_TITLE_LENGTH) {
      errorResponse(
        response,
        400,
        "invalid_request",
        `"title" must be at most ${MAX_CONVERSATION_TITLE_LENGTH} characters.`,
      );
      return;
    }
    const stored = await options.host.renameConversation(
      ghostName,
      conversation.conversationId,
      trimmed,
      conversation.runtime,
    );
    jsonResponse(response, 200, { ok: true, title: stored });
  };

  const handleSessionCommands = async (
    ghostName: string,
    conversation: ConversationIdentity,
    response: ServerResponse,
  ): Promise<void> => {
    jsonResponse(response, 200, {
      commands: await options.host.availableCommands(
        ghostName,
        conversation.conversationId,
        conversation.runtime,
      ),
    });
  };

  const handleSessionResources = async (
    ghostName: string,
    conversation: ConversationIdentity,
    response: ServerResponse,
  ): Promise<void> => {
    jsonResponse(
      response,
      200,
      await options.host.admittedResources(
        ghostName,
        conversation.conversationId,
        conversation.runtime,
      ),
    );
  };

  const decorateMcpSnapshot = (
    ghostName: string,
    snapshot: McpCatalogSnapshot,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    ...snapshot,
    servers: snapshot.servers.map((server) => ({
      ...server,
      connectionStatus: server.enabled
        ? options.host.mcpConnectionStatus(ghostName, server.name)
        : "disabled",
    })),
    ...extra,
  });

  const mcpSnapshotLeased = async (
    ghostName: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    if (!options.mcp) {
      throw new GhostError("not_found", "MCP management is not enabled on this daemon.", 404);
    }
    return decorateMcpSnapshot(ghostName, await options.mcp.listLeased(ghostName), extra);
  };

  const mcpSnapshot = (
    ghostName: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => homeOperations.withLease(
    ghostName,
    () => mcpSnapshotLeased(ghostName, extra),
  );

  const mutateMcp = async (
    ghostName: string,
    mutation: () => Promise<McpCatalogSnapshot>,
  ): Promise<Record<string, unknown>> => homeOperations.withLease(ghostName, async () => {
    // Catalog mutations already return the freshly read durable view. Keep
    // that write inside the MCP transition, then inspect connection state only
    // after every live manager has finished reloading.
    const snapshot = await options.host.withMcpReload(ghostName, mutation);
    return decorateMcpSnapshot(ghostName, snapshot);
  });

  const handleMcpCollection = async (
    ghostName: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const mcp = options.mcp;
    if (!mcp) {
      errorResponse(response, 404, "not_found", "MCP management is not enabled on this daemon.");
      return;
    }
    if (method === "GET") {
      jsonResponse(response, 200, await mcpSnapshot(ghostName));
      return;
    }
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { name, config } = body as { name?: unknown; config?: unknown };
    if (typeof name !== "string") {
      errorResponse(response, 400, "invalid_request", '"name" must be a string.');
      return;
    }
    const snapshot = await mutateMcp(
      ghostName,
      () => mcp.addLeased(ghostName, name, config),
    );
    jsonResponse(response, 201, snapshot);
  };

  const handleMcpServer = async (
    ghostName: string,
    serverName: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const mcp = options.mcp;
    if (!mcp) {
      errorResponse(response, 404, "not_found", "MCP management is not enabled on this daemon.");
      return;
    }
    if (method === "DELETE") {
      const snapshot = await mutateMcp(
        ghostName,
        () => mcp.removeLeased(ghostName, serverName),
      );
      jsonResponse(response, 200, snapshot);
      return;
    }
    if (method !== "PUT") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const snapshot = await mutateMcp(
      ghostName,
      () => mcp.updateLeased(ghostName, serverName, (body as { config?: unknown }).config),
    );
    jsonResponse(response, 200, snapshot);
  };

  const handleMcpEnabled = async (
    ghostName: string,
    serverName: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const mcp = options.mcp;
    if (!mcp) {
      errorResponse(response, 404, "not_found", "MCP management is not enabled on this daemon.");
      return;
    }
    if (method !== "PUT") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const snapshot = await mutateMcp(
      ghostName,
      () => mcp.setEnabledLeased(
        ghostName,
        serverName,
        (body as { enabled?: unknown }).enabled as boolean,
      ),
    );
    jsonResponse(response, 200, snapshot);
  };

  const handleMcpAction = async (
    ghostName: string,
    serverName: string,
    action: "test" | "reconnect",
    method: string,
    response: ServerResponse,
  ): Promise<void> => {
    const mcp = options.mcp;
    if (!mcp) {
      errorResponse(response, 404, "not_found", "MCP management is not enabled on this daemon.");
      return;
    }
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const snapshot = await homeOperations.withLease(ghostName, async () => {
      let result: McpConnectionTest | { name: string; status: string; ok: boolean };
      if (action === "test") {
        result = await mcp.testLeased(ghostName, serverName);
      } else {
        const exists = (await mcp.listLeased(ghostName)).servers.some(
          (server) => server.name === serverName,
        );
        if (!exists) {
          throw new GhostError(
            "mcp_server_not_found",
            `No MCP server named ${JSON.stringify(serverName)}.`,
            404,
          );
        }
        const status = await options.host.reconnectMcpLeased(ghostName, serverName);
        result = { name: serverName, status, ok: status === "connected" };
      }
      return mcpSnapshotLeased(ghostName, { result });
    });
    jsonResponse(response, 200, snapshot);
  };

  /**
   * Rename one ghost. The name is the home directory's name, so this moves the
   * whole home and every other route's `:name` changes with it — which is why
   * it is the same body shape `POST /api/ghosts` takes, validated the same way.
   */
  const handleRenameGhost = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const name = (body as { name?: unknown }).name;
    if (typeof name !== "string") {
      errorResponse(response, 400, "invalid_request", "\"name\" must be a string.");
      return;
    }
    // Keep the route's contract ordering: validate the destination before the
    // login coordinator resolves the source home.
    assertValidGhostName(name);
    if (name === ghostName) {
      const renamed = await options.host.renameGhost(ghostName, name);
      logger.info("ghost renamed", { ghost: ghostName, name: renamed.name });
      jsonResponse(response, 200, { ok: true, name: renamed.name });
      return;
    }
    const releaseLoginMove = await options.login?.reserveGhostMove(ghostName);
    let releaseHomeMove: (() => void) | undefined;
    try {
      releaseHomeMove = await homeOperations.reserveMove(ghostName);
      const renamed = await options.host.renameGhost(ghostName, name);
      options.login?.renameGhost(renamed);
      logger.info("ghost renamed", { ghost: ghostName, name: renamed.name });
      jsonResponse(response, 200, { ok: true, name: renamed.name });
    } finally {
      releaseHomeMove?.();
      releaseLoginMove?.();
    }
  };

  const handleTranscript = async (
    ghostName: string,
    conversation: ConversationIdentity,
    url: URL,
    response: ServerResponse,
  ): Promise<void> => {
    const query: { limit?: number; offset?: number } = {};
    const limit = url.searchParams.get("limit");
    if (limit !== null) {
      const parsed = Number(limit);
      if (!Number.isFinite(parsed)) {
        errorResponse(response, 400, "invalid_request", "\"limit\" must be a number.");
        return;
      }
      query.limit = parsed;
    }
    const offset = url.searchParams.get("offset");
    if (offset !== null) {
      const parsed = Number(offset);
      if (!Number.isFinite(parsed)) {
        errorResponse(response, 400, "invalid_request", "\"offset\" must be a number.");
        return;
      }
      query.offset = parsed;
    }
    jsonResponse(response, 200, await options.host.readTranscript(
      ghostName,
      conversation.conversationId,
      query,
      conversation.runtime,
    ));
  };

  const handleListProviders = async (
    ghostName: string,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.login) {
      errorResponse(response, 404, "not_found", "Login is not enabled on this daemon.");
      return;
    }
    jsonResponse(response, 200, { providers: await options.login.listProviders(ghostName) });
  };

  const handleStartLogin = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.login) {
      errorResponse(response, 404, "not_found", "Login is not enabled on this daemon.");
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { providerId, authType } = body as {
      providerId?: unknown;
      authType?: unknown;
    };
    if (typeof providerId !== "string") {
      errorResponse(response, 400, "invalid_request", "\"providerId\" must be a string.");
      return;
    }
    if (authType !== "oauth" && authType !== "api_key") {
      errorResponse(response, 400, "invalid_request", "\"authType\" must be \"oauth\" or \"api_key\".");
      return;
    }
    const view = await options.login.start(ghostName, providerId, authType as AuthType);
    // The status line stays 200; a failed login is a state the client polls,
    // not an HTTP error.
    jsonResponse(response, 201, view);
  };

  const handleLogout = async (
    ghostName: string,
    providerId: string,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.login) {
      errorResponse(response, 404, "not_found", "Login is not enabled on this daemon.");
      return;
    }
    await options.login.logout(ghostName, providerId);
    jsonResponse(response, 200, { ok: true, providerId });
  };

  const handleLoginStatus = (
    ghostName: string,
    loginId: string,
    response: ServerResponse,
  ): void => {
    if (!options.login) {
      errorResponse(response, 404, "not_found", "Login is not enabled on this daemon.");
      return;
    }
    jsonResponse(response, 200, options.login.view(ghostName, loginId));
  };

  const handleLoginInput = async (
    ghostName: string,
    loginId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.login) {
      errorResponse(response, 404, "not_found", "Login is not enabled on this daemon.");
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const value = (body as { value?: unknown }).value;
    if (typeof value !== "string") {
      errorResponse(response, 400, "invalid_request", "\"value\" must be a string.");
      return;
    }
    jsonResponse(response, 200, options.login.submitInput(ghostName, loginId, value));
  };

  const handleCurrentModel = async (
    ghostName: string,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.models) {
      errorResponse(response, 404, "not_found", "Model selection is not enabled on this daemon.");
      return;
    }
    jsonResponse(response, 200, await options.models.getCurrent(ghostName));
  };

  const handleSetModel = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.models) {
      errorResponse(response, 404, "not_found", "Model selection is not enabled on this daemon.");
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { provider, id } = body as { provider?: unknown; id?: unknown };
    if (typeof provider !== "string" || provider === "") {
      errorResponse(response, 400, "invalid_request", "\"provider\" must be a non-empty string.");
      return;
    }
    if (typeof id !== "string" || id === "") {
      errorResponse(response, 400, "invalid_request", "\"id\" must be a non-empty string.");
      return;
    }
    jsonResponse(response, 200, await options.models.setChatModel(ghostName, provider, id));
  };

  const streamSessionEvents = async (
    request: IncomingMessage,
    response: ServerResponse,
    run: (emit: (event: PiMessagesEvent) => void, signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    const connection = abortOnClose(request, response);
    response.writeHead(200, SSE_HEADERS);
    response.write(SSE_KEEPALIVE_COMMENT);
    // A turn can idle behind a slow model; keep the connection warm. Ghost's
    // in-repo SSE parsers skip frames without a `data:` line, so a comment costs
    // nothing on the far end.
    const keepalive = setInterval(() => {
      if (!response.writableEnded) response.write(SSE_KEEPALIVE_COMMENT);
    }, SSE_KEEPALIVE_INTERVAL_MS);
    liveStreams.add(response);

    let terminal = false;
    const emit = (event: PiMessagesEvent): void => {
      if (response.writableEnded || terminal) return;
      if (event.type === "done" || event.type === "error") terminal = true;
      response.write(encodeSseEvent(event));
    };

    try {
      await run(emit, connection.signal);
      // Keep the HTTP seam honest even if a runtime regresses. The shell also
      // treats EOF without a terminal frame as failure, but emitting the error
      // here preserves one protocol invariant for every client and runtime.
      if (!terminal && !connection.signal.aborted) {
        emit({
          type: "error",
          reason: "error",
          usage: zeroUsage(),
          errorMessage: "The turn ended without a terminal event.",
        });
      }
    } catch (error) {
      // runTurn guarantees a terminal event for anything that happens inside
      // the turn; this path is for the refusals it throws instead (a busy
      // session), which still have to reach the client in-stream because the
      // status line is already sent.
      emit({
        type: "error",
        reason: "error",
        usage: zeroUsage(),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(keepalive);
      liveStreams.delete(response);
      connection.release();
      if (!response.writableEnded) response.end();
    }
  };

  const handleMessages = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    // Fail before any byte of the stream, so the client sees a real status
    // code rather than an SSE error event it has to unwrap.
    const ghost = options.registry.get(ghostName);
    const parsed = parsePiMessagesRequest(await readJsonBody(request, maxBodyBytes));
    const admission = await options.host.admitTurn(ghost.name, {
      sessionId: parsed.sessionId,
      prompt: parsed.prompt,
    });
    try {
      await streamSessionEvents(request, response, (emit, signal) =>
        admission.run({
          emit,
          signal,
          includeThinking: options.includeThinking,
        }));
    } finally {
      // Covers a response failure before the stream callback consumes the
      // admission; ordinary run completion releases it first.
      admission.release();
    }
  };

  const handleBranch = async (
    ghostName: string,
    conversation: ConversationIdentity,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { action, entryId } = body as { action?: unknown; entryId?: unknown };
    if (typeof entryId !== "string" || entryId === "") {
      errorResponse(response, 400, "invalid_request", '"entryId" must be a non-empty string.');
      return;
    }
    if (action === "fork") {
      jsonResponse(
        response,
        200,
        await options.host.forkConversation(
          ghostName,
          conversation.conversationId,
          entryId,
          conversation.runtime,
        ),
      );
      return;
    }
    errorResponse(response, 400, "invalid_request", '"action" must be "fork".');
  };

  const handleAskReanswer = async (
    ghostName: string,
    conversation: ConversationIdentity,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { entryId } = body as { entryId?: unknown };
    if (typeof entryId !== "string" || entryId === "") {
      errorResponse(response, 400, "invalid_request", '"entryId" must be a non-empty string.');
      return;
    }
    options.registry.get(ghostName);
    await streamSessionEvents(request, response, (emit, signal) =>
      options.host.runAskReanswer(ghostName, {
        sessionId: conversation.conversationId,
        runtime: conversation.runtime,
        entryId,
        emit,
        signal,
        includeThinking: options.includeThinking,
      }));
  };

  const handleAsk = async (
    ghostName: string,
    conversation: ConversationIdentity,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, { ask: options.host.pendingAsk(
        ghostName,
        conversation.conversationId,
        conversation.runtime,
      ) });
      return;
    }
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { askId, ...answer } = body;
    if (typeof askId !== "string" || askId === "") {
      errorResponse(response, 400, "invalid_request", '"askId" must be a non-empty string.');
      return;
    }
    options.host.answerAsk(
      ghostName,
      conversation.conversationId,
      askId,
      answer,
      conversation.runtime,
    );
    jsonResponse(response, 200, { accepted: true });
  };

  const handleQueue = async (
    ghostName: string,
    conversation: ConversationIdentity,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, options.host.queuedMessages(
        ghostName,
        conversation.conversationId,
        conversation.runtime,
      ));
      return;
    }
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { mode, text } = body as { mode?: unknown; text?: unknown };
    if (mode !== "steer" && mode !== "followUp") {
      errorResponse(response, 400, "invalid_request", '"mode" must be "steer" or "followUp".');
      return;
    }
    if (typeof text !== "string" || text.trim() === "") {
      errorResponse(response, 400, "invalid_request", '"text" must be a non-empty string.');
      return;
    }
    jsonResponse(
      response,
      200,
      await options.host.queueMessage(
        ghostName,
        conversation.conversationId,
        mode,
        text.trim(),
        conversation.runtime,
      ),
    );
  };

  const server = createServer((request, response) => {
    // Nothing a request carries may take the process down. A throw anywhere
    // in the handler answers 500 (or is logged when the reply already began)
    // instead of becoming an unhandled rejection, which exits Bun — a path
    // of "//" once did exactly that, from the tailnet viewer.
    void (async () => {
      applyCors(request, response);
      const method = request.method ?? "GET";
      if (method === "OPTIONS") {
        // A preflight cannot carry credentials — that is what it is asking
        // permission to do. Answering it reveals nothing.
        response.writeHead(204).end();
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        errorResponse(response, 400, "invalid_request", "The request path is not a valid URL.");
        return;
      }
      const segments = url.pathname.split("/").filter(Boolean);
      const admission = await authenticate(request, response, method, segments);
      if (!admission) return;

      try {
        if (segments.length === 0) {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": REMOTE_VIEWER_CSP,
            "cache-control": "no-store",
          });
          response.end(REMOTE_VIEWER_HTML);
          return;
        }
        if (segments.length === 1 && segments[0] === "manifest.webmanifest") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          const manifest = JSON.stringify(REMOTE_MANIFEST);
          response.writeHead(200, {
            "content-type": "application/manifest+json; charset=utf-8",
            "content-length": Buffer.byteLength(manifest),
            "cache-control": "no-store",
          });
          response.end(manifest);
          return;
        }
        if (segments[0] !== "api") {
          errorResponse(response, 404, "not_found", "Not found.");
          return;
        }
        if (segments.length === 3 && segments[1] === "remote" && segments[2] === "whoami") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          const identity = admission.identity;
          jsonResponse(response, 200, identity ? { login: identity.login, role: identity.role, ...(identity.name ? { name: identity.name } : {}) } : { login: null, role: "owner" });
          return;
        }
        if (segments.length === 3 && segments[1] === "remote" && segments[2] === "qr.svg") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          const url = remoteServe ? (await remoteServe.status()).url : null;
          if (!remoteServe || !url) {
            errorResponse(response, 404, "not_found", "Remote access is off.");
            return;
          }
          const svg = await remoteServe.qrSvg(url);
          response.writeHead(200, {
            "content-type": "image/svg+xml; charset=utf-8",
            "content-length": Buffer.byteLength(svg),
            "cache-control": "no-store",
          });
          response.end(svg);
          return;
        }
        if (segments.length === 2 && segments[1] === "remote") {
          if (!remoteServe) {
            errorResponse(response, 404, "not_found", "Remote access is not available.");
            return;
          }
          if (method === "GET") {
            jsonResponse(response, 200, await remoteServe.status());
            return;
          }
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          const body = await readJsonObjectBody(request, maxBodyBytes);
          if (typeof (body as { enabled?: unknown }).enabled !== "boolean") {
            errorResponse(response, 400, "invalid_request", '"enabled" must be a boolean.');
            return;
          }
          jsonResponse(response, 200, await remoteServe.setEnabled((body as { enabled: boolean }).enabled));
          return;
        }
        if (segments[1] === "relay" && segments[2] === "status" && segments.length === 3) {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          // Never the token itself, only where it lives. This route is the one
          // `/api` path exempt from the bearer token and the origin check, so
          // anything it returns is readable by anything that can reach the port.
          jsonResponse(response, 200, relay
            ? { enabled: true, ...relay.status() }
            : { enabled: false, connected: false, reason: "The relay is off (GHOSTD_RELAY)." });
          return;
        }
        if (segments[1] === "relay" && segments[2] === "pair" && segments.length === 3) {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          if (!relay) {
            errorResponse(response, 404, "not_found", "The relay is off (GHOSTD_RELAY).");
            return;
          }
          const body = await readJsonObjectBody(request, maxBodyBytes) as {
            code?: unknown;
            allow?: unknown;
          };
          if (typeof body.code !== "string" || typeof body.allow !== "boolean") {
            errorResponse(
              response,
              400,
              "invalid_request",
              '"code" must be the pairing code shown in the browser and "allow" a boolean.',
            );
            return;
          }
          const outcome = relay.resolvePairing(body.code.trim(), body.allow);
          if (outcome === "unknown") {
            errorResponse(
              response,
              404,
              "pairing_not_found",
              "No browser is waiting to pair with that code.",
            );
            return;
          }
          jsonResponse(response, 200, { ok: true, outcome, ...relay.status() });
          return;
        }
        if (segments.length === 3 && segments[1] === "hooks" && segments[2] === "config") {
          return await handleHookConfig(method, request, response);
        }
        if (segments.length === 2 && segments[1] === "hooks") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          jsonResponse(response, 200, publicHookStatus(options.hooks?.status() ?? {
            active: false,
            total: 0,
            events: [],
            hooks: [],
          }));
          return;
        }
        if (segments.length === 2 && segments[1] === "board") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          // The owner's board.md, parsed. Guests may read it: it is the one
          // owner document meant to be looked at, and it is read-only here.
          jsonResponse(response, 200, await readBoard(resolveDocumentsDirectory(process.env, homedir())));
          return;
        }
        if (segments.length === 2 && segments[1] === "status") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          // `root` is a filesystem path, so the whole row is the owner's alone.
          if (admission.identity?.role === "guest") {
            errorResponse(
              response,
              403,
              "owner_only",
              "Daemon source paths are visible only to the owner.",
            );
            return;
          }
          jsonResponse(response, 200, {
            version: options.runningSource?.version ?? null,
            source: {
              commit: options.runningSource?.commit ?? null,
              root: options.runningSource?.root ?? null,
            },
            update: options.update?.() ?? null,
          });
          return;
        }
        if (segments[1] !== "ghosts") {
          errorResponse(response, 404, "not_found", "Not found.");
          return;
        }
        if (segments.length === 2) {
          if (method === "GET") return handleListGhosts(response);
          if (method === "POST") return await handleCreateGhost(request, response);
          errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
          return;
        }
        const ghostName = decodePathSegment(segments[2] ?? "");
        if (segments.length === 3 && method === "DELETE") {
          return await handleDeleteGhost(ghostName, url, response);
        }
        if (segments.length === 4 && segments[3] === "character") {
          if (method === "GET") return await handleReadCharacter(ghostName, response);
          if (method === "PUT") return await handleWriteCharacter(ghostName, request, response);
          errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
          return;
        }
        if (segments.length === 4 && segments[3] === "messages") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleMessages(ghostName, request, response);
        }
        if (segments.length === 4 && segments[3] === "events") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return handleConversationEvents(ghostName, request, response);
        }
        if (segments.length === 4 && segments[3] === "name") {
          if (method !== "PUT") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleRenameGhost(ghostName, request, response);
        }
        if (segments.length === 4 && segments[3] === "greeting") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleGreeting(ghostName, request, response);
        }
        if (segments.length === 4 && segments[3] === "sessions") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleListSessions(ghostName, response);
        }
        if (segments.length === 5 && segments[3] === "sessions") {
          if (method !== "DELETE") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleDeleteSession(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "pin") {
          if (method !== "PUT") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleSetSessionPin(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "read") {
          if (method !== "PUT") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleMarkSessionRead(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "title") {
          if (method !== "PUT") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleRenameSession(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "commands") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleSessionCommands(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "resources") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          if (admission.identity?.role === "guest") {
            errorResponse(
              response,
              403,
              "owner_only",
              "Session resource paths are visible only to the owner.",
            );
            return;
          }
          return await handleSessionResources(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "transcript") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleTranscript(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            url,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "ask") {
          return await handleAsk(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "queue") {
          return await handleQueue(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "branch") {
          return await handleBranch(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "reanswer") {
          return await handleAskReanswer(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 4 && segments[3] === "mcp") {
          return await handleMcpCollection(ghostName, method, request, response);
        }
        if (segments.length === 5 && segments[3] === "mcp") {
          return await handleMcpServer(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "mcp" && segments[5] === "enabled") {
          return await handleMcpEnabled(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (
          segments.length === 6
          && segments[3] === "mcp"
          && (segments[5] === "test" || segments[5] === "reconnect")
        ) {
          return await handleMcpAction(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            segments[5],
            method,
            response,
          );
        }
        if (segments.length === 4 && segments[3] === "model") {
          if (method === "GET") return await handleCurrentModel(ghostName, response);
          if (method === "PUT") return await handleSetModel(ghostName, request, response);
          errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
          return;
        }
        if (segments.length === 4 && segments[3] === "providers") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleListProviders(ghostName, response);
        }
        if (segments.length === 5 && segments[3] === "providers") {
          if (method !== "DELETE") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleLogout(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            response,
          );
        }
        if (segments.length === 4 && segments[3] === "login") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleStartLogin(ghostName, request, response);
        }
        if (segments.length === 5 && segments[3] === "login") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return handleLoginStatus(ghostName, decodePathSegment(segments[4] ?? ""), response);
        }
        if (segments.length === 6 && segments[3] === "login" && segments[5] === "input") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleLoginInput(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            request,
            response,
          );
        }
        errorResponse(response, 404, "not_found", "Not found.");
      } catch (error) {
        if (response.headersSent) {
          logger.error("request failed after headers were sent", {
            path: url.pathname,
            error: (error as Error).message,
          });
          if (!response.writableEnded) response.end();
          return;
        }
        if (error instanceof GhostError) {
          errorResponse(response, error.status, error.code, error.message);
          return;
        }
        if (error instanceof PiMessagesRequestError) {
          if (error.code === "payload_too_large") {
            errorResponse(response, 413, error.code, error.message);
            // Answer and hang up rather than reading the rest of a body we
            // have already refused.
            response.once("finish", () => request.destroy());
            return;
          }
          errorResponse(response, 400, error.code, error.message);
          return;
        }
        if (error instanceof InvalidPathEncodingError) {
          errorResponse(response, error.status, error.code, error.message);
          return;
        }
        logger.error("request failed", {
          path: url.pathname,
          error: (error as Error).message,
        });
        errorResponse(response, 500, "internal_error", "The daemon failed to handle the request.");
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("request handler failed", { method: request.method ?? "GET", error: message });
      if (!response.headersSent) {
        errorResponse(response, 500, "internal_error", "The daemon could not handle this request.");
      } else {
        try {
          response.destroy();
        } catch {
          // The socket is already gone.
        }
      }
    });
  });

  if (relay) {
    attachRelay(server, relay);
  } else {
    // Without a relay there is no upgrade handler, and Node leaves an unhandled
    // upgrade socket open forever. Hang up rather than leaking it.
    server.on("upgrade", (_request, socket) => socket.destroy());
  }

  // Exposed so close() can end streams that would otherwise hold shutdown open.
  serverState.set(server, { liveStreams, relay });
  return server;
}

export function relayHubOf(server: Server): RelayHub | undefined {
  return serverState.get(server)?.relay ?? undefined;
}

export async function startDaemonServer(
  options: ServerOptions & { port: number; address?: string },
): Promise<ListeningServer> {
  const address = options.address ?? "127.0.0.1";
  assertLoopback(address);
  const server = createDaemonServer(options);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, address, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const bound = server.address() as AddressInfo;
  const relay = relayHubOf(server);
  // The port is only known now, and the extension has to be told which one.
  relay?.setPublicUrl(`ws://${address}:${bound.port}/relay`);
  return {
    server,
    port: bound.port,
    address,
    relay,
    close: async () => {
      // Hang up on the browser before closing the listener: a live WebSocket is
      // an open connection, and `server.close()` waits for those.
      await relay?.close();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        for (const stream of serverState.get(server)?.liveStreams ?? []) {
          if (!stream.writableEnded) stream.end();
        }
        server.close((error) => {
          if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
            resolvePromise();
          } else {
            rejectPromise(error);
          }
        });
        // Keep-alive sockets would otherwise hold the close open until they
        // time out; a local daemon should exit when it is told to.
        server.closeIdleConnections();
      });
    },
  };
}
