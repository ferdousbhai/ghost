/**
 * The daemon's HTTP API — exactly the four routes in CONTRACTS.md, on
 * loopback, with no auth (v1 localhost trust).
 *
 *   GET  /api/ghosts                  → [{ name, dir, createdAt }]
 *   POST /api/ghosts                  { name } → creates ~/Ghosts/<name>/
 *   POST /api/ghosts/:name/messages   pi-messages request → SSE of pi-messages events
 *   GET  /api/ghosts/:name/sessions   → pi session listing for that ghost
 *
 * Node's built-in `http` plus a twenty-line router: the surface is four
 * routes and one of them is a stream, which is precisely the shape a
 * framework would add weight to without adding clarity.
 *
 * Error bodies are `{ "error": { "message", "code" } }` — the shape the
 * pinned pi-messages client parses out of a non-2xx response
 * (`parsed.error.message` / `parsed.error.code`), and the same shape the
 * hosted relay returns, so a client needs no daemon-specific branch.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { assertLoopback } from "./config.js";
import { GhostError, type GhostRegistry } from "./ghosts.js";
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
import type { SessionHost } from "./session-host.js";

export interface ServerOptions {
  registry: GhostRegistry;
  host: SessionHost;
  logger?: Logger;
  /** Max request body. A turn is a few KB; this is a sanity bound. */
  maxBodyBytes?: number;
  /** Forward `thinking_*` blocks on the wire. Off by default. */
  includeThinking?: boolean;
}

export interface ListeningServer {
  server: Server;
  port: number;
  address: string;
  /** Stop accepting, end live streams, and resolve once closed. */
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const TURN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Live SSE responses, stashed on the server so close() can end them. */
const LIVE_STREAMS = Symbol.for("ghostd.liveStreams");

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

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !LOOPBACK_ORIGIN.test(origin)) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
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

export function createDaemonServer(options: ServerOptions): Server {
  const logger = options.logger ?? silentLogger;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const liveStreams = new Set<ServerResponse>();

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

  const handleListSessions = async (
    ghostName: string,
    response: ServerResponse,
  ): Promise<void> => {
    jsonResponse(response, 200, await options.host.listSessions(ghostName));
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
      await options.host.runTurn(ghost.name, {
        sessionId: parsed.sessionId,
        prompt: parsed.prompt,
        emit,
        signal: controller.signal,
        includeThinking: options.includeThinking,
      });
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

  const server = createServer((request, response) => {
    void (async () => {
      applyCors(request, response);
      const method = request.method ?? "GET";
      if (method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);

      try {
        if (segments[0] !== "api" || segments[1] !== "ghosts") {
          errorResponse(response, 404, "not_found", "Not found.");
          return;
        }
        if (segments.length === 2) {
          if (method === "GET") return handleListGhosts(response);
          if (method === "POST") return await handleCreateGhost(request, response);
          errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
          return;
        }
        const ghostName = decodeURIComponent(segments[2] ?? "");
        if (segments.length === 4 && segments[3] === "messages") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleMessages(ghostName, request, response);
        }
        if (segments.length === 4 && segments[3] === "sessions") {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleListSessions(ghostName, response);
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
        logger.error("request failed", {
          path: url.pathname,
          error: (error as Error).message,
        });
        errorResponse(response, 500, "internal_error", "The daemon failed to handle the request.");
      }
    })();
  });

  // Exposed so close() can end streams that would otherwise hold shutdown open.
  Object.assign(server, { [LIVE_STREAMS]: liveStreams });
  return server;
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
  return {
    server,
    port: bound.port,
    address,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        const streams = (server as unknown as Record<symbol, Set<ServerResponse>>)[LIVE_STREAMS];
        for (const stream of streams ?? []) {
          if (!stream.writableEnded) stream.end();
        }
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
        // Keep-alive sockets would otherwise hold the close open until they
        // time out; a local daemon should exit when it is told to.
        server.closeIdleConnections();
      }),
  };
}
