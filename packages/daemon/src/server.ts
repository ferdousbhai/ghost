/**
 * The daemon's HTTP API — the four routes in CONTRACTS.md, on loopback, with no
 * auth (v1 localhost trust), plus the browser relay.
 *
 *   GET  /api/ghosts                  → [{ name, dir, createdAt }]
 *   POST /api/ghosts                  { name } → creates ~/Ghosts/<name>/
 *   POST /api/ghosts/:name/messages   pi-messages request → SSE of pi-messages events
 *   GET  /api/ghosts/:name/sessions   → pi session listing for that ghost
 *   GET  /api/relay/status            → whether the creator's Chromium is paired
 *   WS   /relay                       → the MV3 extension's socket (token-gated)
 *
 * Node's built-in `http` plus a twenty-line router: the surface is small and one
 * route is a stream, which is precisely the shape a framework would add weight to
 * without adding clarity.
 *
 * The relay is the one thing here that is *not* covered by localhost trust, and
 * the reason is worth stating: the peer is a browser, and a browser runs code
 * written by strangers. `/relay` therefore carries a pairing token, refuses any
 * `Origin` that is not a browser extension, and accepts one connection at a time.
 * `/api/relay/status` never returns the token — `ghostd relay-token` does.
 *
 * Error bodies are `{ "error": { "message", "code" } }` — the shape the
 * pinned pi-messages client parses out of a non-2xx response
 * (`parsed.error.message` / `parsed.error.code`), and the same shape the
 * hosted relay returns, so a client needs no daemon-specific branch.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthType } from "@earendil-works/pi-ai";
import type { LoginManager } from "./auth.js";
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
  // `undefined` means "decide for me"; `null` means "no relay on this server".
  const relay = options.relay === undefined
    ? createRelayHub({ ...(options.logger ? { logger: options.logger } : {}) })
    : options.relay;

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
        if (segments[0] !== "api") {
          errorResponse(response, 404, "not_found", "Not found.");
          return;
        }
        if (segments[1] === "relay" && segments[2] === "status" && segments.length === 3) {
          if (method !== "GET") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          // Never the token itself, only where it lives: this route has no auth,
          // and a page on a loopback origin can read it.
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
          return handleLoginStatus(ghostName, decodeURIComponent(segments[4] ?? ""), response);
        }
        if (segments.length === 6 && segments[3] === "login" && segments[5] === "input") {
          if (method !== "POST") {
            errorResponse(response, 405, "method_not_allowed", `${method} is not allowed here.`);
            return;
          }
          return await handleLoginInput(ghostName, decodeURIComponent(segments[4] ?? ""), request, response);
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
