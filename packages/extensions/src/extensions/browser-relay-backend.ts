/**
 * The relay backend: the ghost drives the creator's **real, signed-in Chromium**.
 *
 * The Playwright backend owns a browser. This one owns nothing. An MV3 extension
 * living in the creator's own Chromium dials *out* to ghostd over a localhost
 * WebSocket, and every verb in `GhostBrowserBackend` becomes one request frame on
 * that socket. There is no profile to lock, no process to launch, and — the point
 * of the whole exercise — the pages the ghost sees are the pages the creator is
 * already logged into.
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
 * reply — the same `BrowserFailure` vocabulary the Playwright backend raises. That
 * keeps error translation in one place (here) instead of smeared across a socket,
 * and it means "the extension disconnected mid-request" is expressible in the same
 * channel as "that element is gone".
 *
 * **Refs are a stamped attribute, not a CDP node id.** `backendNodeId` is the
 * obvious choice and the wrong one: it is scoped to a live `DOM.enable` session,
 * it is invalidated by any navigation, and it obliges the extension to hold a
 * debugger attachment open between tool calls just to keep `e3` meaningful. The
 * extension instead stamps `data-ghost-ref="e3"` exactly as the Playwright backend
 * does, so a ref *is* a selector, survives as long as the node does, and needs no
 * attachment at all until the moment something is clicked. Both backends therefore
 * mint refs with the same meaning, which is what lets `browser-session.ts` do the
 * bookkeeping for both.
 *
 * Provenance: the relay shape (extension dials out over WebSocket, semantic verbs
 * rather than a remote `eval`, CDP only for input) is ported from the MIT-licensed
 * `browser-relay` package in https://github.com/can1357/oh-my-pi. No code is
 * vendored; that server half is Bun-only and its tool layer is a different seam.
 */
import { writeFile } from "node:fs/promises";
import { isVisitorScope, type GhostScope } from "../scope.js";
import {
  GhostBrowserError,
  identifiedBrowserBackendFactory,
  type BackendActionOptions,
  type BackendBackResult,
  type BackendDragInput,
  type BackendJavascriptResult,
  type BackendKeyInput,
  type BackendReadResult,
  type BackendResizeInput,
  type BackendResizeResult,
  type BackendScreenshotOptions,
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
export const RELAY_PROTOCOL_VERSION = 1;

/** The negotiated WebSocket subprotocol. */
export const RELAY_SUBPROTOCOL = "ghost-relay.v1";

/** Prefix for the pairing token when it rides in `Sec-WebSocket-Protocol`. */
export const RELAY_TOKEN_SUBPROTOCOL_PREFIX = "ghost-token.";

/** The daemon path the extension dials. */
export const RELAY_PATH = "/relay";

/**
 * Every operation the relay understands — a closed enum, kept in lockstep with the
 * extension's `OPS` (`chromium-extension/extension/protocol.js`) and its handlers
 * (`ops.js`) by `packages/daemon/test/relay-extension.test.ts`.
 *
 * The set includes `javascript`, which runs page script through CDP
 * `Runtime.evaluate`. That is a real capability, granted to the *creator's own*
 * ghost on the creator's own machine — never to a visitor (the four scope locks
 * still hold) — and the page and the value it returns are untrusted data, which
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
  /** One request, one reply. Resolves even for failures; see `RelayReply`. */
  request(
    op: RelayOp,
    args: Readonly<Record<string, unknown>>,
    options: RelayRequestOptions,
  ): Promise<RelayReply>;
}

export const RELAY_DISCONNECTED_MESSAGE =
  "The browser relay is not connected, so the creator's own Chromium cannot be "
  + "driven. Ask them to open Chromium with the Ghost relay extension installed "
  + "and paired (the extension's popup shows the connection status).";

const RELAY_VISITOR_REFUSAL =
  "The relay browser backend drives the creator's own signed-in Chromium and is "
  + "never available in a visitor conversation.";

// ---------------------------------------------------------------- reply parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const title = value["title"];
  if (typeof url !== "string") malformed(op, "the page has no url");
  return { url, title: typeof title === "string" ? title : "" };
}

function readMatch(op: RelayOp, value: unknown, index: number): PageElementMatch {
  if (!isRecord(value)) malformed(op, `match ${index} is not an object`);
  const ref = value["ref"];
  const tag = value["tag"];
  if (typeof ref !== "string" || ref === "") malformed(op, `match ${index} has no ref`);
  const optional = (key: string): string | undefined => {
    const raw = value[key];
    return typeof raw === "string" && raw !== "" ? raw : undefined;
  };
  const role = optional("role");
  const name = optional("name");
  const href = optional("href");
  const fieldValue = optional("value");
  return {
    ref,
    tag: typeof tag === "string" ? tag : "",
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(href === undefined ? {} : { href }),
    ...(fieldValue === undefined ? {} : { value: fieldValue }),
    text: typeof value["text"] === "string" ? (value["text"] as string) : "",
    visible: value["visible"] !== false,
    disabled: value["disabled"] === true,
  };
}

function readConsoleEntries(value: unknown): readonly ConsoleEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ConsoleEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const level = typeof raw["level"] === "string" ? (raw["level"] as string) : "log";
    const text = typeof raw["text"] === "string" ? (raw["text"] as string) : "";
    const url = typeof raw["url"] === "string" && raw["url"] !== "" ? (raw["url"] as string) : undefined;
    const line = typeof raw["line"] === "number" ? (raw["line"] as number) : undefined;
    out.push({
      level,
      text,
      ...(url === undefined ? {} : { url }),
      ...(line === undefined ? {} : { line }),
    });
  }
  return out;
}

function readNetworkEntries(value: unknown): readonly NetworkEntry[] {
  if (!Array.isArray(value)) return [];
  const out: NetworkEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const method = typeof raw["method"] === "string" ? (raw["method"] as string) : "GET";
    const url = typeof raw["url"] === "string" ? (raw["url"] as string) : "";
    const status = typeof raw["status"] === "number" ? (raw["status"] as number) : undefined;
    const type = typeof raw["type"] === "string" && raw["type"] !== "" ? (raw["type"] as string) : undefined;
    const bodyBytes = typeof raw["bodyBytes"] === "number" ? (raw["bodyBytes"] as number) : undefined;
    out.push({
      method,
      url,
      ...(status === undefined ? {} : { status }),
      ...(type === undefined ? {} : { type }),
      ...(bodyBytes === undefined ? {} : { bodyBytes }),
    });
  }
  return out;
}

function readTabInfos(value: unknown): readonly BackendTabInfo[] {
  if (!Array.isArray(value)) return [];
  const out: BackendTabInfo[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = raw["id"];
    if (typeof id !== "string" || id === "") continue;
    out.push({
      id,
      url: typeof raw["url"] === "string" ? (raw["url"] as string) : "",
      title: typeof raw["title"] === "string" ? (raw["title"] as string) : "",
      active: raw["active"] === true,
    });
  }
  return out;
}

// ------------------------------------------------------------------ the backend

export interface RelayBackendOptions {
  /** The daemon's socket, adapted. */
  readonly transport: RelayTransport;
  /**
   * Whose session this is. A visitor scope makes construction itself throw — the
   * fourth lock, below the tool, the gate, and the handler check in `browser.ts`.
   */
  readonly scope?: GhostScope;
}

export class RelayBrowserBackend implements GhostBrowserBackend {
  readonly name = "relay";
  /** A relay drives a window the creator can see. There is nothing to hide. */
  readonly headless = false;

  readonly #transport: RelayTransport;
  /**
   * The ids of the tabs the extension is holding for this ghost. A set, not a
   * boolean: the one-tab invariant is relaxed, so the ghost may own several. It
   * stays a cheap local mirror — enough to answer `current`/`running` without a
   * round-trip when nothing was ever opened — and the extension remains the
   * authority, correcting it on every reply.
   */
  #tabs = new Set<string>();

  constructor(options: RelayBackendOptions) {
    if (options.scope && isVisitorScope(options.scope)) {
      throw new GhostBrowserError("forbidden_scope", RELAY_VISITOR_REFUSAL, {
        visitorId: options.scope.visitorId,
      });
    }
    this.#transport = options.transport;
  }

  get running(): boolean {
    return this.#transport.connected && this.#tabs.size > 0;
  }

  /**
   * Headless is meaningless here: the browser is the creator's, already on their
   * desktop. Reporting `applied: false` is what makes the tool say so out loud
   * rather than pretending the flag landed.
   */
  setHeadless(_headless: boolean): { applied: boolean } {
    return { applied: false };
  }

  // -------------------------------------------------------------------- plumbing

  async #call(
    op: RelayOp,
    args: Readonly<Record<string, unknown>>,
    options: BackendActionOptions,
  ): Promise<Record<string, unknown>> {
    if (!this.#transport.connected) {
      this.#tabs.clear();
      throw new GhostBrowserError("browser_unavailable", RELAY_DISCONNECTED_MESSAGE, { op });
    }
    const reply = await this.#transport.request(op, args, { timeoutMs: options.timeoutMs });
    if (!reply.ok) {
      // The extension telling us the tab is gone is the one failure that also
      // changes our own state: there is nothing to act on until the next `open`.
      if (reply.failure === "no_page" || reply.failure === "browser_unavailable") {
        this.#tabs.clear();
      }
      throw new GhostBrowserError(reply.failure, reply.message, {
        op,
        ...(reply.details ?? {}),
      });
    }
    if (!isRecord(reply.result)) malformed(op, "the result is not an object");
    return reply.result;
  }

  // --------------------------------------------------------------------- actions

  async current(): Promise<PageSummary | undefined> {
    // Cheap and non-committal when no tab has ever been opened: do not start or
    // contact anything merely to confirm absence. Once a tab is believed to
    // exist, however, a disconnected relay is a real failure and #call reports it.
    if (this.#tabs.size === 0) return undefined;
    const result = await this.#call("current", {}, { timeoutMs: 5_000 });
    const page = result["page"];
    if (page === null || page === undefined) {
      this.#tabs.clear();
      return undefined;
    }
    return readPage("current", page);
  }

  async open(url: string, options: BackendActionOptions): Promise<PageSummary> {
    const result = await this.#call("open", { url }, options);
    // The extension names the tab it opened; remember it so `running`/`current`
    // can answer without a round-trip. A missing id (older extension) still means
    // there is a tab, so fall back to a sentinel rather than reporting none.
    const id = result["id"];
    this.#tabs.add(typeof id === "string" && id !== "" ? id : "active");
    return readPage("open", result["page"]);
  }

  async read(options: BackendActionOptions): Promise<BackendReadResult> {
    const result = await this.#call("read", {}, options);
    const page = readPage("read", result["page"]);
    const text = result["text"];
    return { ...page, text: typeof text === "string" ? text : "" };
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

  async screenshot(options: BackendScreenshotOptions): Promise<PageSummary> {
    const result = await this.#call("screenshot", { fullPage: options.fullPage }, options);
    const png = result["png"];
    if (typeof png !== "string" || png === "") malformed("screenshot", "no image came back");
    // The seam says the session layer owns naming and the directory, so the bytes
    // arrive base64 and get written on this side of the socket.
    await writeFile(options.path, Buffer.from(png, "base64"));
    return readPage("screenshot", result["page"]);
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
      type: typeof result["type"] === "string" ? (result["type"] as string) : typeof result["value"],
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
    // The extension is authoritative on which tabs exist: rebuild the local mirror
    // from its answer so `running` and `current` stay honest across create/close.
    this.#tabs = new Set(tabs.map((tab) => tab.id));
    const active = typeof result["active"] === "string" ? (result["active"] as string) : null;
    const id = typeof result["id"] === "string" ? (result["id"] as string) : undefined;
    const page = result["page"];
    return {
      tabs,
      active,
      ...(id === undefined ? {} : { id }),
      ...(page === null || page === undefined ? {} : { page: readPage("tabs", page) }),
    };
  }

  /**
   * Close the ghost's tab and let the extension drop its debugger attachment. The
   * *browser* is emphatically not closed — it is the creator's, with the rest of
   * their day open in it.
   */
  async close(): Promise<boolean> {
    if (this.#tabs.size === 0) return false;
    const result = await this.#call("close", {}, { timeoutMs: 10_000 });
    const closed = result["closed"];
    if (typeof closed !== "boolean") malformed("close", "closed is not a boolean");
    // The `close` op shuts the *active* tab; the extension reports the tabs that
    // remain so the mirror stays truthful when several were open. An older
    // extension that returns no such list leaves the ghost with one tab, so
    // clearing is the safe default there.
    const tabs = result["tabs"];
    this.#tabs = Array.isArray(tabs)
      ? new Set(readTabInfos(tabs).map((tab) => tab.id))
      : new Set();
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

/**
 * The relay backend factory, for `createBrowserExtension({ backend })`.
 *
 * The scope check happens *here*, at factory time, not only inside the backend:
 * by the time a visitor session has a backend object it has already been handed
 * the capability, and the three locks in `browser.ts` are about the tool, not
 * about who holds the object. A visitor session that somehow reached this
 * function fails to build rather than building something that works.
 */
export function relayBackend(options: RelayBackendOptions): BrowserBackendFactory {
  if (options.scope && isVisitorScope(options.scope)) {
    throw new GhostBrowserError("forbidden_scope", RELAY_VISITOR_REFUSAL, {
      visitorId: options.scope.visitorId,
    });
  }
  return identifiedBrowserBackendFactory(
    (_ctx: BrowserBackendContext) => new RelayBrowserBackend(options),
    "relay",
    ["relay", options.transport],
  );
}
