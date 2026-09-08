import {
  RELAY_OPS,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
  RELAY_PAIR_SUBPROTOCOL_PREFIX,
  RELAY_PAIR_CODE_PATTERN,
  RELAY_PATH,
  type RelayOp,
} from "@ghost/extensions";
import type { IncomingHttpHeaders } from "node:http";
import { relayTokenMatches } from "./relay-token.js";

export {
  RELAY_OPS,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
  RELAY_PAIR_SUBPROTOCOL_PREFIX,
  RELAY_PAIR_CODE_PATTERN,
  type RelayOp,
};

const OP_SET = new Set<string>(RELAY_OPS);

export function isRelayOp(value: unknown): value is RelayOp {
  return typeof value === "string" && OP_SET.has(value);
}


export interface RelayHelloFrame {
  readonly t: "hello";
  readonly protocol: number;
  readonly agent?: string;
  readonly browser?: string;
}

export interface RelayResponseOk {
  readonly t: "res";
  readonly id: number;
  readonly ok: true;
  readonly result: unknown;
}

export interface RelayResponseError {
  readonly t: "res";
  readonly id: number;
  readonly ok: false;
  readonly error: {
    readonly failure: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export interface RelayEventFrame {
  readonly t: "event";
  readonly event: string;
  readonly data?: Record<string, unknown>;
}

export type RelayClientFrame =
  | RelayHelloFrame
  | RelayResponseOk
  | RelayResponseError
  | RelayEventFrame;

export interface RelayWelcomeFrame {
  readonly t: "welcome";
  readonly protocol: number;
  readonly daemon: string;
  readonly incarnation: string;
}

export interface RelayRequestFrame {
  readonly t: "req";
  readonly id: number;
  readonly op: RelayOp;
  readonly args: Record<string, unknown>;
  readonly timeoutMs: number;
}

/**
 * Sent once, to a pairing socket, when the owner allows its code. The token is
 * the same one `ghostd relay-token` prints; the extension stores it and redials
 * as a paired client.
 */
export interface RelayPairedFrame {
  readonly t: "paired";
  readonly token: string;
}

export type RelayServerFrame = RelayWelcomeFrame | RelayRequestFrame | RelayPairedFrame;

export type ParsedClientFrame =
  | { readonly ok: true; readonly frame: RelayClientFrame }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one text frame from the extension. Frame size is bounded upstream by
 * the ws transport's maxPayload, so no size check happens here.
 *
 * Every rejection is a *reason string* rather than a throw: the caller's only
 * sane response is to log it and drop the frame, and a socket that throws its way
 * out of a message handler takes the connection with it.
 */
export function parseClientFrame(raw: string): ParsedClientFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "not a JSON object" };

  switch (parsed.t) {
    case "hello": {
      const protocol = parsed.protocol;
      if (typeof protocol !== "number" || !Number.isInteger(protocol)) {
        return { ok: false, reason: "hello has no integer protocol" };
      }
      const agent = parsed.agent;
      const browser = parsed.browser;
      return {
        ok: true,
        frame: {
          t: "hello",
          protocol,
          ...(typeof agent === "string" ? { agent: agent.slice(0, 200) } : {}),
          ...(typeof browser === "string" ? { browser: browser.slice(0, 200) } : {}),
        },
      };
    }
    case "res": {
      const id = parsed.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        return { ok: false, reason: "res has no integer id" };
      }
      if (parsed.ok === true) {
        return { ok: true, frame: { t: "res", id, ok: true, result: parsed.result } };
      }
      const error = parsed.error;
      if (!isRecord(error) || typeof error.message !== "string") {
        return { ok: false, reason: "res is a failure with no error.message" };
      }
      const failure = error.failure;
      const details = error.details;
      return {
        ok: true,
        frame: {
          t: "res",
          id,
          ok: false,
          error: {
            failure: typeof failure === "string" ? failure : "navigation_failed",
            message: error.message,
            ...(isRecord(details) ? { details } : {}),
          },
        },
      };
    }
    case "event": {
      const event = parsed.event;
      if (typeof event !== "string" || event === "") {
        return { ok: false, reason: "event has no name" };
      }
      const data = parsed.data;
      return {
        ok: true,
        frame: { t: "event", event, ...(isRecord(data) ? { data } : {}) },
      };
    }
    default:
      return { ok: false, reason: `unknown frame type ${JSON.stringify(parsed.t)}` };
  }
}

export function encodeServerFrame(frame: RelayServerFrame): string {
  return JSON.stringify(frame);
}


export interface RelayUpgradeRequest {
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly remoteAddress: string | undefined;
}

export type RelayUpgradeDecision =
  /** A paired client; `pairing` is the code of an unpaired one asking to be. */
  | { readonly ok: true; readonly subprotocol: string; readonly pairing?: string }
  | { readonly ok: false; readonly status: number; readonly reason: string };

export const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Whether the origin may open a relay socket at all.
 *
 * A browser will not let a page set arbitrary WebSocket headers, but it *will*
 * happily connect to loopback from any site — the classic cross-site WebSocket
 * hijack. Three gates, in order of how much they cost an attacker: the socket
 * must come from loopback, the `Origin` must be a browser extension (or absent,
 * which is a non-browser client like the CLI or a test), and the token must
 * match. The origin check alone stops `https://evil.example` outright, and the
 * token stops everything else, including another extension.
 */
export function authorizeRelayUpgrade(
  request: RelayUpgradeRequest,
  expectedToken: string,
): RelayUpgradeDecision {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path !== RELAY_PATH) {
    return { ok: false, status: 404, reason: "Not a relay endpoint." };
  }
  const remote = request.remoteAddress;
  if (remote === undefined || !LOOPBACK_ADDRESSES.has(remote)) {
    return { ok: false, status: 403, reason: "The relay accepts loopback connections only." };
  }

  const origin = request.headers.origin;
  if (typeof origin === "string" && origin !== "" && origin !== "null") {
    if (!origin.startsWith("chrome-extension://")) {
      return {
        ok: false,
        status: 403,
        reason: "Only a browser extension may open the relay, not a web page.",
      };
    }
  }

  const offered = parseSubprotocols(request.headers["sec-websocket-protocol"]);
  if (offered.length > 0 && !offered.includes(RELAY_SUBPROTOCOL)) {
    return {
      ok: false,
      status: 400,
      reason: `The relay speaks ${RELAY_SUBPROTOCOL}; the client offered ${offered.join(", ")}.`,
    };
  }

  const presented = tokenFrom(request, offered);
  if (presented === undefined) {
    const code = pairingCodeFrom(offered);
    if (code === undefined) {
      return { ok: false, status: 401, reason: "No pairing token or code. Pair the extension first." };
    }
    if (!RELAY_PAIR_CODE_PATTERN.test(code)) {
      return { ok: false, status: 400, reason: "A pairing code is six digits." };
    }
    return { ok: true, subprotocol: RELAY_SUBPROTOCOL, pairing: code };
  }
  if (!relayTokenMatches(expectedToken, presented)) {
    return {
      ok: false,
      status: 401,
      reason: "That pairing token is not this daemon's. Clear it in the extension popup and pair again.",
    };
  }
  return { ok: true, subprotocol: RELAY_SUBPROTOCOL };
}

function pairingCodeFrom(offered: readonly string[]): string | undefined {
  for (const protocol of offered) {
    if (protocol.startsWith(RELAY_PAIR_SUBPROTOCOL_PREFIX)) {
      return protocol.slice(RELAY_PAIR_SUBPROTOCOL_PREFIX.length).trim();
    }
  }
  return undefined;
}

function parseSubprotocols(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return [];
  return raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * The token, from wherever it can honestly arrive.
 *
 * The browser `WebSocket` constructor cannot set headers, so the extension smuggles
 * the token through the one field it *can* set: the subprotocol list. Query strings
 * are accepted too, for the CLI and for tests, and are the reason the daemon never
 * logs a relay URL.
 */
function tokenFrom(request: RelayUpgradeRequest, offered: readonly string[]): string | undefined {
  for (const protocol of offered) {
    if (protocol.startsWith(RELAY_TOKEN_SUBPROTOCOL_PREFIX)) {
      const token = protocol.slice(RELAY_TOKEN_SUBPROTOCOL_PREFIX.length).trim();
      if (token !== "") return token;
    }
  }
  const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token");
  if (query !== null && query.trim() !== "") return query.trim();
  const header = request.headers["x-ghost-relay-token"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}
