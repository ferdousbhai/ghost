import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute } from "node:path";
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
import {
  listGhostMemory,
  trashGhostMemoryFile,
  writeGhostMemory,
} from "./memory-files.js";
import type {
  McpCatalog,
  McpCatalogSnapshot,
  McpConnectionTest,
} from "./mcp-catalog.js";
import type { ListModelsQuery, ModelCatalog, ModelScope } from "./model-catalog.js";
import type { NativeHarnessCatalog } from "./native-harness-catalog.js";
import {
  homeOperationsFor,
  type HomeOperationCoordinator,
} from "./home-operations.js";
import { assertValidGhostName, GhostError, type GhostRegistry } from "./ghosts.js";
import type {
  GhostHookCommandConfig,
  GhostHookStatus,
  GhostHookRunner,
} from "./hooks.js";
import { GHOST_MODEL_ROLES, type GhostModelRole } from "./models.js";
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
import {
  DEFAULT_LISTED_TASKS,
  MAX_LISTED_TASKS,
  taskProjection,
} from "./principal-task-tools.js";
import type { SessionHost } from "./session-host.js";
import { isValidTaskAgent, MAX_TASK_TEXT } from "./tasks.js";

export interface ServerOptions {
  registry: GhostRegistry;
  host: SessionHost;
  homeOperations?: HomeOperationCoordinator;
  /** Test seam for pausing the plain owner memory listing. */
  memoryReader?: typeof listGhostMemory;
  /** Test seam for pausing the validated owner memory writer. */
  memoryWriter?: typeof writeGhostMemory;
  /** Test seam for pausing the memory-to-Trash move. */
  memoryTrasher?: (
    ...args: Parameters<typeof trashGhostMemoryFile>
  ) => ReturnType<typeof trashGhostMemoryFile> | Promise<ReturnType<typeof trashGhostMemoryFile>>;
  /**
   * Provider login orchestration. Omit to leave the `/providers` and `/login`
   * routes out entirely (they 404) — a server that only ever runs turns needs
   * no login surface.
   */
  login?: LoginManager;
  /**
   * The per-ghost model indicator + switcher. Omit to leave the `/model` and
   * `/models` routes out entirely (they 404) — a server that only runs turns
   * needs no switcher surface.
   */
  catalog?: ModelCatalog;
  /** Read-only, sanitized native coding-worker availability. */
  nativeHarnesses?: Pick<NativeHarnessCatalog, "list">;
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
const MAX_TASK_CWD_BYTES = 4_096;
const TURN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const LIVE_STREAMS = Symbol.for("ghostd.liveStreams");
const RELAY_HUB = Symbol.for("ghostd.relayHub");

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
    hooks: status.hooks.map(({ event, source, name, description, idleSeconds, settingsKey }) => ({
      event,
      source,
      name,
      description,
      ...(event === "conversation_idle" && idleSeconds !== undefined ? { idleSeconds } : {}),
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

function exactObjectKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
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
  response.setHeader("access-control-allow-headers", "content-type, authorization, x-ghost-turn-id");
  response.setHeader("access-control-expose-headers", "x-ghost-turn-id");
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
  const memoryReader = options.memoryReader ?? listGhostMemory;
  const memoryWriter = options.memoryWriter ?? writeGhostMemory;
  const memoryTrasher = options.memoryTrasher ?? trashGhostMemoryFile;
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

  /**
   * The owner's memory list: the plain files, read from disk on every request.
   */
  const handleListMemory = async (
    ghostName: string,
    response: ServerResponse,
  ): Promise<void> => {
    const listing = await homeOperations.withLease(ghostName, () => {
      const ghost = options.registry.get(ghostName);
      return memoryReader(ghost.dir);
    });
    jsonResponse(response, 200, listing);
  };

  const handleWriteMemory = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { content, name } = body as { content?: unknown; name?: unknown };
    if (typeof content !== "string") {
      errorResponse(response, 400, "invalid_request", '"content" must be a string.');
      return;
    }
    if (name !== undefined && typeof name !== "string") {
      errorResponse(response, 400, "invalid_request", '"name" must be a string when present.');
      return;
    }
    const written = await homeOperations.withLease(ghostName, async () => {
      const ghost = options.registry.get(ghostName);
      return memoryWriter(ghost.dir, { content, name });
    });
    jsonResponse(response, 200, { ok: true, ...written });
  };

  const handleTrashMemory = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { path, confirm } = body as { path?: unknown; confirm?: unknown };
    if (typeof path !== "string" || path === "") {
      errorResponse(response, 400, "invalid_request", '"path" must be a non-empty string.');
      return;
    }
    if (confirm !== path) {
      errorResponse(
        response,
        400,
        "confirmation_required",
        '"confirm" must exactly repeat the memory file path.',
      );
      return;
    }
    const trashed = await homeOperations.withLease(ghostName, () => {
      const ghost = options.registry.get(ghostName);
      return memoryTrasher(ghost.dir, path);
    });
    jsonResponse(response, 200, { ok: true, ...trashed });
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

  const handleLiveVoice = async (
    ghostName: string,
    conversation: ConversationIdentity,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, options.host.liveVoiceStatus(
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
    const action = (body as { action?: unknown }).action;
    if (action !== "start" && action !== "mute" && action !== "unmute" && action !== "stop") {
      errorResponse(
        response,
        400,
        "invalid_request",
        '"action" must be "start", "mute", "unmute", or "stop".',
      );
      return;
    }
    jsonResponse(
      response,
      action === "start" ? 201 : 200,
      await options.host.liveVoiceAction(
        ghostName,
        conversation.conversationId,
        action,
        conversation.runtime,
      ),
    );
  };

  const handleCollaboration = async (
    ghostName: string,
    conversation: ConversationIdentity,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, options.host.collaborationStatus(
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
    const { action, relayUrl, writable, confirmed } = body as {
      action?: unknown;
      relayUrl?: unknown;
      writable?: unknown;
      confirmed?: unknown;
    };
    if (action !== "start" && action !== "stop") {
      errorResponse(response, 400, "invalid_request", '"action" must be "start" or "stop".');
      return;
    }
    if (action === "start" && typeof writable !== "boolean") {
      errorResponse(response, 400, "invalid_request", '"writable" must be a boolean.');
      return;
    }
    if (relayUrl !== undefined && typeof relayUrl !== "string") {
      errorResponse(response, 400, "invalid_request", '"relayUrl" must be a string.');
      return;
    }
    jsonResponse(
      response,
      action === "start" ? 201 : 200,
      await options.host.collaborationAction(
        ghostName,
        conversation.conversationId,
        {
          action,
          ...(typeof relayUrl === "string" ? { relayUrl } : {}),
          ...(typeof writable === "boolean" ? { writable } : {}),
          confirmed: confirmed === true,
        },
        conversation.runtime,
      ),
    );
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

  const handleRecap = async (
    ghostName: string,
    conversation: ConversationIdentity,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    await readJsonObjectBody(request, maxBodyBytes);

    const connection = abortOnClose(request, response);
    try {
      const recap = await options.host.recap(
        ghostName,
        conversation.conversationId,
        conversation.runtime,
        connection.signal,
      );
      if (!response.writableEnded && !connection.signal.aborted) {
        jsonResponse(response, 200, { recap });
      }
    } finally {
      connection.release();
    }
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
    const { providerId, authType, account = "personal" } = body as {
      providerId?: unknown;
      authType?: unknown;
      account?: unknown;
    };
    if (typeof providerId !== "string") {
      errorResponse(response, 400, "invalid_request", "\"providerId\" must be a string.");
      return;
    }
    if (authType !== "oauth" && authType !== "api_key") {
      errorResponse(response, 400, "invalid_request", "\"authType\" must be \"oauth\" or \"api_key\".");
      return;
    }
    if (typeof account !== "string") {
      errorResponse(response, 400, "invalid_request", '"account" must be a string.');
      return;
    }
    const view = await options.login.start(ghostName, providerId, authType as AuthType, account);
    // The status line stays 200; a failed login is a state the client polls,
    // not an HTTP error.
    jsonResponse(response, 201, view);
  };

  const handleLogout = async (
    ghostName: string,
    providerId: string,
    account: string,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.login) {
      errorResponse(response, 404, "not_found", "Login is not enabled on this daemon.");
      return;
    }
    await options.login.logout(ghostName, providerId, account);
    jsonResponse(response, 200, { ok: true, providerId, account });
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
    if (!options.catalog) {
      errorResponse(response, 404, "not_found", "The model switcher is not enabled on this daemon.");
      return;
    }
    jsonResponse(response, 200, await options.catalog.getCurrent(ghostName));
  };

  const handleListModels = async (
    ghostName: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.catalog) {
      errorResponse(response, 404, "not_found", "The model switcher is not enabled on this daemon.");
      return;
    }
    const scopeParam = url.searchParams.get("scope");
    if (scopeParam !== null && scopeParam !== "available" && scopeParam !== "catalog") {
      errorResponse(response, 400, "invalid_request", "\"scope\" must be \"available\" or \"catalog\".");
      return;
    }
    const query: ListModelsQuery = {};
    if (scopeParam) query.scope = scopeParam as ModelScope;
    const provider = url.searchParams.get("provider");
    if (provider) query.provider = provider;
    const q = url.searchParams.get("q");
    if (q !== null && q.length > MAX_MODEL_QUERY_LENGTH) {
      errorResponse(
        response,
        400,
        "invalid_request",
        `"q" must be at most ${MAX_MODEL_QUERY_LENGTH} characters.`,
      );
      return;
    }
    if (q) query.q = q;
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
    jsonResponse(response, 200, await options.catalog.listModels(ghostName, query));
  };

  const handleSetModel = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.catalog) {
      errorResponse(response, 404, "not_found", "The model switcher is not enabled on this daemon.");
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
    jsonResponse(response, 200, await options.catalog.setChatModel(ghostName, provider, id));
  };

  const handleModelRouting = async (
    ghostName: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.catalog) {
      errorResponse(response, 404, "not_found", "Model routing is not enabled on this daemon.");
      return;
    }
    if (method === "GET") {
      jsonResponse(response, 200, await options.catalog.getModelRouting(ghostName));
      return;
    }
    if (method !== "PUT") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { role, target, provider, id, fallbacks } = body as {
      role?: unknown;
      target?: unknown;
      provider?: unknown;
      id?: unknown;
      fallbacks?: unknown;
    };
    if (typeof role !== "string" || !GHOST_MODEL_ROLES.includes(role as GhostModelRole)) {
      errorResponse(response, 400, "invalid_request", "\"role\" is not a supported Ghost model role.");
      return;
    }
    if (target === "clear_fallbacks") {
      jsonResponse(
        response,
        200,
        await options.catalog.clearModelFallbacks(ghostName, role as GhostModelRole),
      );
      return;
    }
    if (target === "clear_primary") {
      jsonResponse(
        response,
        200,
        await options.catalog.clearModelPrimary(ghostName, role as GhostModelRole),
      );
      return;
    }
    if (target === "replace_fallbacks") {
      if (!Array.isArray(fallbacks)) {
        errorResponse(response, 400, "invalid_request", '"fallbacks" must be an array.');
        return;
      }
      const selections: Array<{ provider: string; id: string }> = [];
      for (const fallback of fallbacks) {
        if (fallback === null || typeof fallback !== "object" || Array.isArray(fallback)) {
          errorResponse(
            response,
            400,
            "invalid_request",
            'Every "fallbacks" entry must be an object with non-empty "provider" and "id" strings.',
          );
          return;
        }
        const selection = fallback as { provider?: unknown; id?: unknown };
        if (typeof selection.provider !== "string" || selection.provider === ""
          || typeof selection.id !== "string" || selection.id === "") {
          errorResponse(
            response,
            400,
            "invalid_request",
            'Every "fallbacks" entry must be an object with non-empty "provider" and "id" strings.',
          );
          return;
        }
        selections.push({ provider: selection.provider, id: selection.id });
      }
      jsonResponse(
        response,
        200,
        await options.catalog.replaceModelFallbacks(
          ghostName,
          role as GhostModelRole,
          selections,
        ),
      );
      return;
    }
    if (target !== "primary" && target !== "fallback") {
      errorResponse(
        response,
        400,
        "invalid_request",
        '"target" must be primary, fallback, clear_primary, replace_fallbacks, or clear_fallbacks.',
      );
      return;
    }
    if (typeof provider !== "string" || provider === "" || typeof id !== "string" || id === "") {
      errorResponse(response, 400, "invalid_request", "\"provider\" and \"id\" must be non-empty strings.");
      return;
    }
    jsonResponse(
      response,
      200,
      await options.catalog.setModelRoute(
        ghostName,
        role as GhostModelRole,
        target,
        provider,
        id,
      ),
    );
  };

  const streamSessionEvents = async (
    request: IncomingMessage,
    response: ServerResponse,
    run: (emit: (event: PiMessagesEvent) => void, signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    const requestedTurnId = request.headers["x-ghost-turn-id"];
    const turnId = typeof requestedTurnId === "string" && TURN_ID_PATTERN.test(requestedTurnId)
      ? requestedTurnId
      : crypto.randomUUID();

    const connection = abortOnClose(request, response);
    response.writeHead(200, { ...SSE_HEADERS, "x-ghost-turn-id": turnId });
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
    const { askId, ...answer } = body as Record<string, unknown>;
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

  const handleProject = async (
    ghostName: string,
    conversation: ConversationIdentity,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, await options.host.getProject(
        ghostName,
        conversation.conversationId,
        conversation.runtime,
      ));
      return;
    }
    if (method !== "PUT") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { root, cwd, trustToken, expectedGeneration } = body as Record<string, unknown>;
    if (root !== null && (typeof root !== "string" || root === "" || !isAbsolute(root))) {
      errorResponse(response, 400, "invalid_request", '"root" must be an absolute path string or null.');
      return;
    }
    if (cwd !== undefined && (typeof cwd !== "string" || cwd === "" || !isAbsolute(cwd))) {
      errorResponse(response, 400, "invalid_request", '"cwd" must be an absolute path string when present.');
      return;
    }
    if (trustToken !== undefined && (typeof trustToken !== "string" || trustToken === "")) {
      errorResponse(response, 400, "invalid_request", '"trustToken" must be a non-empty string when present.');
      return;
    }
    if (!Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) {
      errorResponse(response, 400, "invalid_request", '"expectedGeneration" must be a non-negative integer.');
      return;
    }
    jsonResponse(response, 200, await options.host.bindProject(
      ghostName,
      conversation.conversationId,
      conversation.runtime,
      {
        root: root as string | null,
        ...(cwd === undefined ? {} : { cwd: cwd as string }),
        ...(trustToken === undefined ? {} : { trustToken: trustToken as string }),
        expectedGeneration: expectedGeneration as number,
      },
    ));
  };

  const handleProjectAction = async (
    ghostName: string,
    conversation: ConversationIdentity,
    action: "preview" | "reload",
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    if (action === "preview") {
      const path = (body as { path?: unknown }).path;
      if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
        errorResponse(response, 400, "invalid_request", '"path" must be a non-empty absolute path string.');
        return;
      }
      jsonResponse(response, 200, await options.host.previewProject(
        ghostName,
        conversation.conversationId,
        conversation.runtime,
        path,
      ));
      return;
    }
    const expectedGeneration = (body as { expectedGeneration?: unknown }).expectedGeneration;
    if (!Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) {
      errorResponse(response, 400, "invalid_request", '"expectedGeneration" must be a non-negative integer.');
      return;
    }
    jsonResponse(response, 200, await options.host.reloadProject(
      ghostName,
      conversation.conversationId,
      conversation.runtime,
      expectedGeneration as number,
    ));
  };

  const handleProjectDraft = async (
    ghostName: string,
    conversation: ConversationIdentity,
    method: string,
    response: ServerResponse,
  ): Promise<void> => {
    if (method !== "DELETE") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    jsonResponse(response, 200, await options.host.abandonProjectDraft(
      ghostName,
      conversation.conversationId,
      conversation.runtime,
    ));
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

  const handleNativeHarnesses = async (
    method: string,
    response: ServerResponse,
  ): Promise<void> => {
    if (!options.nativeHarnesses) {
      errorResponse(response, 404, "not_found", "Native harnesses are not available.");
      return;
    }
    if (method !== "GET") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const statuses = await options.nativeHarnesses.list();
    jsonResponse(response, 200, {
      harnesses: statuses.map(({ id, availability, authentication }) => ({
        id,
        availability,
        authentication,
      })),
    });
  };

  const handleTasks = async (
    ghostName: string,
    parent: ConversationIdentity,
    method: string,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      const keys = [...url.searchParams.keys()];
      const rawLimit = url.searchParams.getAll("limit");
      if (keys.some((key) => key !== "limit")
        || rawLimit.length > 1
        || (rawLimit.length === 1 && !/^(?:[1-9]|1[0-9]|20)$/u.test(rawLimit[0] ?? ""))) {
        errorResponse(response, 400, "invalid_request", `"limit" must be an integer from 1 to ${MAX_LISTED_TASKS}.`);
        return;
      }
      const limit = rawLimit.length === 0 ? DEFAULT_LISTED_TASKS : Number(rawLimit[0]);
      const owned = await options.host.listTasks(ghostName, parent);
      const visible = owned.slice(0, limit);
      jsonResponse(response, 200, {
        tasks: visible.map((record) => taskProjection(record, false)),
        shown: visible.length,
        total: owned.length,
      });
      return;
    }
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    if (!exactObjectKeys(body, ["harness", "assignment", "cwd", "agent"])) {
      errorResponse(response, 400, "invalid_request", "Request body must be an exact task object.");
      return;
    }
    const { harness, assignment, cwd, agent } = body as Record<string, unknown>;
    if (harness !== "pi" && harness !== "codex" && harness !== "claude-code") {
      errorResponse(response, 400, "invalid_request", '"harness" must be "pi", "codex", or "claude-code".');
      return;
    }
    if (typeof assignment !== "string" || assignment.trim() === ""
      || assignment.length > MAX_TASK_TEXT) {
      errorResponse(response, 400, "invalid_request", '"assignment" is not a bounded non-empty string.');
      return;
    }
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.length < 1
      || Buffer.byteLength(cwd, "utf8") > MAX_TASK_CWD_BYTES)) {
      errorResponse(response, 400, "invalid_request", '"cwd" is not a bounded non-empty string.');
      return;
    }
    if (agent !== undefined && (harness !== "claude-code" || !isValidTaskAgent(agent))) {
      errorResponse(response, 400, "invalid_request", '"agent" is accepted only for Claude Code.');
      return;
    }
    const connection = abortOnClose(request, response);
    try {
      const record = await options.host.createTask(ghostName, parent, {
        harness,
        assignment,
        ...(cwd === undefined ? {} : { cwd: cwd as string }),
        ...(agent === undefined ? {} : { agent: agent as string }),
      }, connection.signal);
      if (!connection.signal.aborted && !response.writableEnded) {
        jsonResponse(response, 201, taskProjection(record, true));
      }
    } finally {
      connection.release();
    }
  };

  const handleTask = async (
    ghostName: string,
    parent: ConversationIdentity,
    taskId: string,
    method: string,
    response: ServerResponse,
  ): Promise<void> => {
    if (method !== "GET") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    jsonResponse(response, 200, taskProjection(
      await options.host.task(ghostName, parent, taskId),
      true,
    ));
  };

  const handleTaskAction = async (
    ghostName: string,
    parent: ConversationIdentity,
    taskId: string,
    action: "send" | "cancel",
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    if (action === "send") {
      if (!exactObjectKeys(body as Record<string, unknown>, ["message"])) {
        errorResponse(response, 400, "invalid_request", "Send accepts exactly one message.");
        return;
      }
      const message = (body as { message?: unknown }).message;
      if (typeof message !== "string" || message.trim() === ""
        || message.length > MAX_TASK_TEXT) {
        errorResponse(response, 400, "invalid_request", '"message" is not a bounded non-empty string.');
        return;
      }
      jsonResponse(response, 200, taskProjection(
        await options.host.sendTask(ghostName, parent, taskId, message),
        true,
      ));
      return;
    }
    if (!exactObjectKeys(body as Record<string, unknown>, [])) {
      errorResponse(response, 400, "invalid_request", "Cancel accepts an empty object.");
      return;
    }
    jsonResponse(response, 200, taskProjection(
      await options.host.cancelTask(ghostName, parent, taskId),
      true,
    ));
  };

  const server = createServer((request, response) => {
    void (async () => {
      applyCors(request, response);
      const method = request.method ?? "GET";
      if (method === "OPTIONS") {
        // A preflight cannot carry credentials — that is what it is asking
        // permission to do. Answering it reveals nothing.
        response.writeHead(204).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
        if (segments.length === 2 && segments[1] === "harnesses") {
          return await handleNativeHarnesses(method, response);
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
        if (segments.length === 4 && segments[3] === "memory") {
          if (method === "GET") return await handleListMemory(ghostName, response);
          if (method === "PUT") return await handleWriteMemory(ghostName, request, response);
          if (method === "DELETE") return await handleTrashMemory(ghostName, request, response);
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
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "tasks") {
          return await handleTasks(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
            url,
            request,
            response,
          );
        }
        if (segments.length === 7 && segments[3] === "sessions" && segments[5] === "tasks") {
          return await handleTask(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            decodePathSegment(segments[6] ?? ""),
            method,
            response,
          );
        }
        if (segments.length === 8 && segments[3] === "sessions" && segments[5] === "tasks"
          && (segments[7] === "send" || segments[7] === "cancel")) {
          return await handleTaskAction(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            decodePathSegment(segments[6] ?? ""),
            segments[7],
            method,
            request,
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
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "jobs") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          const conversation = decodeConversationIdentity(segments[4] ?? "");
          jsonResponse(response, 200, {
            jobs: options.host.listJobs(ghostName, conversation.conversationId, conversation.runtime),
          });
          return;
        }
        if (segments.length === 8 && segments[3] === "sessions" && segments[5] === "jobs" && segments[7] === "cancel") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          const conversation = decodeConversationIdentity(segments[4] ?? "");
          const result = options.host.cancelJob(
            ghostName,
            conversation.conversationId,
            decodePathSegment(segments[6] ?? ""),
            conversation.runtime,
          );
          if (result.outcome === "not_found") {
            errorResponse(response, 404, "not_found", "This conversation has no such background job.");
            return;
          }
          jsonResponse(response, 200, result);
          return;
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
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "recap") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleRecap(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "live") {
          return await handleLiveVoice(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "collab") {
          return await handleCollaboration(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
            request,
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
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "project") {
          return await handleProject(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 7 && segments[3] === "sessions" && segments[5] === "project"
          && (segments[6] === "preview" || segments[6] === "reload")) {
          return await handleProjectAction(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            segments[6],
            method,
            request,
            response,
          );
        }
        if (segments.length === 7 && segments[3] === "sessions" && segments[5] === "project"
          && segments[6] === "draft") {
          return await handleProjectDraft(
            ghostName,
            decodeConversationIdentity(segments[4] ?? ""),
            method,
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
        if (segments.length === 4 && segments[3] === "models") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleListModels(ghostName, url, response);
        }
        if (segments.length === 4 && segments[3] === "model-routing") {
          return await handleModelRouting(ghostName, method, request, response);
        }
        if (segments.length === 4 && segments[3] === "providers") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleListProviders(ghostName, response);
        }
        if (segments.length === 7 && segments[3] === "providers" && segments[5] === "accounts") {
          if (method !== "DELETE") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleLogout(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            decodePathSegment(segments[6] ?? ""),
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
    })();
  });

  if (relay) {
    attachRelay(server, relay);
  } else {
    // Without a relay there is no upgrade handler, and Node leaves an unhandled
    // upgrade socket open forever. Hang up rather than leaking it.
    server.on("upgrade", (_request, socket) => socket.destroy());
  }

  // Exposed so close() can end streams that would otherwise hold shutdown open.
  Object.assign(server, { [LIVE_STREAMS]: liveStreams, [RELAY_HUB]: relay });
  return server;
}

export function relayHubOf(server: Server): RelayHub | undefined {
  return (server as unknown as Record<symbol, RelayHub | null | undefined>)[RELAY_HUB] ?? undefined;
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
        const streams = (server as unknown as Record<symbol, Set<ServerResponse>>)[LIVE_STREAMS];
        for (const stream of streams ?? []) {
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
