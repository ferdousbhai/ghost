/**
 * The relay backend: the ghost drives the owner's **real, signed-in Chromium**.
 *
 * This backend owns nothing. An MV3 extension
 * living in the owner's Chromium dials *out* to ghostd over a localhost
 * WebSocket, and every verb in `GhostBrowserBackend` becomes one request frame on
 * that socket. There is no profile to lock, no process to launch, and — the point
 * of the whole exercise — the pages the ghost sees are the pages the owner is
 * already logged into.
 *
 * The relay protocol reports page URLs but neither the connected peer address
 * nor a cancel operation. The session therefore validates DNS before a request
 * and validates every returned page URL, while prompt cancellation stops local
 * waiting. It cannot peer-pin Chromium's already-delivered request or undo an
 * operation that the extension has begun; callers must not claim otherwise.
 *
 * Three things shape this file.
 *
 * **The transport is injected, and it is a two-line interface.** `packages/extensions`
 * must not learn what a daemon is; it takes a `RelayTransport` at construction and
 * the daemon adapts its WebSocket client to that shape. So this module has no
 * `ws` import, no socket lifecycle, and is testable against a scripted transport.
 *
 * **The transport does not throw for browser failures.** A page that would not
 * load is not an exception in the transport, it is a `{ ok: false, failure }`
 * reply — the `BrowserFailure` vocabulary the seam is written in. That
 * keeps error translation in one place (here) instead of smeared across a socket,
 * and it means "the extension disconnected mid-request" is expressible in the same
 * channel as "that element is gone".
 *
 * **Refs are a stamped attribute, not a CDP node id.** `backendNodeId` is the
 * obvious choice and the wrong one: it is scoped to a live `DOM.enable` session,
 * it is invalidated by any navigation, and it obliges the extension to hold a
 * debugger attachment open between tool calls just to keep `e3` meaningful. The
 * extension instead stamps `data-ghost-ref="e3"` on each match, so a ref *is* a
 * selector: it survives as long as the node does and needs no attachment at all
 * until the moment something is clicked. Minting refs is the backend's business,
 * which is what lets `browser-session.ts` own the bookkeeping above it.
 *
 * Provenance: the relay shape (extension dials out over WebSocket, semantic verbs
 * rather than a remote `eval`, CDP only for input) is ported from the MIT-licensed
 * `browser-relay` package in https://github.com/can1357/oh-my-pi. No code is
 * vendored; that server half is Bun-only and its tool layer is a different seam.
 */
import { randomUUID } from "node:crypto";
import {
  assertScreenshotBase64WithinLimit,
  assertScreenshotBytesWithinLimit,
} from "./screenshot-retention.js";
import {
  GhostBrowserError,
  identifiedBrowserBackendFactory,
  withAbort,
  type BackendActionOptions,
  type BackendBackResult,
  type BackendDragInput,
  type BackendJavascriptResult,
  type BackendKeyInput,
  type BackendReadResult,
  type BackendResizeInput,
  type BackendResizeResult,
  type BackendScreenshotOptions,
  type BackendScreenshotResult,
  type BackendScrollInput,
  type BackendTabInfo,
  type BackendTabsInput,
  type BackendTabsResult,
  type BackendTarget,
  type BackendTypeInput,
  type BackendUploadInput,
  type BrowserBackendContext,
  type BrowserBackendFactory,
  type BrowserFailure,
  type ConsoleEntry,
  type GhostBrowserBackend,
  type NetworkEntry,
  type PageElementMatch,
  type PageSummary,
} from "./browser-backend.js";

/**
 * Bumped when a frame shape changes incompatibly. The extension sends its version
 * in `hello`; a daemon that does not recognize it refuses the connection rather
 * than guessing, because a half-understood relay drives someone's real browser.
 */
export const RELAY_PROTOCOL_VERSION = 2;

/** The negotiated WebSocket subprotocol. */
export const RELAY_SUBPROTOCOL = "ghost-relay.v1";

/** Prefix for the pairing token when it rides in `Sec-WebSocket-Protocol`. */
export const RELAY_TOKEN_SUBPROTOCOL_PREFIX = "ghost-token.";

export const RELAY_PATH = "/relay";

/**
 * Every operation the relay understands — a closed enum, kept in lockstep with the
 * extension's `OPS` (`chromium-extension/extension/protocol.js`) and its handlers
 * (`ops.js`) by `packages/daemon/test/relay-extension.test.ts`.
 *
 * The set includes `javascript`, which runs page script through CDP
 * `Runtime.evaluate`. That is a real capability, granted to the owner's ghost
 * on the owner's machine, and the page and the value it returns are untrusted data, which
 * the tool description says out loud. There is deliberately no way for the daemon
 * to smuggle script through any *other* op: each verb is implemented by the
 * extension itself, and only `javascript` carries a code string.
 */
export const RELAY_OPS = [
  "status",
  "current",
  "open",
  "read",
  "find",
  "click",
  "type",
  "screenshot",
  "back",
  "close",
  "forward",
  "scroll",
  "drag",
  "key",
  "javascript",
  "console",
  "network",
  "upload",
  "resize",
  "tabs",
] as const;

export type RelayOp = (typeof RELAY_OPS)[number];

/**
 * What a request came back with. Browser-level failures are *values*, not thrown
 * errors, so the socket layer never has to invent an error class and this file
 * stays the only place that decides what a failure means to the model.
 */
export type RelayReply =
  | { readonly ok: true; readonly result: unknown }
  | {
    readonly ok: false;
    readonly failure: BrowserFailure;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };

export interface RelayRequestOptions {
  readonly timeoutMs: number;
  /**
   * The transport should cancel its pending request when it can. The protocol has
   * no cancel frame, so an already-delivered browser operation may still finish
   * remotely after the caller has stopped waiting.
   */
  readonly signal?: AbortSignal;
}

/**
 * The daemon's WebSocket client, reduced to what a backend needs. Keeping this to
 * three members is what keeps `packages/extensions` free of the daemon.
 */
export interface RelayTransport {
  /** Whether an extension is connected right now. Must be synchronous and cheap. */
  readonly connected: boolean;
  /** Who is on the other end, for messages: `Chromium 141 on ghost-tab 42`. */
  readonly peer: string | undefined;
  /** Browser replies, including failures, resolve; local caller cancellation rejects. */
  request(
    op: RelayOp,
    args: Readonly<Record<string, unknown>>,
    options: RelayRequestOptions,
  ): Promise<RelayReply>;
}

export const RELAY_OFF_MESSAGE =
  "This daemon is running with its browser relay switched off (GHOSTD_RELAY), "
  + "so there is no browser to drive and no endpoint an extension could pair "
  + "with. Installing the extension will not help: the owner has to restart "
  + "ghostd without GHOSTD_RELAY=off.";

export const RELAY_DISCONNECTED_MESSAGE =
  "The browser relay is not connected, so the owner's Chromium cannot be "
  + "driven. Ask them to open Chromium with the Ghost relay extension installed "
  + "and paired (the extension's popup shows the connection status). If no "
  + "Chromium is running you may start one yourself, but detach it from the "
  + "daemon's service unit or restarting ghostd will kill it and every tab in "
  + "it: `systemd-run --user --scope -- chromium`.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Map an array of wire records, dropping anything that is not an object or that
 * the reader rejects (by returning undefined). Non-arrays read as empty.
 */
function mapRecords<T>(
  value: unknown,
  read: (raw: Record<string, unknown>) => T | undefined,
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const entry = read(raw);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

function malformed(op: RelayOp, detail: string): never {
  throw new GhostBrowserError(
    "browser_unavailable",
    `The browser relay answered ${op} with something unusable: ${detail}. The `
    + "extension and the daemon may be different versions.",
    { op },
  );
}

function readPage(op: RelayOp, value: unknown): PageSummary {
  if (!isRecord(value)) malformed(op, "no page");
  const url = value["url"];
  if (typeof url !== "string") malformed(op, "the page has no url");
  return { url, title: readString(value["title"], "") };
}

function readMatch(op: RelayOp, value: unknown, index: number): PageElementMatch {
  if (!isRecord(value)) malformed(op, `match ${index} is not an object`);
  const ref = value["ref"];
  if (typeof ref !== "string" || ref === "") malformed(op, `match ${index} has no ref`);
  const role = readNonEmpty(value["role"]);
  const name = readNonEmpty(value["name"]);
  const href = readNonEmpty(value["href"]);
  const fieldValue = readNonEmpty(value["value"]);
  return {
    ref,
    tag: readString(value["tag"], ""),
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(href === undefined ? {} : { href }),
    ...(fieldValue === undefined ? {} : { value: fieldValue }),
    text: readString(value["text"], ""),
    visible: value["visible"] !== false,
    disabled: value["disabled"] === true,
  };
}

function readConsoleEntries(value: unknown): readonly ConsoleEntry[] {
  return mapRecords(value, (raw) => {
    const url = readNonEmpty(raw["url"]);
    const line = readNumber(raw["line"]);
    return {
      level: readString(raw["level"], "log"),
      text: readString(raw["text"], ""),
      ...(url === undefined ? {} : { url }),
      ...(line === undefined ? {} : { line }),
    };
  });
}

function readNetworkEntries(value: unknown): readonly NetworkEntry[] {
  return mapRecords(value, (raw) => {
    const status = readNumber(raw["status"]);
    const type = readNonEmpty(raw["type"]);
    const bodyBytes = readNumber(raw["bodyBytes"]);
    return {
      method: readString(raw["method"], "GET"),
      url: readString(raw["url"], ""),
      ...(status === undefined ? {} : { status }),
      ...(type === undefined ? {} : { type }),
      ...(bodyBytes === undefined ? {} : { bodyBytes }),
    };
  });
}

function readTabInfos(value: unknown): readonly BackendTabInfo[] {
  return mapRecords(value, (raw) => {
    const id = readNonEmpty(raw["id"]);
    if (id === undefined) return undefined;
    return {
      id,
      url: readString(raw["url"], ""),
      title: readString(raw["title"], ""),
      active: raw["active"] === true,
    };
  });
}

export interface RelayBackendOptions {
  /**
   * Absent when the daemon has no relay hub (`GHOSTD_RELAY=off`). There is one
   * browser and it is reached through the extension, so "no relay" is "no
   * browser": the tool still exists and every call says why, rather than
   * disappearing from under a conversation that was using it.
   */
  readonly transport?: RelayTransport;
}

export class RelayBrowserBackend implements GhostBrowserBackend {
  readonly name = "relay";

  readonly #transport: RelayTransport | undefined;
  /**
   * Who this backend is, for the extension. One extension serves every ghost and
   * conversation over a single socket, so the session id is what makes a tab
   * *belong* to someone: the extension answers `tabs` with this session's tabs
   * alone, refuses a switch or close aimed at another's, and on `close` sweeps
   * every tab this session opened rather than only the one it last drove.
   */
  readonly #session = randomUUID();
  /**
   * The tab this session is driving now. `#call` puts it on every op so the
   * extension can keep that tab's attach state and isolated world apart from
   * every other session's. Undefined until the first `open`; the extension
   * remains the authority and corrects it on every reply.
   */
  #tabId: string | undefined;

  constructor(options: RelayBackendOptions) {
    this.#transport = options.transport;
  }

  get running(): boolean {
    return this.#transport?.connected === true && this.#tabId !== undefined;
  }

  async #call(
    op: RelayOp,
    args: Readonly<Record<string, unknown>>,
    options: BackendActionOptions,
  ): Promise<Record<string, unknown>> {
    const transport = this.#transport;
    if (!transport?.connected) {
      this.#tabId = undefined;
      throw new GhostBrowserError(
        "browser_unavailable",
        transport === undefined ? RELAY_OFF_MESSAGE : RELAY_DISCONNECTED_MESSAGE,
        { op },
      );
    }
    const reply = await withAbort(
      transport.request(op, {
        ...args,
        session: this.#session,
        ...(this.#tabId === undefined ? {} : { tab: this.#tabId }),
      }, {
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      `${op} through the browser relay`,
      options.signal,
    );
    if (!reply.ok) {
      // The extension telling us the tab is gone is the one failure that also
      // changes our own state: there is nothing to act on until the next `open`.
      if (reply.failure === "no_page" || reply.failure === "browser_unavailable") {
        this.#tabId = undefined;
      }
      throw new GhostBrowserError(reply.failure, reply.message, {
        op,
        ...(reply.details ?? {}),
      });
    }
    if (!isRecord(reply.result)) malformed(op, "the result is not an object");
    return reply.result;
  }

  async current(options: BackendActionOptions = { timeoutMs: 5_000 }): Promise<PageSummary | undefined> {
    // Cheap and non-committal when no tab has ever been opened: do not start or
    // contact anything merely to confirm absence. Once a tab is believed to
    // exist, however, a disconnected relay is a real failure and #call reports it.
    if (this.#tabId === undefined) return undefined;
    const result = await this.#call("current", {}, options);
    const page = result["page"];
    if (page === null || page === undefined) {
      this.#tabId = undefined;
      return undefined;
    }
    return readPage("current", page);
  }

  async open(url: string, options: BackendActionOptions): Promise<PageSummary> {
    const result = await this.#call("open", { url }, options);
    // The extension names the tab it opened. Every later op rides on that id, so
    // a reply without one is malformed rather than something to paper over.
    const id = result["id"];
    if (typeof id !== "string" || id === "") malformed("open", "no tab id");
    this.#tabId = id;
    return readPage("open", result["page"]);
  }

  async read(options: BackendActionOptions): Promise<BackendReadResult> {
    const result = await this.#call("read", {}, options);
    const page = readPage("read", result["page"]);
    return { ...page, text: readString(result["text"], "") };
  }

  async find(
    query: string,
    options: BackendActionOptions & { readonly limit: number },
  ): Promise<readonly PageElementMatch[]> {
    const result = await this.#call("find", { query, limit: options.limit }, options);
    const matches = result["matches"];
    if (!Array.isArray(matches)) malformed("find", "matches is not an array");
    return matches
      .slice(0, options.limit)
      .map((match, index) => readMatch("find", match, index));
  }

  async click(target: BackendTarget, options: BackendActionOptions): Promise<PageSummary> {
    const result = await this.#call("click", targetArgs(target), options);
    return readPage("click", result["page"]);
  }

  async type(input: BackendTypeInput, options: BackendActionOptions): Promise<PageSummary> {
    const result = await this.#call(
      "type",
      { ...targetArgs(input), text: input.text, submit: input.submit === true },
      options,
    );
    return readPage("type", result["page"]);
  }

  async screenshot(options: BackendScreenshotOptions): Promise<BackendScreenshotResult> {
    const result = await this.#call("screenshot", { fullPage: options.fullPage }, options);
    const png = result["png"];
    if (typeof png !== "string" || png === "") malformed("screenshot", "no image came back");
    assertScreenshotBase64WithinLimit(png, "Browser relay screenshot");
    const bytes = Buffer.from(png, "base64");
    assertScreenshotBytesWithinLimit(bytes.byteLength, "Browser relay screenshot");
    return { ...readPage("screenshot", result["page"]), bytes };
  }

  async back(options: BackendActionOptions): Promise<BackendBackResult> {
    const result = await this.#call("back", {}, options);
    return { ...readPage("back", result["page"]), moved: result["moved"] === true };
  }

  async forward(options: BackendActionOptions): Promise<BackendBackResult> {
    const result = await this.#call("forward", {}, options);
    return { ...readPage("forward", result["page"]), moved: result["moved"] === true };
  }

  async scroll(input: BackendScrollInput, options: BackendActionOptions): Promise<PageSummary> {
    const result = await this.#call(
      "scroll",
      {
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        ...(input.x === undefined ? {} : { x: input.x }),
        ...(input.y === undefined ? {} : { y: input.y }),
      },
      options,
    );
    return readPage("scroll", result["page"]);
  }

  async drag(input: BackendDragInput, options: BackendActionOptions): Promise<PageSummary> {
    const result = await this.#call(
      "drag",
      {
        fromX: input.fromX,
        fromY: input.fromY,
        toX: input.toX,
        toY: input.toY,
        ...(input.steps === undefined ? {} : { steps: input.steps }),
      },
      options,
    );
    return readPage("drag", result["page"]);
  }

  async key(input: BackendKeyInput, options: BackendActionOptions): Promise<PageSummary> {
    const result = await this.#call(
      "key",
      {
        key: input.key,
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] }),
        ...(input.text === undefined ? {} : { text: input.text }),
      },
      options,
    );
    return readPage("key", result["page"]);
  }

  async javascript(
    code: string,
    options: BackendActionOptions,
  ): Promise<BackendJavascriptResult> {
    const result = await this.#call("javascript", { code }, options);
    return {
      value: result["value"],
      type: readString(result["type"], typeof result["value"]),
    };
  }

  async readConsole(options: BackendActionOptions): Promise<readonly ConsoleEntry[]> {
    const result = await this.#call("console", {}, options);
    return readConsoleEntries(result["entries"]);
  }

  async readNetwork(options: BackendActionOptions): Promise<readonly NetworkEntry[]> {
    const result = await this.#call("network", {}, options);
    return readNetworkEntries(result["entries"]);
  }

  async upload(input: BackendUploadInput, options: BackendActionOptions): Promise<PageSummary> {
    const result = await this.#call(
      "upload",
      { ...targetArgs(input), paths: [...input.paths] },
      options,
    );
    return readPage("upload", result["page"]);
  }

  async resize(
    input: BackendResizeInput,
    options: BackendActionOptions,
  ): Promise<BackendResizeResult> {
    const result = await this.#call(
      "resize",
      { width: input.width, height: input.height },
      options,
    );
    return { ...readPage("resize", result["page"]), applied: result["applied"] !== false };
  }

  async tabs(input: BackendTabsInput, options: BackendActionOptions): Promise<BackendTabsResult> {
    const result = await this.#call(
      "tabs",
      {
        op: input.op,
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.url === undefined ? {} : { url: input.url }),
      },
      options,
    );
    const tabs = readTabInfos(result["tabs"]);
    // The extension is authoritative on which tab this session now drives:
    // `active` is answered for this caller alone, so follow it across
    // create/switch/close rather than trusting the local value.
    // `readNonEmpty`, not a bare string check: an empty `active` would otherwise
    // become this session's tab id and ride on every later call.
    const active = readNonEmpty(result["active"]) ?? null;
    this.#tabId = active ?? undefined;
    const id = readNonEmpty(result["id"]);
    const page = result["page"];
    return {
      tabs,
      active,
      ...(id === undefined ? {} : { id }),
      ...(page === null || page === undefined ? {} : { page: readPage("tabs", page) }),
    };
  }

  /**
   * Close this session's tab and let the extension drop its debugger attachment.
   * Other conversations keep their own tabs, and the *browser* is emphatically
   * not closed — it is the owner's, with the rest of their day open in it.
   */
  async close(options: BackendActionOptions = { timeoutMs: 10_000 }): Promise<boolean> {
    if (this.#tabId === undefined) return false;
    const result = await this.#call("close", {}, options);
    // The extension closed every tab this session opened, not just #tabId.
    const closed = result["closed"];
    if (typeof closed !== "boolean") malformed("close", "closed is not a boolean");
    this.#tabId = undefined;
    return closed;
  }
}

function targetArgs(target: BackendTarget): Record<string, unknown> {
  const ref = target.ref?.trim();
  if (ref) return { ref };
  const selector = target.selector?.trim();
  if (selector) return { selector };
  throw new GhostBrowserError("invalid_input", "No ref or selector was given.");
}

/** The relay backend factory, for `createBrowserExtension({ backend })`. */
export function relayBackend(options: RelayBackendOptions): BrowserBackendFactory {
  return identifiedBrowserBackendFactory(
    (_ctx: BrowserBackendContext) => new RelayBrowserBackend(options),
    "relay",
    ["relay", options.transport],
  );
}
