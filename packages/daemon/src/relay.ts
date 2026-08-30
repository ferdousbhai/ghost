/**
 * The relay hub — ghostd's end of the socket into the owner's real Chromium.
 *
 * The extension dials *out*. That is the whole architectural decision and it buys
 * three things at once: no inbound listener inside the browser, no native-messaging
 * host to install and register per browser channel, and a connection that survives
 * ghostd restarting (the extension reconnects) without the browser noticing. The
 * cost is that ghostd has to hold a WebSocket server on its existing loopback port,
 * which is what this file is.
 *
 * **One connection.** Not a pool, not a map: one. Two extensions — or one extension
 * in two Chromium profiles — driving the same ghost's tab would interleave clicks
 * on the same page, and the session layer's serialization does not extend across
 * processes. A second connection is refused at the upgrade with a reason a human
 * can act on, rather than silently taking over.
 *
 * **The hub is the `RelayTransport`.** `packages/extensions` defines a
 * three-member interface and `RelayHub` satisfies it, which is why the backend can
 * live in the extensions package with no idea that a daemon, a socket, or `ws`
 * exists.
 *
 * **Pings keep the service worker alive.** An MV3 background worker is killed after
 * ~30s idle; WebSocket traffic resets that timer. A 20s server ping is therefore
 * not just liveness detection, it is the thing that stops the extension from being
 * unloaded between two of the ghost's tool calls.
 *
 * Provenance: the outbound-WebSocket + semantic-verb relay shape is ported from the
 * MIT-licensed `browser-relay` package in https://github.com/can1357/oh-my-pi.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  MAX_CAPTURE_BYTES,
  RELAY_DISCONNECTED_MESSAGE,
  type BrowserFailure,
  type RelayOp,
  type RelayReply,
  type RelayRequestOptions,
  type RelayTransport,
} from "@ghost/extensions";
import { silentLogger, type Logger } from "./log.js";
import {
  authorizeRelayUpgrade,
  encodeServerFrame,
  parseClientFrame,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
} from "./relay-protocol.js";
import { defaultRelayTokenPath, readOrCreateRelayToken } from "./relay-token.js";

export const RELAY_PING_INTERVAL_MS = 20_000;
export const RELAY_HELLO_TIMEOUT_MS = 5_000;
export const RELAY_CLOSE_TIMEOUT_MS = 1_000;
export const RELAY_TIMEOUT_GRACE_MS = 2_000;
export const RELAY_CLOSE_GOING_AWAY = 1001;
export const RELAY_CLOSE_SHUTDOWN = 4000;
export const MAX_RELAY_MESSAGE_BYTES = Math.ceil(MAX_CAPTURE_BYTES / 3) * 4
  + 256 * 1024;

function rawDataBytes(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;
}

export interface RelayHubOptions {
  token?: string;
  logger?: Logger;
  pingIntervalMs?: number;
  helloTimeoutMs?: number;
  closeTimeoutMs?: number;
  incarnation?: string;
  publicUrl?: string;
}

export interface RelayStatus {
  connected: boolean;
  peer: string | null;
  since: string | null;
  protocol: number;
  path: string;
  url: string | null;
  pending: number;
  tokenPath: string | null;
}

interface Pending {
  readonly op: RelayOp;
  readonly settle: (reply: RelayReply) => void;
  readonly timer: NodeJS.Timeout;
}

function disconnectedReply(op: RelayOp, message = RELAY_DISCONNECTED_MESSAGE): RelayReply {
  return { ok: false, failure: "browser_unavailable", message, details: { op } };
}

/** The failure vocabulary is the extensions package's; anything else is a lie. */
const KNOWN_FAILURES = new Set<BrowserFailure>([
  "browser_unavailable",
  "blocked_url",
  "navigation_failed",
  "timeout",
  "no_page",
  "unknown_ref",
  "element_not_found",
  "invalid_input",
]);

function asFailure(value: string): BrowserFailure {
  return KNOWN_FAILURES.has(value as BrowserFailure)
    ? (value as BrowserFailure)
    : "navigation_failed";
}

export class RelayHub implements RelayTransport {
  readonly tokenPath: string | null;

  #token: string | undefined;
  readonly #logger: Logger;
  readonly #pingIntervalMs: number;
  readonly #helloTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #wss: WebSocketServer;
  readonly #pending = new Map<number, Pending>();
  readonly #clients = new Set<WebSocket>();
  readonly #incarnation: string;

  #socket: WebSocket | undefined;
  #negotiatedSocket: WebSocket | undefined;
  #peer: string | undefined;
  #since: Date | undefined;
  #nextId = 1;
  #pingTimer: NodeJS.Timeout | undefined;
  #helloTimer: NodeJS.Timeout | undefined;
  #alive = true;
  #publicUrl: string | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: RelayHubOptions = {}) {
    // The token file is *not* touched here. Constructing a hub is something every
    // `createDaemonServer` does, including in tests; minting a secret into the
    // developer's real home as a side effect of building an object is not.
    this.#token = options.token;
    this.tokenPath = options.token ? null : defaultRelayTokenPath();
    this.#logger = options.logger ?? silentLogger;
    this.#pingIntervalMs = options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? RELAY_HELLO_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? RELAY_CLOSE_TIMEOUT_MS;
    this.#incarnation = options.incarnation ?? randomUUID();
    this.#publicUrl = options.publicUrl;
    // ws applies maxPayload while assembling fragmented messages, before the
    // complete string reaches #onFrame.
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_MESSAGE_BYTES });
  }


  get connected(): boolean {
    return this.#socket !== undefined
      && this.#socket === this.#negotiatedSocket
      && this.#socket.readyState === 1 /* OPEN */;
  }

  get peer(): string | undefined {
    return this.#peer;
  }

  request(
    op: RelayOp,
    args: Readonly<Record<string, unknown>>,
    options: RelayRequestOptions,
  ): Promise<RelayReply> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const socket = this.#negotiatedSocket;
    if (socket?.readyState !== 1) return Promise.resolve(disconnectedReply(op));

    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = Math.max(1_000, options.timeoutMs);

    return new Promise<RelayReply>((resolve, reject) => {
      let settled = false;
      const detachAbort = (): void => options.signal?.removeEventListener("abort", onAbort);
      const clearPending = (): void => {
        const entry = this.#pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.#pending.delete(id);
        }
        detachAbort();
      };
      const settle = (reply: RelayReply): void => {
        if (settled) return;
        settled = true;
        clearPending();
        resolve(reply);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearPending();
        reject(options.signal?.reason);
      };

      // The extension times itself out first and answers with a structured
      // failure; this is the backstop for an extension that stopped answering
      // at all, which is why it sits past the caller's own deadline.
      const timer = setTimeout(() => {
        settle({
          ok: false,
          failure: "timeout",
          message:
            `The browser relay did not answer ${op} within `
            + `${Math.round((timeoutMs + RELAY_TIMEOUT_GRACE_MS) / 1000)}s. The extension may `
            + "be waiting on a page, or Chromium may have suspended it.",
          details: { op, timeoutMs },
        });
      }, timeoutMs + RELAY_TIMEOUT_GRACE_MS);
      timer.unref?.();

      this.#pending.set(id, { op, settle, timer });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        socket.send(encodeServerFrame({ t: "req", id, op, args: { ...args }, timeoutMs }));
      } catch (error) {
        settle(
          disconnectedReply(
            op,
            `The relay socket rejected the request: ${(error as Error).message}`,
          ),
        );
      }
    });
  }


  setPublicUrl(url: string): void {
    this.#publicUrl = url;
  }

  status(): RelayStatus {
    return {
      connected: this.connected,
      peer: this.#peer ?? null,
      since: this.#since?.toISOString() ?? null,
      protocol: RELAY_PROTOCOL_VERSION,
      path: RELAY_PATH,
      url: this.#publicUrl ?? null,
      pending: this.#pending.size,
      tokenPath: this.tokenPath,
    };
  }


  /**
   * Handle an HTTP upgrade. Wired to the server's `upgrade` event; refusals are
   * written as a plain HTTP response so the extension's popup can show the reason
   * instead of an opaque "connection failed".
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.#closed) {
      refuse(socket, 503, "The daemon is shutting down.");
      return;
    }
    let token: string;
    try {
      token = this.#tokenOrMint();
    } catch (error) {
      refuse(socket, 500, `The relay has no pairing token: ${(error as Error).message}`);
      return;
    }
    const decision = authorizeRelayUpgrade(
      {
        url: request.url,
        headers: request.headers,
        remoteAddress: request.socket.remoteAddress,
      },
      token,
    );
    if (!decision.ok) {
      // Never log the URL: the token may be in its query string.
      this.#logger.warn("relay connection refused", {
        status: decision.status,
        reason: decision.reason,
        origin: request.headers.origin ?? null,
      });
      refuse(socket, decision.status, decision.reason);
      return;
    }
    if (this.connected) {
      this.#logger.warn("relay connection refused", {
        status: 409,
        reason: "already connected",
      });
      refuse(
        socket,
        409,
        "A browser is already connected to this relay. Only one at a time.",
      );
      return;
    }

    // A TCP/WebSocket peer has not earned the one relay slot until it proves
    // protocol compatibility. Replace a silent or pre-hello peer immediately;
    // its bounded hello deadline is the backstop when no replacement arrives.
    const unnegotiated = this.#socket;
    if (unnegotiated) {
      this.#socket = undefined;
      this.#negotiatedSocket = undefined;
      this.#peer = undefined;
      this.#since = undefined;
      this.#stopHelloDeadline();
      try {
        unnegotiated.terminate();
      } catch {
        // Its close event, or bounded hub shutdown, performs the final cleanup.
      }
    }

    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#adopt(ws);
    });
  }

  /**
   * The token, minted on the first connection attempt and cached. Deferring it to
   * here means a daemon nobody ever pairs a browser with never writes a secret to
   * disk at all.
   */
  #tokenOrMint(): string {
    if (this.#token === undefined) this.#token = readOrCreateRelayToken().token;
    return this.#token;
  }

  #adopt(ws: WebSocket): void {
    if (this.#closed) {
      ws.terminate();
      return;
    }
    this.#clients.add(ws);
    this.#socket = ws;
    this.#negotiatedSocket = undefined;
    this.#peer = undefined;
    this.#since = undefined;
    this.#alive = true;

    ws.on("message", (data, isBinary) => {
      // maxPayload is the accumulation guard. Keep a second boundary here for
      // alternate ws runtimes, and check it before allocating a UTF-8 string.
      if (rawDataBytes(data) > MAX_RELAY_MESSAGE_BYTES) {
        this.#logger.warn("relay message exceeded its byte limit", {
          maxBytes: MAX_RELAY_MESSAGE_BYTES,
        });
        ws.close(1009, "relay message too large");
        return;
      }
      if (isBinary) {
        this.#logger.warn("relay sent a binary frame; dropping it");
        return;
      }
      this.#onFrame(ws, data.toString());
    });
    ws.on("pong", () => {
      this.#alive = true;
    });
    ws.on("error", (error: Error) => {
      this.#logger.warn("relay socket error", { error: error.message });
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.#clients.delete(ws);
      if (this.#socket !== ws) return;
      this.#socket = undefined;
      this.#negotiatedSocket = undefined;
      this.#peer = undefined;
      this.#since = undefined;
      this.#stopHelloDeadline();
      this.#stopPinging();
      this.#failPending(
        "The browser relay disconnected before it answered. "
        + "Reconnect the extension and try again.",
      );
      this.#logger.info("relay disconnected", { code, reason: reason.toString().slice(0, 200) });
    });

    ws.send(encodeServerFrame({
      t: "welcome",
      protocol: RELAY_PROTOCOL_VERSION,
      daemon: "ghostd",
      incarnation: this.#incarnation,
    }));
    this.#startHelloDeadline(ws);
  }

  #onFrame(ws: WebSocket, raw: string): void {
    if (this.#socket !== ws) return;
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) {
      this.#logger.warn("relay sent an unusable frame", { reason: parsed.reason });
      return;
    }
    const frame = parsed.frame;
    switch (frame.t) {
      case "hello": {
        if (frame.protocol !== RELAY_PROTOCOL_VERSION) {
          this.#logger.warn("relay speaks a different protocol", {
            theirs: frame.protocol,
            ours: RELAY_PROTOCOL_VERSION,
          });
          ws.close(
            RELAY_CLOSE_SHUTDOWN,
            `This daemon speaks relay protocol ${RELAY_PROTOCOL_VERSION}, not ${frame.protocol}. `
              + "Update whichever of ghostd or the Chromium extension is older.",
          );
          return;
        }
        if (this.#negotiatedSocket === ws) {
          this.#logger.warn("relay sent a duplicate hello; dropping it");
          return;
        }
        this.#negotiatedSocket = ws;
        this.#since = new Date();
        this.#stopHelloDeadline();
        this.#peer = [frame.browser, frame.agent].filter(Boolean).join(" via ") || "a browser";
        this.#logger.info("relay connected", { peer: this.#peer });
        this.#startPinging();
        return;
      }
      case "res": {
        if (this.#negotiatedSocket !== ws) {
          this.#logger.warn("relay answered before completing hello; closing it");
          ws.close(1008, "complete relay hello before sending frames");
          return;
        }
        const entry = this.#pending.get(frame.id);
        if (!entry) {
          // A reply to a request we already timed out or canceled locally.
          // Protocol v1 cannot stop the remote work, so dropping it is correct.
          this.#logger.debug("relay answered a request that was no longer pending", {
            id: frame.id,
          });
          return;
        }
        entry.settle(
          frame.ok
            ? { ok: true, result: frame.result }
            : {
              ok: false,
              failure: asFailure(frame.error.failure),
              message: frame.error.message,
              ...(frame.error.details ? { details: frame.error.details } : {}),
            },
        );
        return;
      }
      case "event": {
        if (this.#negotiatedSocket !== ws) {
          this.#logger.warn("relay sent an event before completing hello; closing it");
          ws.close(1008, "complete relay hello before sending frames");
          return;
        }
        this.#logger.debug("relay event", { event: frame.event, ...(frame.data ?? {}) });
        return;
      }
    }
  }

  #startHelloDeadline(ws: WebSocket): void {
    this.#stopHelloDeadline();
    this.#helloTimer = setTimeout(() => {
      if (this.#socket !== ws || this.#negotiatedSocket === ws) return;
      this.#logger.warn("relay did not complete hello before its deadline");
      ws.close(1008, "relay hello timed out");
    }, this.#helloTimeoutMs);
    this.#helloTimer.unref?.();
  }

  #stopHelloDeadline(): void {
    if (this.#helloTimer) clearTimeout(this.#helloTimer);
    this.#helloTimer = undefined;
  }

  #startPinging(): void {
    this.#stopPinging();
    this.#pingTimer = setInterval(() => {
      const socket = this.#socket;
      if (!socket) return;
      if (!this.#alive) {
        this.#logger.warn("relay missed two pings; dropping it");
        socket.terminate();
        return;
      }
      this.#alive = false;
      try {
        socket.ping();
      } catch {
        // A socket that cannot be pinged is about to emit `close` anyway.
      }
    }, this.#pingIntervalMs);
    this.#pingTimer.unref?.();
  }

  #stopPinging(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
  }

  #failPending(message: string): void {
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
      entry.settle(disconnectedReply(entry.op, message));
    }
  }

  /** Stop accepting, hang up on the extension, and fail anything in flight. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#closeNow();
    return this.#closePromise;
  }

  async #closeNow(): Promise<void> {
    this.#closed = true;
    this.#stopHelloDeadline();
    this.#stopPinging();
    this.#failPending("The daemon is shutting down.");
    const socket = this.#socket;
    this.#negotiatedSocket = undefined;
    this.#peer = undefined;
    this.#since = undefined;
    await Promise.allSettled(
      [...this.#clients].map((client) => closeRelaySocket(client, this.#closeTimeoutMs)),
    );
    this.#clients.clear();
    if (this.#socket === socket) this.#socket = undefined;

    const serverClosed = new Promise<void>((resolve) => {
      try {
        this.#wss.close(() => resolve());
      } catch {
        resolve();
      }
    });
    await settlesWithin(serverClosed, this.#closeTimeoutMs);
  }
}

/** Give one upgraded relay peer a bounded close handshake, then force it down. */
export async function closeRelaySocket(
  socket: {
    readonly readyState: number;
    readonly CLOSED: number;
    once(event: "close", listener: () => void): unknown;
    close(code: number, reason: string): void;
    terminate(): void;
  },
  timeoutMs: number,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    if (socket.readyState === socket.CLOSED) resolve();
    else socket.once("close", () => resolve());
  });
  try {
    socket.close(RELAY_CLOSE_GOING_AWAY, "ghostd is shutting down");
  } catch {
    try {
      socket.terminate();
    } catch {
      return;
    }
  }
  if (await settlesWithin(closed, timeoutMs)) return;
  try {
    socket.terminate();
  } catch {
    // The socket may have closed between the deadline and this call.
  }
  await settlesWithin(closed, timeoutMs);
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(() => finish(true), () => finish(true));
  });
}

function refuse(socket: Duplex, status: number, reason: string): void {
  const text = `${reason}\n`;
  const statusText = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    500: "Internal Server Error",
    503: "Service Unavailable",
  }[status] ?? "Bad Request";
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n`
    + "content-type: text/plain; charset=utf-8\r\n"
    + `content-length: ${Buffer.byteLength(text)}\r\n`
    + "connection: close\r\n"
    + `\r\n${text}`,
  );
  socket.destroy();
}

/**
 * Attach a hub to a running HTTP server. Kept separate from `RelayHub` so a test
 * can drive the hub with no server at all, and so `server.ts` owns exactly one
 * line of wiring.
 */
export function attachRelay(server: Server, hub: RelayHub): void {
  server.on("upgrade", (request, socket, head) => {
    hub.handleUpgrade(request, socket as Duplex, head);
  });
}

/**
 * The default hub, unless `GHOSTD_RELAY` says otherwise. Returning `undefined`
 * rather than a disabled hub means the upgrade path and the status route both
 * degrade to a plain "not enabled" without a mode flag threaded through them.
 */
export function createRelayHub(
  options: RelayHubOptions & { env?: NodeJS.ProcessEnv } = {},
): RelayHub | undefined {
  const raw = (options.env ?? process.env).GHOSTD_RELAY?.trim().toLowerCase();
  if (raw && ["0", "off", "false", "no"].includes(raw)) return undefined;
  return new RelayHub(options);
}
