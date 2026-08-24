/**
 * The daemon's HTTP API — the routes in CONTRACTS.md, on loopback, behind a
 * machine-local bearer token, plus the browser relay.
 *
 *   GET  /api/ghosts                  → [{ name, dir, createdAt }]
 *   POST /api/ghosts                  { name } → creates ~/Ghosts/<name>/
 *   DELETE /api/ghosts/:name?confirm=<name> → moves the home into the XDG trash
 *   POST /api/ghosts/:name/messages   pi-messages request → SSE of pi-messages events
 *   POST /api/ghosts/:name/greeting   → { greeting, onboarding } — the empty-chat opener
 *   GET  /api/ghosts/:name/sessions   → { sessions } — conversation listing for that ghost
 *   DELETE /api/ghosts/:name/sessions/:id → permanently delete one conversation
 *   PUT  /api/ghosts/:name/sessions/:id/pin → { pinned } — pin or unpin it
 *   GET  /api/ghosts/:name/sessions/:id/transcript → { id, title, messages } for resume
 *   GET  /api/ghosts/:name/sessions/:id/ask → { ask } — current OMP ask, if any
 *   POST /api/ghosts/:name/sessions/:id/ask → resolve that ask
 *   GET  /api/ghosts/:name/sessions/:id/queue → OMP steering/follow-up queues
 *   POST /api/ghosts/:name/sessions/:id/queue → enqueue a steer or follow-up
 *   POST /api/ghosts/:name/sessions/:id/branch → rewind/navigate the OMP tree
 *   POST /api/ghosts/:name/sessions/:id/reanswer → branch an ask result + SSE resume
 *   GET  /api/ghosts/:name/model-routing → Ghost roles + OMP fallback chains
 *   PUT  /api/ghosts/:name/model-routing → set a primary/fallback or clear a chain
 *   GET  /api/relay/status            → whether the creator's Chromium is paired
 *   WS   /relay                       → the MV3 extension's socket (token-gated)
 *
 * Node's built-in `http` plus a twenty-line router: the surface is small and one
 * route is a stream, which is precisely the shape a framework would add weight to
 * without adding clarity.
 *
 * Binding to loopback is not authentication (issue #485). Every browser on the
 * machine can reach `127.0.0.1`, and a page can send a `text/plain` POST there
 * with no preflight at all — CORS governs reading the *response*, not sending
 * the request, so a visited web page could otherwise drive a ghost's browser
 * and desktop tools. Three checks, applied before routing, close that:
 *
 *   1. A present `Origin` must be loopback. A browser always sends one on a
 *      cross-site request; a file-reading client sends none.
 *   2. `Authorization: Bearer <token>` must match the machine-local token in
 *      `$XDG_STATE_HOME/ghost/api-token` (api-token.ts). A page cannot read a
 *      file, so it cannot forge this.
 *   3. `POST`/`PUT` must be `application/json`, which no simple-request form
 *      post can be — belt to the Origin check's braces.
 *
 * `OPTIONS` answers 204 unauthenticated (a preflight carries no credentials by
 * definition) and `GET /api/relay/status` is exempt on purpose: it returns no
 * secret, and it is the one thing a client with no token yet may need to read.
 *
 * The relay is authenticated separately, and the reason is worth stating: the
 * peer is a browser, and a browser runs code written by strangers. `/relay`
 * therefore carries its own pairing token, refuses any `Origin` that is not a
 * browser extension, and accepts one connection at a time.
 * `/api/relay/status` never returns that token — `ghostd relay-token` does.
 *
 * Error bodies are `{ "error": { "message", "code" } }` — the shape the
 * pinned pi-messages client parses out of a non-2xx response
 * (`parsed.error.message` / `parsed.error.code`), and the same shape the
 * hosted relay returns, so a client needs no daemon-specific branch.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiTokenMatches, readOrCreateApiToken } from "./api-token.js";
import type { AuthType, LoginManager } from "./auth.js";
import { assertLoopback } from "./config.js";
import type { ListModelsQuery, ModelCatalog, ModelScope } from "./model-catalog.js";
import { GhostError, type GhostRegistry } from "./ghosts.js";
import { GHOST_MODEL_ROLES, type GhostModelRole } from "./models.js";
import { silentLogger, type Logger } from "./log.js";
import {
  encodeSseEvent,
  parsePiMessagesRequest,
  PiMessagesRequestError,
  SSE_HEADERS,
  SSE_KEEPALIVE_COMMENT,
  SSE_KEEPALIVE_INTERVAL_MS,
  type PiMessagesEvent,
} from "./pi-messages.js";
import { attachRelay, createRelayHub, type RelayHub } from "./relay.js";
import type { SessionHost } from "./session-host.js";

export interface ServerOptions {
  registry: GhostRegistry;
  host: SessionHost;
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
  logger?: Logger;
  /** Max request body. A turn is a few KB; this is a sanity bound. */
  maxBodyBytes?: number;
  /** Forward `thinking_*` blocks on the wire. Off by default. */
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
}

export interface ListeningServer {
  server: Server;
  port: number;
  address: string;
  /** The browser relay, when this server has one. */
  relay: RelayHub | undefined;
  /** Stop accepting, end live streams, and resolve once closed. */
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const TURN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Live SSE responses, stashed on the server so close() can end them. */
const LIVE_STREAMS = Symbol.for("ghostd.liveStreams");
/** The relay hub, stashed on the server so close() can hang up on the browser. */
const RELAY_HUB = Symbol.for("ghostd.relayHub");

/**
 * Same-origin is the intended deployment (the Omarchy webapp wraps
 * `http://127.0.0.1:<port>` directly), but a UI running on a dev server is a
 * different origin on the same loopback interface. Allow exactly that, and
 * nothing else — a page on a remote origin must not be able to read a
 * ghost's memory through the user's own browser.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;

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

function errorResponse(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  jsonResponse(response, status, { error: { message, code } });
}

class InvalidPathEncodingError extends Error {
  readonly code = "invalid_request";
  readonly status = 400;

  constructor() {
    super("URL path segments must use valid percent-encoding.");
    this.name = "InvalidPathEncodingError";
  }
}

/** Decode one dynamic route segment without letting `URIError` escape as a 500. */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) throw new InvalidPathEncodingError();
    throw error;
  }
}

/** The token out of `Authorization: Bearer <token>`, or "" when there is none. */
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
  const liveStreams = new Set<ServerResponse>();
  // `undefined` means "decide for me"; `null` means "no relay on this server".
  const relay = options.relay === undefined
    ? createRelayHub({ ...(options.logger ? { logger: options.logger } : {}) })
    : options.relay;
  const apiToken = resolveApiToken(options.apiToken, logger);

  /**
   * The gate every `/api` request passes before it is routed. Returns true when
   * it has already answered, in which case the caller must stop.
   */
  const refuseUnauthenticated = (
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    segments: readonly string[],
  ): boolean => {
    if (apiToken === null) return false;
    if (segments[0] !== "api") return false;
    // Deliberately open: it carries no secret, and a client with no token yet
    // may still need to ask whether the relay is up.
    if (segments[1] === "relay" && segments[2] === "status" && segments.length === 3) return false;

    const origin = request.headers.origin;
    if (typeof origin === "string" && !LOOPBACK_ORIGIN.test(origin)) {
      errorResponse(response, 403, "forbidden_origin", "That origin may not call this daemon.");
      return true;
    }
    const presented = bearerToken(request.headers.authorization);
    if (presented === "" || !apiTokenMatches(apiToken, presented)) {
      response.setHeader("www-authenticate", "Bearer");
      errorResponse(
        response,
        401,
        "unauthorized",
        "This API needs the machine-local bearer token. Run `ghostd api-token`.",
      );
      return true;
    }
    if ((method === "POST" || method === "PUT") && !isJsonContentType(request.headers["content-type"])) {
      errorResponse(
        response,
        415,
        "unsupported_media_type",
        "Mutating requests must be application/json.",
      );
      return true;
    }
    return false;
  };

  const handleListGhosts = (response: ServerResponse): void => {
    jsonResponse(response, 200, options.registry.list());
  };

  const handleCreateGhost = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
    const name = (body as { name?: unknown }).name;
    if (typeof name !== "string") {
      errorResponse(response, 400, "invalid_request", "\"name\" must be a string.");
      return;
    }
    const ghost = options.registry.create(name);
    logger.info("ghost created", { ghost: ghost.name });
    jsonResponse(response, 201, ghost);
  };

  /**
   * Trash one ghost. `?confirm=<name>` must repeat the name exactly: a DELETE
   * is one path segment away from every other ghost route, and this is the
   * API-level guard against an accidental or scripted one taking a persona,
   * its memory, and its docs with it. The deletion itself is a move into the
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
   * The opening line for an empty chat. `greeting` is null whenever one could
   * not be written — no usable model, a provider hiccup, output that did not
   * survive cleaning — and that is a 200, not a 5xx: the shell renders its own
   * static line and the window still opens. Only an unknown ghost fails.
   */
  const handleGreeting = async (
    ghostName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      await readJsonBody(request, maxBodyBytes);
    } catch (error) {
      // The body is `{}` by contract and carries nothing; an absent or
      // malformed one means the same thing. An oversized one is still refused.
      if (error instanceof PiMessagesRequestError && error.code === "payload_too_large") throw error;
    }
    jsonResponse(response, 200, await options.host.greeting(ghostName));
  };

  const handleDeleteSession = async (
    ghostName: string,
    conversationId: string,
    response: ServerResponse,
  ): Promise<void> => {
    await options.host.deleteSession(ghostName, conversationId);
    jsonResponse(response, 200, { ok: true });
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
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
    const { pinned } = body as { pinned?: unknown };
    if (typeof pinned !== "boolean") {
      errorResponse(response, 400, "invalid_request", "\"pinned\" must be a boolean.");
      return;
    }
    await options.host.setPinned(ghostName, conversationId, pinned);
    jsonResponse(response, 200, { ok: true, pinned });
  };

  const handleTranscript = async (
    ghostName: string,
    conversationId: string,
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
    jsonResponse(response, 200, await options.host.readTranscript(ghostName, conversationId, query));
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
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
    const { providerId, authType } = body as { providerId?: unknown; authType?: unknown };
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
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
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
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
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
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
    const { role, target, provider, id } = body as {
      role?: unknown;
      target?: unknown;
      provider?: unknown;
      id?: unknown;
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
    if (target !== "primary" && target !== "fallback") {
      errorResponse(response, 400, "invalid_request", "\"target\" must be primary, fallback, or clear_fallbacks.");
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

    const controller = new AbortController();
    response.writeHead(200, { ...SSE_HEADERS, "x-ghost-turn-id": turnId });
    // A turn can idle behind a slow model; keep the connection warm. The
    // pinned client skips frames without a `data:` line, so a comment costs
    // nothing on the far end.
    const keepalive = setInterval(() => {
      if (!response.writableEnded) response.write(SSE_KEEPALIVE_COMMENT);
    }, SSE_KEEPALIVE_INTERVAL_MS);
    liveStreams.add(response);

    const onClose = () => {
      // The visitor navigated away or the socket dropped: stop generating.
      if (!controller.signal.aborted) controller.abort();
    };
    response.on("close", onClose);

    const emit = (event: PiMessagesEvent): void => {
      if (response.writableEnded) return;
      response.write(encodeSseEvent(event));
    };

    try {
      await run(emit, controller.signal);
    } catch (error) {
      // runTurn guarantees a terminal event for anything that happens inside
      // the turn; this path is for the refusals it throws instead (a busy
      // session), which still have to reach the client in-stream because the
      // status line is already sent.
      emit({
        type: "error",
        reason: "error",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(keepalive);
      liveStreams.delete(response);
      response.off("close", onClose);
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
    await streamSessionEvents(request, response, (emit, signal) =>
      options.host.runTurn(ghost.name, {
        sessionId: parsed.sessionId,
        prompt: parsed.prompt,
        emit,
        signal,
        includeThinking: options.includeThinking,
      }));
  };

  const handleBranch = async (
    ghostName: string,
    sessionId: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
    const { action, entryId } = body as { action?: unknown; entryId?: unknown };
    if (typeof entryId !== "string" || entryId === "") {
      errorResponse(response, 400, "invalid_request", '"entryId" must be a non-empty string.');
      return;
    }
    if (action === "rewind") {
      jsonResponse(
        response,
        200,
        await options.host.branchConversation(ghostName, sessionId, entryId),
      );
      return;
    }
    if (action === "navigate") {
      jsonResponse(
        response,
        200,
        await options.host.navigateConversation(ghostName, sessionId, entryId),
      );
      return;
    }
    errorResponse(response, 400, "invalid_request", '"action" must be "rewind" or "navigate".');
  };

  const handleAskReanswer = async (
    ghostName: string,
    sessionId: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
    const { entryId } = body as { entryId?: unknown };
    if (typeof entryId !== "string" || entryId === "") {
      errorResponse(response, 400, "invalid_request", '"entryId" must be a non-empty string.');
      return;
    }
    options.registry.get(ghostName);
    await streamSessionEvents(request, response, (emit, signal) =>
      options.host.runAskReanswer(ghostName, {
        sessionId,
        entryId,
        emit,
        signal,
        includeThinking: options.includeThinking,
      }));
  };

  const handleAsk = async (
    ghostName: string,
    sessionId: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, { ask: options.host.pendingAsk(ghostName, sessionId) });
      return;
    }
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
    const { askId, ...answer } = body as Record<string, unknown>;
    if (typeof askId !== "string" || askId === "") {
      errorResponse(response, 400, "invalid_request", '"askId" must be a non-empty string.');
      return;
    }
    options.host.answerAsk(ghostName, sessionId, askId, answer);
    jsonResponse(response, 200, { accepted: true });
  };

  const handleQueue = async (
    ghostName: string,
    sessionId: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (method === "GET") {
      jsonResponse(response, 200, options.host.queuedMessages(ghostName, sessionId));
      return;
    }
    if (method !== "POST") {
      errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
      return;
    }
    const body = await readJsonBody(request, maxBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      errorResponse(response, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }
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
      await options.host.queueMessage(ghostName, sessionId, mode, text.trim()),
    );
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
      if (refuseUnauthenticated(request, response, method, segments)) return;

      try {
        if (segments[0] !== "api") {
          errorResponse(response, 404, "not_found", "Not found.");
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
        if (segments.length === 4 && segments[3] === "messages") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleMessages(ghostName, request, response);
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
            decodePathSegment(segments[4] ?? ""),
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
            decodePathSegment(segments[4] ?? ""),
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
            decodePathSegment(segments[4] ?? ""),
            url,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "ask") {
          return await handleAsk(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "queue") {
          return await handleQueue(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "branch") {
          return await handleBranch(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            method,
            request,
            response,
          );
        }
        if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "reanswer") {
          return await handleAskReanswer(
            ghostName,
            decodePathSegment(segments[4] ?? ""),
            method,
            request,
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

/** The relay hub a `createDaemonServer` built for itself, if it built one. */
export function relayHubOf(server: Server): RelayHub | undefined {
  return (server as unknown as Record<symbol, RelayHub | null | undefined>)[RELAY_HUB] ?? undefined;
}

/** Start the API on a loopback address. `port: 0` picks an ephemeral port. */
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
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
        // Keep-alive sockets would otherwise hold the close open until they
        // time out; a local daemon should exit when it is told to.
        server.closeIdleConnections();
      });
    },
  };
}
