import { homedir } from "node:os";
import { readBoard } from "./board.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiToken as apiTokenStore, tokenMatches } from "./token-store.js";
import { assertLoopback } from "./config.js";
import { REMOTE_MANIFEST, REMOTE_VIEWER_CSP, REMOTE_VIEWER_HTML } from "./remote-viewer.js";
import type { RemoteServe } from "./remote-serve.js";
import type { RemoteAccess, TailscaleIdentity } from "./tailscale-identity.js";
import { requireConversationId } from "./conversation-log.js";
import type {
  McpCatalog,
} from "./mcp-catalog.js";
import { MAX_CHARACTER_BODY_LENGTH, openGhostHome,
  resolveDocumentsDirectory,
} from "@ghost/extensions";
import {
  GhostError,
  fromExtensionError,
  type GhostRegistry,
} from "./ghosts.js";
import type { GhostHookRunner } from "./hooks.js";
import type { GhostHookCommandConfig, GhostHookStatus } from "./hook-policy.js";
import { silentLogger, type Logger } from "./log.js";
import {
  encodeSseEvent,
  parseTurnRequest,
  SSE_HEADERS,
  SSE_KEEPALIVE_COMMENT,
  SSE_KEEPALIVE_INTERVAL_MS,
  type TurnEvent,
} from "./turn-events.js";
import { attachRelay, type RelayHub } from "./relay.js";
import type { RunningSource } from "./running-source.js";
import type { UpdateAvailable } from "./update-check.js";
import type { SessionHost } from "./session-host.js";
import { errorMessage, isRecord } from "@ghost/extensions";

export interface ServerOptions {
  registry: GhostRegistry;
  host: SessionHost;
  /** What runs this daemon. Omitted, `GET /api/status` reports it as unknown. */
  runningSource?: RunningSource;
  /** The last update check's answer, for `GET /api/status`; omitted or null means none known. */
  update?: () => UpdateAvailable | null;
  mcp?: McpCatalog;
  hooks?: Pick<GhostHookRunner, "status" | "config" | "replaceConfig">;
  logger?: Logger;
  maxBodyBytes?: number;
  /** The browser relay; without one the endpoint is left out. */
  relay?: RelayHub;
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

/** The fields a client sees, whatever else the runner's status carries. */
function publicHookStatus(status: GhostHookStatus): GhostHookStatus {
  return {
    active: status.active,
    total: status.total,
    events: status.events.map(({ event, count }) => ({ event, count })),
    hooks: status.hooks.map(({ event, name, description }) => ({ event, name, description })),
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

/** `body[key]` as a string, or the 400 every route answers for one that is not. */
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new GhostError("invalid_request", `"${key}" must be a string.`, 400);
  return value;
}

function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new GhostError("invalid_request", `"${key}" must be a boolean.`, 400);
  return value;
}

/** A query parameter as a number, or undefined when absent. */
function numberParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new GhostError("invalid_request", `"${key}" must be a number.`, 400);
  return value;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) throw new GhostError("invalid_request", "URL path segments must use valid percent-encoding.", 400);
    throw error;
  }
}

function decodeConversationId(segment: string): string {
  return requireConversationId(decodePathSegment(segment));
}

interface Route<C> {
  readonly methods: readonly string[];
  readonly path: readonly string[];
  readonly handle: (context: C) => unknown;
}

/** `"GET PUT"`, `"api/ghosts/:ghost/character"`: a `:name` segment is a parameter. */
function route<C>(methods: string, pattern: string, handle: (context: C) => unknown): Route<C> {
  return { methods: methods.split(" "), path: pattern === "" ? [] : pattern.split("/"), handle };
}

/** The route for this path and method; a path with no route for the method is a 405. */
function matchRoute<C>(
  routes: readonly Route<C>[],
  segments: readonly string[],
  method: string,
): { route: Route<C>; params: Record<string, string> } | 404 | 405 {
  let pathMatched = false;
  for (const candidate of routes) {
    if (candidate.path.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matches = candidate.path.every((part, index) => {
      const segment = segments[index] as string;
      if (part.startsWith(":")) params[part.slice(1)] = segment;
      return part.startsWith(":") || part === segment;
    });
    if (!matches) continue;
    pathMatched = true;
    if (candidate.methods.includes(method)) return { route: candidate, params };
  }
  return pathMatched ? 405 : 404;
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
      throw new GhostError("payload_too_large", "Request body is too large.", 413);
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    throw new GhostError("invalid_request", "Request body is required.", 400);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GhostError("invalid_request", "Request body must be JSON.", 400);
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
  if (!isRecord(body)) {
    throw new GhostError("invalid_request", "Request body must be a JSON object.", 400);
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
  const minted = apiTokenStore.readOrCreate();
  // The path, never the token: `ghostd api-token` is the only way to see it.
  logger.info(minted.created ? "minted the API token" : "API token loaded", {
    path: minted.path,
  });
  return minted.token;
}

/** The server, plus what `close()` needs: streams to end and the relay to hang up. */
function createDaemonServer(options: ServerOptions): { server: Server; liveStreams: Set<ServerResponse>; relay: RelayHub | undefined } {
  const logger = options.logger ?? silentLogger;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const liveStreams = new Set<ServerResponse>();
  const relay = options.relay;
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
    const tokenOk = presented !== "" && tokenMatches(apiToken, presented);
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

  interface RequestContext {
    method: string;
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
    admission: { identity: TailscaleIdentity | undefined };
    params: Record<string, string>;
  }
  const ghostOf = (params: Record<string, string>) => decodePathSegment(params.ghost ?? "");
  const conversationOf = (params: Record<string, string>) => decodeConversationId(params.id ?? "");

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
      throw new GhostError("not_found", "Hook configuration is not available.", 404);
    }
    if (method === "GET") {
      jsonResponse(response, 200, { path: config.path, document: config.document });
      return;
    }
    const document = await readJsonBody(request, maxBodyBytes);
    let replaced: GhostHookCommandConfig;
    try {
      replaced = await hooks.replaceConfig(document);
    } catch (error) {
      throw new GhostError("invalid_request", errorMessage(error), 400);
    }
    jsonResponse(response, 200, { path: replaced.path, document: replaced.document });
  };

  const handleCreateGhost = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const name = stringField(await readJsonObjectBody(request, maxBodyBytes), "name");
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
      throw new GhostError(
        "confirmation_required",
        `Deleting a ghost needs its name repeated: ?confirm=${encodeURIComponent(ghostName)}.`,
        400,
      );
    }
    const { trash } = await options.host.deleteGhost(ghostName);
    logger.info("ghost deleted", { ghost: ghostName, trash });
    jsonResponse(response, 200, { ok: true, trash });
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
          response.write(encodeSseEvent(event));
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
    const character = await options.host.withGhost(ghostName, async () => {
      const ghost = options.registry.get(ghostName);
      return await openGhostHome(ghost.dir).readCharacter({ enforceLimit: false });
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
    const text = stringField(await readJsonObjectBody(request, maxBodyBytes), "body");
    await options.host.withGhost(ghostName, async () => {
      const ghost = options.registry.get(ghostName);
      await openGhostHome(ghost.dir).writeCharacter({ body: text });
    });
    jsonResponse(response, 200, { ok: true, limit: MAX_CHARACTER_BODY_LENGTH });
  };

  const handleDeleteSession = async (
    ghostName: string,
    conversationId: string,
    response: ServerResponse,
  ): Promise<void> => {
    const { trash } = await options.host.deleteSession(ghostName, conversationId);
    jsonResponse(response, 200, { ok: true, trash });
  };

  /**
   * Pin or unpin one conversation. Idempotent, so the shell may send the state
   * it wants rather than a toggle it has to compute from a stale listing.
   */
  const handleSetSessionPin = async (
    ghostName: string,
    conversationId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const pinned = booleanField(await readJsonObjectBody(request, maxBodyBytes), "pinned");
    await options.host.setPinned(ghostName, conversationId, pinned);
    jsonResponse(response, 200, { ok: true, pinned });
  };

  /** `{ harness }`: an agent id, or (for the ghost default) null for automatic. */
  const readHarnessBody = async (request: IncomingMessage, nullable: boolean): Promise<string | null> => {
    const { harness } = await readJsonObjectBody(request, maxBodyBytes) as { harness?: unknown };
    if (typeof harness === "string" && harness !== "") return harness;
    if (nullable && harness === null) return null;
    throw new GhostError("invalid_request", nullable ? '"harness" must be an agent id or null.' : '"harness" must be an agent id.', 400);
  };

  const handleGhostHarness = async (
    ghostName: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, await options.host.listHarnesses(ghostName));
      return;
    }
    jsonResponse(response, 200, await options.host.setGhostHarness(ghostName, await readHarnessBody(request, true)));
  };

  const handleMarkSessionRead = async (
    ghostName: string,
    conversationId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    await readJsonObjectBody(request, maxBodyBytes);
    const readAt = await options.host.markRead(ghostName, conversationId);
    jsonResponse(response, 200, { ok: true, readAt });
  };

  const handleRenameSession = async (
    ghostName: string,
    conversationId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const title = stringField(await readJsonObjectBody(request, maxBodyBytes), "title");
    const stored = await options.host.renameConversation(ghostName, conversationId, title);
    jsonResponse(response, 200, { ok: true, title: stored });
  };

  const requireMcp = (): McpCatalog => {
    if (!options.mcp) throw new GhostError("not_found", "MCP management is not enabled on this daemon.", 404);
    return options.mcp;
  };

  const handleMcpCollection = async (
    ghostName: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const mcp = requireMcp();
    if (method === "GET") {
      jsonResponse(response, 200, await options.host.withGhost(ghostName, () => mcp.listLeased(ghostName)));
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const name = stringField(body, "name");
    const { config } = body;
    jsonResponse(response, 201, await options.host.withGhost(ghostName, () => mcp.addLeased(ghostName, name, config)));
  };

  const handleMcpServer = async (
    ghostName: string,
    serverName: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const mcp = requireMcp();
    if (method === "DELETE") {
      jsonResponse(response, 200, await options.host.withGhost(ghostName, () => mcp.removeLeased(ghostName, serverName)));
      return;
    }
    const { config } = await readJsonObjectBody(request, maxBodyBytes) as { config?: unknown };
    jsonResponse(response, 200, await options.host.withGhost(ghostName, () => mcp.updateLeased(ghostName, serverName, config)));
  };

  const handleMcpEnabled = async (
    ghostName: string,
    serverName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const mcp = requireMcp();
    const enabled = booleanField(await readJsonObjectBody(request, maxBodyBytes), "enabled");
    jsonResponse(response, 200, await options.host.withGhost(ghostName, () => mcp.setEnabledLeased(ghostName, serverName, enabled)));
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
    const name = stringField(await readJsonObjectBody(request, maxBodyBytes), "name");
    const renamed = await options.host.renameGhost(ghostName, name);
    logger.info("ghost renamed", { ghost: ghostName, name: renamed.name });
    jsonResponse(response, 200, { ok: true, name: renamed.name });
  };

  const handleTranscript = async (
    ghostName: string,
    conversationId: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> => {
    const query: { limit?: number; offset?: number } = {};
    const limit = numberParam(url, "limit");
    if (limit !== undefined) query.limit = limit;
    const offset = numberParam(url, "offset");
    if (offset !== undefined) query.offset = offset;
    jsonResponse(response, 200, await options.host.readTranscript(
      ghostName,
      conversationId,
      query,
    ));
  };

  const streamSessionEvents = async (
    request: IncomingMessage,
    response: ServerResponse,
    run: (emit: (event: TurnEvent) => void, signal: AbortSignal) => Promise<void>,
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
    const emit = (event: TurnEvent): void => {
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
        errorMessage: errorMessage(error),
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
    const parsed = parseTurnRequest(await readJsonObjectBody(request, maxBodyBytes));
    const admission = await options.host.admitTurn(ghost.name, {
      sessionId: parsed.sessionId,
      prompt: parsed.prompt,
    });
    try {
      await streamSessionEvents(request, response, (emit, signal) =>
        admission.run({ emit, signal }));
    } finally {
      // Covers a response failure before the stream callback consumes the
      // admission; ordinary run completion releases it first.
      admission.release();
    }
  };

  /** `ghost mcp serve`'s backend: list this conversation's tools, or run one. */
  const handleSessionTools = async (
    { params, request, response, admission }: RequestContext,
    toolName: string | undefined,
  ): Promise<void> => {
    // Running a tool acts on this desktop directly; a tailnet caller, even
    // the owner, acts only through the ghost.
    if (admission.identity) {
      throw new GhostError("local_only", "Ghost tools run only for the machine-local token.", 403);
    }
    const ghostName = ghostOf(params);
    const conversationId = conversationOf(params);
    if (toolName === undefined) {
      jsonResponse(response, 200, { tools: await options.host.sessionTools(ghostName) });
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const connection = abortOnClose(request, response);
    try {
      jsonResponse(response, 200, await options.host.callSessionTool(
        ghostName,
        conversationId,
        toolName,
        body.arguments ?? {},
        connection.signal,
        typeof body.caller === "string" ? body.caller.slice(0, 120) : undefined,
      ));
    } finally {
      connection.release();
    }
  };

  const handleQueue = async (
    ghostName: string,
    conversationId: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, options.host.queuedMessages(
        ghostName,
        conversationId,
      ));
      return;
    }
    const body = await readJsonObjectBody(request, maxBodyBytes);
    const { text } = body as { text?: unknown };
    if (typeof text !== "string" || text.trim() === "") {
      throw new GhostError("invalid_request", '"text" must be a non-empty string.', 400);
    }
    jsonResponse(
      response,
      200,
      await options.host.queueMessage(
        ghostName,
        conversationId,
        text.trim(),
      ),
    );
  };

  const routes: Route<RequestContext>[] = [
    route("GET", "", ({ response }) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": REMOTE_VIEWER_CSP,
        "cache-control": "no-store",
      });
      response.end(REMOTE_VIEWER_HTML);
    }),
    route("GET", "manifest.webmanifest", ({ response }) => {
      const manifest = JSON.stringify(REMOTE_MANIFEST);
      response.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        "content-length": Buffer.byteLength(manifest),
        "cache-control": "no-store",
      });
      response.end(manifest);
    }),
    route("GET", "api/remote/whoami", ({ response, admission }) => {
      const identity = admission.identity;
      jsonResponse(response, 200, identity ? { login: identity.login, role: identity.role, ...(identity.name ? { name: identity.name } : {}) } : { login: null, role: "owner" });
    }),
    route("GET", "api/remote/qr.svg", async ({ response }) => {
      const url = remoteServe ? (await remoteServe.status()).url : null;
      if (!remoteServe || !url) {
        throw new GhostError("not_found", "Remote access is off.", 404);
      }
      const svg = await remoteServe.qrSvg(url);
      response.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "content-length": Buffer.byteLength(svg),
        "cache-control": "no-store",
      });
      response.end(svg);
    }),
    route("GET POST", "api/remote", async ({ method, request, response }) => {
      if (!remoteServe) {
        throw new GhostError("not_found", "Remote access is not available.", 404);
      }
      if (method === "GET") {
        jsonResponse(response, 200, await remoteServe.status());
        return;
      }
      const enabled = booleanField(await readJsonObjectBody(request, maxBodyBytes), "enabled");
      jsonResponse(response, 200, await remoteServe.setEnabled(enabled));
    }),
    // The one `/api` path exempt from the bearer token and the origin check, so
    // anything it returns is readable by anything that can reach the port.
    route("GET", "api/relay/status", ({ response }) => {
      jsonResponse(response, 200, relay
        ? { enabled: true, ...relay.status() }
        : { enabled: false, connected: false, reason: "The relay is off (GHOSTD_RELAY)." });
    }),
    route("POST", "api/relay/pair", async ({ request, response }) => {
      if (!relay) {
        throw new GhostError("not_found", "The relay is off (GHOSTD_RELAY).", 404);
      }
      const body = await readJsonObjectBody(request, maxBodyBytes) as { code?: unknown; allow?: unknown };
      if (typeof body.code !== "string" || typeof body.allow !== "boolean") {
        throw new GhostError("invalid_request", '"code" must be the pairing code shown in the browser and "allow" a boolean.', 400);
      }
      const outcome = relay.resolvePairing(body.code.trim(), body.allow);
      if (outcome === "unknown") {
        throw new GhostError("pairing_not_found", "No browser is waiting to pair with that code.", 404);
      }
      jsonResponse(response, 200, { ok: true, outcome, ...relay.status() });
    }),
    route("GET PUT", "api/hooks/config", ({ method, request, response }) => handleHookConfig(method, request, response)),
    route("GET", "api/hooks", ({ response }) => {
      jsonResponse(response, 200, publicHookStatus(options.hooks?.status() ?? { active: false, total: 0, events: [], hooks: [] }));
    }),
    // The owner's board.md, parsed. Guests may read it: it is the one owner
    // document meant to be looked at, and it is read-only here.
    route("GET", "api/board", async ({ response }) => {
      jsonResponse(response, 200, await readBoard(resolveDocumentsDirectory(process.env, homedir())));
    }),
    route("GET", "api/status", ({ response, admission }) => {
      // `root` is a filesystem path, so the whole row is the owner's alone.
      if (admission.identity?.role === "guest") {
        throw new GhostError("owner_only", "Daemon source paths are visible only to the owner.", 403);
      }
      jsonResponse(response, 200, {
        version: options.runningSource?.version ?? null,
        source: { commit: options.runningSource?.commit ?? null, root: options.runningSource?.root ?? null },
        update: options.update?.() ?? null,
      });
    }),
    route("GET", "api/ghosts", ({ response }) => handleListGhosts(response)),
    route("POST", "api/ghosts", ({ request, response }) => handleCreateGhost(request, response)),
    route("DELETE", "api/ghosts/:ghost", ({ params, url, response }) => handleDeleteGhost(ghostOf(params), url, response)),
    route("GET", "api/ghosts/:ghost/character", ({ params, response }) => handleReadCharacter(ghostOf(params), response)),
    route("PUT", "api/ghosts/:ghost/character", ({ params, request, response }) => handleWriteCharacter(ghostOf(params), request, response)),
    route("GET PUT", "api/ghosts/:ghost/harness", ({ params, method, request, response }) => handleGhostHarness(ghostOf(params), method, request, response)),
    route("POST", "api/ghosts/:ghost/messages", ({ params, request, response }) => handleMessages(ghostOf(params), request, response)),
    route("GET", "api/ghosts/:ghost/events", ({ params, request, response }) => handleConversationEvents(ghostOf(params), request, response)),
    route("PUT", "api/ghosts/:ghost/name", ({ params, request, response }) => handleRenameGhost(ghostOf(params), request, response)),
    route("GET", "api/ghosts/:ghost/sessions", ({ params, response }) => handleListSessions(ghostOf(params), response)),
    route("DELETE", "api/ghosts/:ghost/sessions/:id", ({ params, response }) => handleDeleteSession(ghostOf(params), conversationOf(params), response)),
    route("PUT", "api/ghosts/:ghost/sessions/:id/harness", async ({ params, request, response }) => {
      jsonResponse(response, 200, await options.host.chooseHarness(ghostOf(params), conversationOf(params), await readHarnessBody(request, false) as string));
    }),
    route("PUT", "api/ghosts/:ghost/sessions/:id/pin", ({ params, request, response }) => handleSetSessionPin(ghostOf(params), conversationOf(params), request, response)),
    route("PUT", "api/ghosts/:ghost/sessions/:id/read", ({ params, request, response }) => handleMarkSessionRead(ghostOf(params), conversationOf(params), request, response)),
    route("PUT", "api/ghosts/:ghost/sessions/:id/title", ({ params, request, response }) => handleRenameSession(ghostOf(params), conversationOf(params), request, response)),
    route("GET", "api/ghosts/:ghost/sessions/:id/transcript", ({ params, url, response }) => handleTranscript(ghostOf(params), conversationOf(params), url, response)),
    route("GET", "api/ghosts/:ghost/sessions/:id/tools", (context) => handleSessionTools(context, undefined)),
    route("POST", "api/ghosts/:ghost/sessions/:id/tools/:tool", (context) => handleSessionTools(context, context.params.tool)),
    route("GET POST", "api/ghosts/:ghost/sessions/:id/queue", ({ params, method, request, response }) => handleQueue(ghostOf(params), conversationOf(params), method, request, response)),
    route("GET POST", "api/ghosts/:ghost/mcp", ({ params, method, request, response }) => handleMcpCollection(ghostOf(params), method, request, response)),
    route("PUT DELETE", "api/ghosts/:ghost/mcp/:server", ({ params, method, request, response }) => handleMcpServer(ghostOf(params), decodePathSegment(params.server ?? ""), method, request, response)),
    route("PUT", "api/ghosts/:ghost/mcp/:server/enabled", ({ params, request, response }) => handleMcpEnabled(ghostOf(params), decodePathSegment(params.server ?? ""), request, response)),
  ];

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
        const matched = matchRoute(routes, segments, method);
        if (matched === 404) {
          errorResponse(response, 404, "not_found", "Not found.");
          return;
        }
        if (matched === 405) {
          errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
          return;
        }
        await matched.route.handle({ method, request, response, url, admission, params: matched.params });
      } catch (error) {
        if (response.headersSent) {
          logger.error("request failed after headers were sent", {
            path: url.pathname,
            error: errorMessage(error),
          });
          if (!response.writableEnded) response.end();
          return;
        }
        const failure = fromExtensionError(error);
        if (failure instanceof GhostError) {
          errorResponse(response, failure.status, failure.code, failure.message);
          // Answer and hang up rather than reading the rest of a body we
          // have already refused.
          if (failure.status === 413) response.once("finish", () => request.destroy());
          return;
        }
        logger.error("request failed", {
          path: url.pathname,
          error: errorMessage(error),
        });
        errorResponse(response, 500, "internal_error", "The daemon failed to handle the request.");
      }
    })().catch((error: unknown) => {
      const message = errorMessage(error);
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

  return { server, liveStreams, relay };
}

export async function startDaemonServer(
  options: ServerOptions & { port: number; address?: string },
): Promise<ListeningServer> {
  const address = options.address ?? "127.0.0.1";
  assertLoopback(address);
  const { server, liveStreams, relay } = createDaemonServer(options);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, address, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const bound = server.address() as AddressInfo;
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
        for (const stream of liveStreams) {
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
