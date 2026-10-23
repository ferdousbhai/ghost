import { parseExternalEvent } from "./external-events.js";
import type { SharedResult } from "./results.js";
import { pipeline } from "node:stream/promises";
import { TurnBuffer } from "./turn-buffer.js";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import { readBoard } from "./board.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiTokenPath, ensureApiToken, tokenMatches } from "./token-store.js";
import { MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { assertLoopback } from "./config.js";
import { REMOTE_MANIFEST, REMOTE_VIEWER_CSP, REMOTE_VIEWER_HTML } from "./remote-viewer.js";
import type { RemoteServe } from "./remote-serve.js";
import type { RemoteAccess, TailscaleIdentity } from "./tailscale-identity.js";
import { requireConversationId } from "./conversation-log.js";
import type {
  McpCatalog,
} from "./mcp-catalog.js";
import { MAX_CHARACTER_BODY_LENGTH, openGhostHome } from "./home.js";
import { resolveDocumentsDirectory } from "./xdg-user-dirs.js";
import { errorMessage } from "./errors.js";
import { isRecord } from "./record.js";
import {
  GhostError,
  type GhostRegistry,
} from "./ghosts.js";
import type { GhostHookRunner } from "./hooks.js";
import type { GhostHookCommandConfig } from "./hook-policy.js";
import { silentLogger, type Logger } from "./log.js";
import {
  encodeSseEvent,
  parseTurnRequest,
  SSE_HEADERS,
  SSE_KEEPALIVE_COMMENT,
  SSE_KEEPALIVE_INTERVAL_MS,
  type TurnEvent,
  type TurnResumeEvent,
} from "./turn-events.js";
import type { RunningSource } from "./running-source.js";
import type { SessionHost } from "./session-host.js";

export interface ServerOptions {
  registry: GhostRegistry;
  host: SessionHost;
  /** What runs this daemon. Omitted, `GET /api/status` reports it as unknown. */
  runningSource?: RunningSource;
  mcp?: McpCatalog;
  hooks?: Pick<GhostHookRunner, "config" | "replaceConfig">;
  logger?: Logger;
  maxBodyBytes?: number;
  /**
   * The bearer token every private `/api` route requires.
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
  /** Response size for turn continuation and invalidation reconnects; about 1 MB by default. */
  streamCutBytes?: number;
}

export interface ListeningServer {
  server: Server;
  port: number;
  address: string;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
/** Qt's XHR rebuilds a response's whole body on every chunk, so the HUD's cost grows with it. */
const DEFAULT_STREAM_CUT_BYTES = 1_048_576;
/** How long an ended turn stays resumable, for a client cut just before the end. */
const RESUME_GRACE_MS = 60_000;

/** One turn's events, kept while it runs (and briefly after) so a cut response can resume. */
interface TurnLog {
  readonly id: string;
  readonly ghost: string;
  readonly conversation: string;
  /** Each event SSE-encoded; once `ended`, the last is the terminal. */
  readonly frames: TurnBuffer;
  expiry?: ReturnType<typeof setTimeout>;
  ended: boolean;
  failure?: string;
  readonly followers: Set<() => void>;
}

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
 * `application/json`, or `image/*` for an attachment, parameters allowed
 * (`; charset=utf-8`). The point is to exclude the three types a form can post
 * without a preflight — `text/plain`, `application/x-www-form-urlencoded`,
 * `multipart/form-data` — so a mutating route cannot be reached by a simple
 * cross-site request.
 */
function isPreflightedContentType(header: string | string[] | undefined): boolean {
  const type = typeof header === "string" ? (header.split(";")[0] ?? "").trim().toLowerCase() : "";
  return type === "application/json" || type.startsWith("image/");
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !LOOPBACK_ORIGIN.test(origin)) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const body = await readBody(request, maxBytes);
  try {
    return JSON.parse(body.toString("utf8"));
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
  const path = apiTokenPath();
  const minted = ensureApiToken(path);
  // The path, never the token: `ghostd api-token` is the only way to see it.
  logger.info(minted.created ? "minted the API token" : "API token loaded", { path });
  return minted.token;
}

/** The server, plus what `close()` needs: streams to end. */
function createDaemonServer(options: ServerOptions): { server: Server; liveStreams: Set<ServerResponse> } {
  const logger = options.logger ?? silentLogger;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const liveStreams = new Set<ServerResponse>();
  const apiToken = resolveApiToken(options.apiToken, logger);
  const remote = options.remote ?? null;
  const remoteServe = options.remoteServe;
  const streamCutBytes = options.streamCutBytes ?? DEFAULT_STREAM_CUT_BYTES;
  const turnLogs = new Map<string, TurnLog>();

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
    if ((method === "POST" || method === "PUT") && !isPreflightedContentType(request.headers["content-type"])) {
      errorResponse(
        response,
        415,
        "unsupported_media_type",
        "Mutating requests must be application/json, or an image for an attachment.",
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
    /** The route's `:ghost`, decoded; empty where it has none. */
    ghost: string;
    /** The route's `:id`, validated; empty where it has none. */
    id: string;
    /** The request's JSON object body, read within the size bound. */
    body(): Promise<Record<string, unknown>>;
  }

  /**
   * The owner's `hooks.json`, read and replaced whole. Whole-document
   * replacement keeps "groups run in file order" honest: there are no per-hook
   * ids to invent for a file that has none. The daemon's loader is the only
   * validator; a client shows its message rather than re-implementing the
   * schema.
   */
  const handleHookConfig = async ({ method, request, response }: RequestContext): Promise<void> => {
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
    // A replacement names only `hooks` (and the ignored legacy `builtin`), so a pasted
    // `{ path, document }` reply is refused instead of silently disabling every hook.
    const stray = document && typeof document === "object" && !Array.isArray(document)
      ? Object.keys(document).filter(key => key !== "hooks" && key !== "builtin") : [];
    if (stray.length > 0) throw new GhostError("invalid_request", `hooks.json has no top-level ${stray.map(key => JSON.stringify(key)).join(", ")}; send the document itself.`, 400);
    let replaced: GhostHookCommandConfig;
    try {
      replaced = await hooks.replaceConfig(document);
    } catch (error) {
      throw new GhostError("invalid_request", errorMessage(error), 400);
    }
    jsonResponse(response, 200, { path: replaced.path, document: replaced.document });
  };

  /**
   * Trash one ghost. `?confirm=<name>` must repeat the name exactly: a DELETE
   * is one path segment away from every other ghost route, and this is the
   * API-level guard against an accidental or scripted one taking a persona and
   * its memory with it. The deletion itself is a move into the
   * system trash, never an erase.
   */
  const handleDeleteGhost = async ({ ghost: ghostName, url, response }: RequestContext): Promise<void> => {
    if (url.searchParams.get("confirm") !== ghostName) {
      throw new GhostError(
        "confirmation_required",
        `Deleting a ghost needs its name repeated: ?confirm=${encodeURIComponent(ghostName)}.`,
        400,
      );
    }
    await options.host.deleteGhost(ghostName);
    logger.info("ghost deleted", { ghost: ghostName });
    jsonResponse(response, 200, { ok: true });
  };

  /**
   * Passive conversation-list invalidations. This subscription never opens a
   * hosted session; disconnect cleanup drops both its listener and keepalive.
   */
  const handleConversationEvents = ({ ghost: ghostName, request, response }: RequestContext): void => {
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
    const finish = () => {
      cleanup();
      if (!response.writableEnded) response.end();
    };
    let written = 0;
    const write = (frame: string) => {
      if (closed || response.writableEnded) return;
      const accepted = response.write(frame);
      written += Buffer.byteLength(frame);
      if (!accepted || written >= streamCutBytes) finish();
    };
    unsubscribe = options.host.subscribeConversationEvents(
      ghostName,
      (event) => write(encodeSseEvent(event)),
      finish,
    );
    response.writeHead(200, SSE_HEADERS);
    liveStreams.add(response);
    connection.signal.addEventListener("abort", cleanup, { once: true });
    write(SSE_KEEPALIVE_COMMENT);
    if (!closed) keepalive = setInterval(() => write(SSE_KEEPALIVE_COMMENT), SSE_KEEPALIVE_INTERVAL_MS);
  };

  /** `{ harness }`: an agent id, or (for the ghost default) null for automatic. */
  const readHarnessBody = async ({ body }: RequestContext, nullable: boolean): Promise<string | null> => {
    const { harness } = await body();
    if (typeof harness === "string" && harness !== "") return harness;
    if (nullable && harness === null) return null;
    throw new GhostError("invalid_request", nullable ? '"harness" must be an agent id or null.' : '"harness" must be an agent id.', 400);
  };

  /**
   * An image body from any owner, or JSON `{ path }` naming a local image
   * from the machine-local token: the HUD's pasted or dropped picture.
   */
  const handleSaveAttachment = async ({ ghost, id, request, response, admission }: RequestContext): Promise<void> => {
    let bytes: Uint8Array;
    if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
      bytes = await readBody(request, MAX_ATTACHMENT_BYTES);
    } else {
      if (admission.identity) throw new GhostError("local_only", "Only the machine-local token attaches a local file.", 403);
      const path = stringField(await readJsonObjectBody(request, maxBodyBytes), "path");
      if (!isAbsolute(path)) throw new GhostError("invalid_request", "\"path\" must be absolute.", 400);
      const size = await stat(path).then((s) => s.isFile() ? s.size : -1, () => -1);
      if (size < 0) throw new GhostError("not_found", `No file at ${path}.`, 404);
      if (size > MAX_ATTACHMENT_BYTES) throw new GhostError("payload_too_large", "An attachment is at most 20 MiB.", 413);
      bytes = await readFile(path);
    }
    jsonResponse(response, 201, { path: await options.host.saveAttachment(ghost, id, bytes) });
  };

  const handleReadAttachment = async ({ ghost, id, params, response }: RequestContext): Promise<void> => {
    const { bytes, type } = await options.host.readAttachment(ghost, id, decodePathSegment(params.file ?? ""));
    response.writeHead(200, {
      "content-type": type,
      "content-length": bytes.length,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    response.end(bytes);
  };

  /** Run an admitted turn into a new log, which ends in exactly one terminal event. */
  const startTurnLog = (
    ghost: string,
    conversation: string,
    run: (emit: (event: TurnEvent) => void) => Promise<void>,
  ): TurnLog => {
    const log: TurnLog = { id: randomUUID(), ghost, conversation, frames: new TurnBuffer(), ended: false, followers: new Set() };
    turnLogs.set(log.id, log);
    const append = (event: TurnEvent): void => {
      if (log.ended) return;
      try {
        log.frames.push(encodeSseEvent(event));
        if (event.type === "done" || event.type === "error") log.ended = true;
      } catch (error) {
        log.ended = true;
        log.failure = encodeSseEvent({ type: "error", reason: "error", errorMessage: "Could not retain the turn stream; read the transcript." });
        logger.error("turn replay storage failed", { error: errorMessage(error) });
        try { options.host.stopTurn(ghost, conversation); } catch { /* The turn may already have settled. */ }
      }
      for (const follower of [...log.followers]) follower();
    };
    void run(append).then(
      // Keep the HTTP seam honest even if a runtime regresses: every client
      // gets a terminal; after the turn's own, this is a no-op.
      () => append({ type: "error", reason: "error", errorMessage: "The turn ended without a terminal event." }),
      // The admitted run emits its own error terminal before rethrowing, so
      // this too is a no-op unless a runtime regresses.
      (error: unknown) => append({ type: "error", reason: "error", errorMessage: errorMessage(error) }),
    ).finally(() => {
      if (!turnLogs.has(log.id)) return;
      log.expiry = setTimeout(() => {
        turnLogs.delete(log.id);
        if (log.followers.size === 0) log.frames.dispose();
      }, RESUME_GRACE_MS);
      log.expiry.unref();
    });
    return log;
  };

  /**
   * Stream `log` from event `from` until its terminal, or until about
   * `streamCutBytes` have gone out, when a `resume` frame ends the response.
   * A client that goes away stops listening, never the turn: `POST …/stop` is
   * the only stop.
   */
  const followTurn = (request: IncomingMessage, response: ServerResponse, log: TurnLog, from: number): Promise<void> =>
    new Promise((resolveFollow) => {
      const connection = abortOnClose(request, response);
      response.writeHead(200, SSE_HEADERS);
      response.write(SSE_KEEPALIVE_COMMENT);
      // A turn can idle behind a slow model; keep the connection warm. Ghost's
      // in-repo SSE parsers skip frames without a `data:` line, so a comment
      // costs nothing on the far end.
      const keepalive = setInterval(() => {
        if (!response.writableEnded && !response.writableNeedDrain) response.write(SSE_KEEPALIVE_COMMENT);
      }, SSE_KEEPALIVE_INTERVAL_MS);
      liveStreams.add(response);
      let next = from;
      let written = 0;
      let finished = false;
      let blocked = false;
      const drain = (): void => { blocked = false; pump(); };
      const finish = (): void => {
        if (finished) return;
        finished = true;
        log.followers.delete(pump);
        if (!turnLogs.has(log.id) && log.followers.size === 0) log.frames.dispose();
        response.off("drain", drain);
        clearInterval(keepalive);
        liveStreams.delete(response);
        connection.release();
        if (!response.writableEnded) response.end();
        resolveFollow();
      };
      const pump = (): void => {
        if (connection.signal.aborted || response.writableEnded) {
          finish();
          return;
        }
        if (log.failure) {
          response.write(log.failure);
          finish();
          return;
        }
        if (blocked) return;
        while (next < log.frames.length) {
          let frame: string;
          try {
            frame = log.frames.at(next++);
          } catch (error) {
            logger.error("turn replay read failed", { error: errorMessage(error) });
            response.write(encodeSseEvent({ type: "error", reason: "error", errorMessage: "Could not replay the turn stream; read the transcript." }));
            finish();
            return;
          }
          blocked = !response.write(frame);
          written += Buffer.byteLength(frame);
          // Never cut after the terminal: there is nothing left to resume.
          if (written >= streamCutBytes && !(log.ended && next === log.frames.length)) {
            const resume: TurnResumeEvent = { type: "resume", turn: log.id, from: next };
            response.write(encodeSseEvent(resume));
            finish();
            return;
          }
          if (blocked) return;
        }
        if (log.ended) finish();
      };
      response.on("drain", drain);
      connection.signal.addEventListener("abort", finish, { once: true });
      log.followers.add(pump);
      pump();
    });

  const handleMessages = async ({ ghost: ghostName, request, response, body }: RequestContext): Promise<void> => {
    // Fail before any byte of the stream, so the client sees a real status
    // code rather than an SSE error event it has to unwrap.
    const ghost = options.registry.get(ghostName);
    const parsed = parseTurnRequest(await body());
    const admission = await options.host.admitTurn(ghost.name, {
      sessionId: parsed.sessionId,
      prompt: parsed.prompt,
    });
    const log = startTurnLog(ghost.name, parsed.sessionId ?? "default", (emit) => admission.run({ emit }));
    await followTurn(request, response, log, 0);
  };

  /** The rest of a cut turn response; see CONTRACTS.md, "Turn wire". */
  const handleTurnStream = async ({ ghost: ghostName, id, url, request, response }: RequestContext): Promise<void> => {
    const ghost = options.registry.get(ghostName);
    const log = turnLogs.get(url.searchParams.get("turn") ?? "");
    if (!log || log.ghost !== ghost.name || log.conversation !== id) {
      throw new GhostError("turn_not_found", "That turn is no longer resumable; read the transcript.", 404);
    }
    const from = numberParam(url, "from");
    if (from === undefined || !Number.isInteger(from) || from < 0 || from > log.frames.length) {
      throw new GhostError("invalid_request", "\"from\" must be an event index this turn has reached.", 400);
    }
    await followTurn(request, response, log, from);
  };

  const requireMcp = (): McpCatalog => {
    if (!options.mcp) throw new GhostError("not_found", "MCP management is not enabled on this daemon.", 404);
    return options.mcp;
  };
  const requireRemoteServe = (): RemoteServe => {
    if (!remoteServe) throw new GhostError("not_found", "Remote access is not available.", 404);
    return remoteServe;
  };
  const serverOf = (params: Record<string, string>) => decodePathSegment(params.server ?? "");
  /** A route a tailnet guest is refused: it shows file paths, hook commands, or MCP credentials. */
  const ownerOnly = <C extends RequestContext>(handle: (context: C) => unknown) => (context: C) => {
    if (context.admission.identity?.role === "guest") {
      throw new GhostError("owner_only", "Only the owner may see this.", 403);
    }
    return handle(context);
  };

  const resultBody = (ghost: string, session: string, result: SharedResult) => ({
    ...result, downloadUrl: `/api/ghosts/${encodeURIComponent(ghost)}/sessions/${encodeURIComponent(session)}/results/${result.id}`,
  });

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
      jsonResponse(response, 200, { role: admission.identity?.role ?? "owner" });
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
    route("GET", "api/remote", async ({ response }) => {
      jsonResponse(response, 200, await requireRemoteServe().status());
    }),
    route("POST", "api/remote", async ({ response, body }) => {
      const remote = requireRemoteServe();
      jsonResponse(response, 200, await (booleanField(await body(), "enabled") ? remote.enable() : remote.disable()));
    }),
    route("GET PUT", "api/hooks/config", ownerOnly(handleHookConfig)),
    // The owner's board.md, parsed. Guests may read it: it is the one owner
    // document meant to be looked at, and it is read-only here.
    route("GET", "api/board", async ({ response }) => {
      jsonResponse(response, 200, await readBoard(resolveDocumentsDirectory(process.env, homedir())));
    }),
    route("GET", "api/status", ownerOnly(({ response }) => {
      jsonResponse(response, 200, {
        version: options.runningSource?.version ?? null,
        source: { commit: options.runningSource?.commit ?? null, root: options.runningSource?.root ?? null },
      });
    })),
    route("GET", "api/ghosts", ({ response }) => jsonResponse(response, 200, options.registry.list())),
    route("POST", "api/ghosts", async ({ response, body }) => {
      const ghost = options.host.createGhost(stringField(await body(), "name"));
      logger.info("ghost created", { ghost: ghost.name });
      jsonResponse(response, 201, ghost);
    }),
    route("DELETE", "api/ghosts/:ghost", handleDeleteGhost),
    route("GET", "api/ghosts/:ghost/character", async ({ ghost, response }) => {
      const character = await options.host.withGhost(ghost, () =>
        openGhostHome(options.registry.get(ghost).dir).readCharacter({ enforceLimit: false }));
      jsonResponse(response, 200, { body: character?.body ?? "", limit: MAX_CHARACTER_BODY_LENGTH });
    }),
    route("PUT", "api/ghosts/:ghost/character", async ({ ghost, response, body }) => {
      const text = stringField(await body(), "body");
      await options.host.withGhost(ghost, () => openGhostHome(options.registry.get(ghost).dir).writeCharacter({ body: text }));
      jsonResponse(response, 200, { ok: true, limit: MAX_CHARACTER_BODY_LENGTH });
    }),
    route("GET", "api/ghosts/:ghost/routines", ownerOnly(async ({ ghost, response }) => {
      jsonResponse(response, 200, await options.host.routines(ghost));
    })),
    route("POST", "api/ghosts/:ghost/routines/recoveries/:recovery/restore", ownerOnly(async ({ ghost, params, response, body }) => {
      await body();
      jsonResponse(response, 200, await options.host.restoreRoutine(ghost, decodePathSegment(params.recovery ?? "")));
    })),
    route("GET", "api/ghosts/:ghost/routines/:slug/logs", ownerOnly(async ({ ghost, params, response }) => {
      jsonResponse(response, 200, await options.host.routineLogs(ghost, decodePathSegment(params.slug ?? "")));
    })),
    route("GET PUT", "api/ghosts/:ghost/routines/:slug/config", ownerOnly(async ({ ghost, params, method, response, body }) => {
      const slug = decodePathSegment(params.slug ?? "");
      if (method === "GET") jsonResponse(response, 200, await options.host.routineConfig(ghost, slug));
      else {
        const input = await body();
        jsonResponse(response, 200, await options.host.saveRoutine(ghost, slug, {
          timer: stringField(input, "timer"), service: stringField(input, "service"), revision: stringField(input, "revision"),
        }));
      }
    })),
    route("DELETE", "api/ghosts/:ghost/routines/:slug", ownerOnly(async ({ ghost, params, url, response }) => {
      jsonResponse(response, 200, await options.host.removeRoutine(ghost, decodePathSegment(params.slug ?? ""), url.searchParams.get("revision") ?? ""));
    })),
    route("POST", "api/ghosts/:ghost/routines/:slug/:action", ownerOnly(async ({ ghost, params, response, body }) => {
      await body();
      await options.host.controlRoutine(ghost, decodePathSegment(params.slug ?? ""), decodePathSegment(params.action ?? ""));
      jsonResponse(response, 200, { ok: true });
    })),
    route("GET", "api/ghosts/:ghost/harness", async ({ ghost, response }) => {
      jsonResponse(response, 200, await options.host.listHarnesses(ghost));
    }),
    route("PUT", "api/ghosts/:ghost/harness", async (context) => {
      jsonResponse(context.response, 200, await options.host.setGhostHarness(context.ghost, await readHarnessBody(context, true)));
    }),
    route("POST", "api/ghosts/:ghost/messages", handleMessages),
    route("POST", "api/ghosts/:ghost/events", ownerOnly(async ({ ghost, body, response }) => {
      const accepted = await options.host.admitEvent(ghost, parseExternalEvent(await body()));
      const admission = accepted.admission;
      if (admission) startTurnLog(ghost, accepted.sessionId, (emit) => admission.run({ emit }));
      jsonResponse(response, accepted.admission ? 202 : 200, { sessionId: accepted.sessionId, duplicate: accepted.admission === null });
    })),
    route("GET", "api/ghosts/:ghost/events", handleConversationEvents),
    // The name is the home directory's name, so a rename moves the whole home
    // and every other route's `:ghost` changes with it.
    route("PUT", "api/ghosts/:ghost/name", async ({ ghost, response, body }) => {
      const renamed = await options.host.renameGhost(ghost, stringField(await body(), "name"));
      logger.info("ghost renamed", { ghost, name: renamed.name });
      jsonResponse(response, 200, { ok: true, name: renamed.name });
    }),
    route("GET", "api/ghosts/:ghost/sessions", async ({ ghost, response }) => {
      jsonResponse(response, 200, { sessions: await options.host.listSessions(ghost) });
    }),
    route("DELETE", "api/ghosts/:ghost/sessions/:id", async ({ ghost, id, response }) => {
      await options.host.deleteSession(ghost, id);
      jsonResponse(response, 200, { ok: true });
    }),
    route("PUT", "api/ghosts/:ghost/sessions/:id/harness", async (context) => {
      jsonResponse(context.response, 200, await options.host.chooseHarness(context.ghost, context.id, await readHarnessBody(context, false) as string));
    }),
    // Idempotent, so the shell sends the state it wants rather than a toggle.
    route("PUT", "api/ghosts/:ghost/sessions/:id/pin", async ({ ghost, id, response, body }) => {
      const pinned = booleanField(await body(), "pinned");
      await options.host.setPinned(ghost, id, pinned);
      jsonResponse(response, 200, { ok: true, pinned });
    }),
    route("PUT", "api/ghosts/:ghost/sessions/:id/read", async ({ ghost, id, response, body }) => {
      const input = await body();
      const readAt = input.readThrough === undefined ? new Date() : new Date(stringField(input, "readThrough"));
      if (!Number.isFinite(readAt.getTime()) || readAt.getTime() > Date.now()) throw new GhostError("invalid_request", "readThrough must be a valid timestamp no later than now.", 400);
      jsonResponse(response, 200, { ok: true, readAt: await options.host.markRead(ghost, id, readAt) });
    }),
    route("PUT", "api/ghosts/:ghost/sessions/:id/title", async ({ ghost, id, response, body }) => {
      const title = await options.host.renameConversation(ghost, id, stringField(await body(), "title"));
      jsonResponse(response, 200, { ok: true, title });
    }),
    route("POST", "api/ghosts/:ghost/sessions/:id/attachments", handleSaveAttachment),
    route("GET", "api/ghosts/:ghost/sessions/:id/attachments/:file", handleReadAttachment),
    route("GET", "api/ghosts/:ghost/sessions/:id/stream", handleTurnStream),
    route("GET", "api/ghosts/:ghost/sessions/:id/results", ownerOnly(async ({ ghost, id, response }) => {
      jsonResponse(response, 200, { results: (await options.host.results(ghost, id)).map(result => resultBody(ghost, id, result)) });
    })),
    route("POST", "api/ghosts/:ghost/sessions/:id/results", ownerOnly(async ({ ghost, id, body, response, admission }) => {
      if (admission.identity) throw new GhostError("machine_local_only", "Select result sources through the machine-local CLI.", 403);
      jsonResponse(response, 201, resultBody(ghost, id, await options.host.publishResult(ghost, id, stringField(await body(), "path"))));
    })),
    route("DELETE", "api/ghosts/:ghost/sessions/:id/results/:result", ownerOnly(async ({ ghost, id, params, response }) => {
      await options.host.revokeResult(ghost, id, decodePathSegment(params.result ?? ""));
      jsonResponse(response, 200, { ok: true });
    })),
    route("GET", "api/ghosts/:ghost/sessions/:id/results/:result", ownerOnly(async ({ ghost, id, params, response }) => {
      await options.host.withResult(ghost, id, decodePathSegment(params.result ?? ""), async ({ file, result }) => {
        response.writeHead(200, {
          "content-type": "application/octet-stream", "content-length": result.bytes,
          "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16)}`)}`,
          "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox",
        });
        if (!result.bytes) response.end();
        else await pipeline(file.createReadStream({ end: result.bytes - 1 }), response);
      });
    })),
    route("GET", "api/ghosts/:ghost/sessions/:id/transcript", async ({ ghost, id, url, response }) => {
      const readThrough = new Date().toISOString();
      jsonResponse(response, 200, { ...await options.host.readTranscript(ghost, id, { limit: numberParam(url, "limit"), offset: numberParam(url, "offset") }), readThrough });
    }),
    route("POST", "api/ghosts/:ghost/sessions/:id/stop", ({ ghost, id, response }) => {
      options.host.stopTurn(ghost, id);
      jsonResponse(response, 200, { stopped: true });
    }),
    route("GET", "api/ghosts/:ghost/sessions/:id/queue", ({ ghost, id, response }) => {
      jsonResponse(response, 200, options.host.queuedMessages(ghost, id));
    }),
    route("POST", "api/ghosts/:ghost/sessions/:id/queue", async ({ ghost, id, response, body }) => {
      const { text } = await body();
      if (typeof text !== "string" || text.trim() === "") {
        throw new GhostError("invalid_request", '"text" must be a non-empty string.', 400);
      }
      jsonResponse(response, 200, await options.host.queueMessage(ghost, id, text.trim()));
    }),
    route("GET", "api/ghosts/:ghost/mcp", ownerOnly(async ({ ghost, response }) => {
      const mcp = requireMcp();
      jsonResponse(response, 200, await options.host.withGhost(ghost, () => mcp.listLeased(ghost)));
    })),
    route("POST", "api/ghosts/:ghost/mcp", async ({ ghost, response, body }) => {
      const mcp = requireMcp();
      const document = await body();
      const name = stringField(document, "name");
      jsonResponse(response, 201, await options.host.withGhost(ghost, () => mcp.addLeased(ghost, name, document.config)));
    }),
    route("PUT", "api/ghosts/:ghost/mcp/:server", async ({ ghost, params, response, body }) => {
      const mcp = requireMcp();
      const { config } = await body();
      jsonResponse(response, 200, await options.host.withGhost(ghost, () => mcp.updateLeased(ghost, serverOf(params), config)));
    }),
    route("DELETE", "api/ghosts/:ghost/mcp/:server", async ({ ghost, params, response }) => {
      const mcp = requireMcp();
      jsonResponse(response, 200, await options.host.withGhost(ghost, () => mcp.removeLeased(ghost, serverOf(params))));
    }),
    route("PUT", "api/ghosts/:ghost/mcp/:server/enabled", async ({ ghost, params, response, body }) => {
      const mcp = requireMcp();
      const enabled = booleanField(await body(), "enabled");
      jsonResponse(response, 200, await options.host.withGhost(ghost, () => mcp.setEnabledLeased(ghost, serverOf(params), enabled)));
    }),
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
        const { params } = matched;
        await matched.route.handle({
          method, request, response, url, admission, params,
          ghost: params.ghost === undefined ? "" : decodePathSegment(params.ghost),
          id: params.id === undefined ? "" : decodeConversationId(params.id),
          body: () => readJsonObjectBody(request, maxBodyBytes),
        });
      } catch (error) {
        if (response.headersSent) {
          logger.error("request failed after headers were sent", {
            path: url.pathname,
            error: errorMessage(error),
          });
          if (!response.writableEnded) response.end();
          return;
        }
        if (error instanceof GhostError) {
          errorResponse(response, error.status, error.code, error.message);
          // Answer and hang up rather than reading the rest of a body we
          // have already refused.
          if (error.status === 413) response.once("finish", () => request.destroy());
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

  server.on("upgrade", (_request, socket) => socket.destroy());

  server.on("close", () => {
    for (const log of turnLogs.values()) {
      log.ended = true;
      clearTimeout(log.expiry);
      log.frames.dispose();
    }
    turnLogs.clear();
  });
  return { server, liveStreams };
}

export async function startDaemonServer(
  options: ServerOptions & { port: number; address?: string },
): Promise<ListeningServer> {
  const address = options.address ?? "127.0.0.1";
  assertLoopback(address);
  const { server, liveStreams } = createDaemonServer(options);
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
    close: async () => {
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
