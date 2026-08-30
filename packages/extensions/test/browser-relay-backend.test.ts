/**
 * The relay backend, driven against a scripted transport.
 *
 * Same shape as the `RecordingBackend` tests in `browser-extension.test.ts`, and
 * for the same reason: what wants pinning down is that the policy above the seam
 * (URL vetting, ref bookkeeping, the read budget, screenshot naming) applies to a
 * backend seam, and that this backend translates a
 * socket into that seam faithfully — including when the socket is not there.
 *
 * No WebSocket, no browser, no daemon: the transport is three members and a
 * script of replies.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostError } from "../src/errors.js";
import type { BrowserFailure } from "../src/extensions/browser-backend.js";
import {
  RelayBrowserBackend,
  relayBackend,
  RELAY_OFF_MESSAGE,
  RELAY_OPS,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  type RelayOp,
  type RelayReply,
  type RelayTransport,
} from "../src/extensions/browser-relay-backend.js";
import {
  browserSessionFor,
  closeAllBrowserSessions,
} from "../src/extensions/browser-session.js";
import { MAX_SCREENSHOT_BYTES } from "../src/extensions/screenshot-retention.js";

interface Sent {
  readonly op: RelayOp;
  readonly args: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

const PUBLIC_RESOLVER = async () => [{ address: "93.184.216.34", family: 4 }];

class ScriptedTransport implements RelayTransport {
  connected = true;
  peer: string | undefined = "Chromium/141 via ghost-relay/0.0.1";
  readonly sent: Sent[] = [];
  replies = new Map<RelayOp, RelayReply | ((args: Record<string, unknown>) => RelayReply)>();
  dropOn = new Set<RelayOp>();
  barriers = new Map<RelayOp, Promise<void>>();

  answer(op: RelayOp, result: unknown): void {
    this.replies.set(op, { ok: true, result });
  }

  refuse(op: RelayOp, failure: BrowserFailure, message = "no"): void {
    this.replies.set(op, { ok: false, failure, message });
  }

  async request(
    op: RelayOp,
    args: Readonly<Record<string, unknown>>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<RelayReply> {
    this.sent.push({
      op,
      args: { ...args },
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await this.barriers.get(op);
    if (this.dropOn.has(op)) {
      this.connected = false;
      return { ok: false, failure: "browser_unavailable", message: "gone" };
    }
    const scripted = this.replies.get(op);
    if (scripted === undefined) {
      return { ok: false, failure: "navigation_failed", message: `no script for ${op}` };
    }
    return typeof scripted === "function" ? scripted({ ...args }) : scripted;
  }

  lastFor(op: RelayOp): Sent | undefined {
    return this.sent.findLast((entry) => entry.op === op);
  }
}

const PAGE = { url: "https://example.com/", title: "Example Domain" };

/**
 * What one op put on the wire, minus the session id every op carries — that is
 * asserted once, on its own, rather than repeated in thirteen expectations.
 */
function sentArgs(transport: ScriptedTransport, op: string): Record<string, unknown> | undefined {
  const args = transport.lastFor(op as never)?.args;
  if (args === undefined) return undefined;
  const { session: _session, ...rest } = args as Record<string, unknown>;
  return rest;
}

function transportWithPage(): ScriptedTransport {
  const transport = new ScriptedTransport();
  transport.answer("open", { page: PAGE, id: "t1" });
  transport.answer("current", { page: PAGE });
  transport.answer("close", { closed: true });
  return transport;
}

async function opened(transport: ScriptedTransport): Promise<RelayBrowserBackend> {
  const backend = new RelayBrowserBackend({ transport });
  await backend.open(PAGE.url, { timeoutMs: 5_000 });
  return backend;
}

async function expectGhostError(work: Promise<unknown>): Promise<GhostError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(GhostError);
    return error as GhostError;
  }
  throw new Error("expected a GhostError");
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}


describe("the protocol constants are a contract", () => {
  it("names exactly the verbs the seam has, plus current and status", () => {
    expect([...RELAY_OPS]).toEqual([
      "status", "current", "open", "read", "find",
      "click", "type", "screenshot", "back", "close",
      "forward", "scroll", "drag", "key", "javascript",
      "console", "network", "upload", "resize", "tabs",
    ]);
  });

  it("has exactly one op that runs page script, and it is the named `javascript` one", () => {
    // The closed-set claim changed with Tier 1: the owner's ghost, on the
    // owner's machine, may run script in the page. That capability lives in
    // a single, explicit op — `javascript` — and there is still no *other* verb
    // (a generic eval/exec/cdp/raw) that would smuggle script through a different
    // channel.
    expect(RELAY_OPS as readonly string[]).toContain("javascript");
    for (const forbidden of ["eval", "evaluate", "exec", "script", "cdp", "raw"]) {
      expect(RELAY_OPS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("frames the javascript result as untrusted in the tool description", async () => {
    // The untrusted-result warning is the surviving defense; it lives on the tool
    // the model actually reads.
    const { createBrowserExtension, GHOST_BROWSER } = await import("../src/extensions/browser.js");
    const { loadExtension } = await import("./support/harness.js");
    const { mkdtemp } = await import("node:fs/promises");
    const home = await mkdtemp(join(tmpdir(), "ghost-relay-desc-"));
    const harness = await loadExtension(
      createBrowserExtension({
        backend: relayBackend({ transport: new ScriptedTransport() }),
        browser: { idleTimeoutMs: 0 },
      }),
      home,
    );
    const description = harness.tools.get(GHOST_BROWSER)?.description ?? "";
    expect(description).toMatch(/javascript/i);
    expect(description).toMatch(/returns .* untrusted|untrusted DATA/i);
  });

  it("pins the version and subprotocol the extension has to agree with", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(4);
    expect(RELAY_SUBPROTOCOL).toBe("ghost-relay.v1");
  });
});


describe("driving the relay", () => {
  it("reports nothing running until a page is open", async () => {
    const transport = transportWithPage();
    const backend = new RelayBrowserBackend({ transport });
    expect(backend.running).toBe(false);
    expect(await backend.current()).toBeUndefined();
    // `current` must not go to the wire just to say "nothing".
    expect(transport.sent).toHaveLength(0);

    await backend.open(PAGE.url, { timeoutMs: 5_000 });
    expect(backend.running).toBe(true);
    expect(await backend.current()).toEqual(PAGE);
  });

  it("passes the action timeout through on every op", async () => {
    const transport = transportWithPage();
    transport.answer("read", { page: PAGE, text: "hello" });
    const backend = await opened(transport);
    await backend.read({ timeoutMs: 4_000 });
    expect(transport.lastFor("open")?.timeoutMs).toBe(5_000);
    expect(transport.lastFor("read")?.timeoutMs).toBe(4_000);
  });

  it("passes cancellation to the transport and rejects even when v1 cannot cancel remotely", async () => {
    const transport = transportWithPage();
    transport.answer("read", { page: PAGE, text: "late" });
    let release!: () => void;
    transport.barriers.set("read", new Promise<void>((resolve) => {
      release = resolve;
    }));
    const backend = await opened(transport);
    const controller = new AbortController();
    const reading = backend.read({ timeoutMs: 5_000, signal: controller.signal });
    await vi.waitFor(() => expect(transport.lastFor("read")).toBeDefined());
    controller.abort();
    const error = await expectGhostError(reading);
    expect(error.details["reason"]).toBe("aborted");
    expect(transport.lastFor("read")?.signal).toBe(controller.signal);
    // Protocol v1 has no cancel op. Let the late reply settle so the test also
    // proves it is safely observed rather than becoming an unhandled rejection.
    release();
    await Promise.resolve();
  });

  it("returns page text untruncated — the budget is the session layer's", async () => {
    const transport = transportWithPage();
    transport.answer("read", { page: PAGE, text: "y".repeat(3_000) });
    const backend = await opened(transport);
    const result = await backend.read({ timeoutMs: 5_000 });
    expect(result.text).toHaveLength(3_000);
    expect(result.url).toBe(PAGE.url);
  });

  it("clamps find results to the limit it asked for", async () => {
    const transport = transportWithPage();
    transport.answer("find", {
      page: PAGE,
      matches: [
        { ref: "e1", tag: "A", name: "Sign in", href: "/login", text: "Sign in" },
        { ref: "e2", tag: "input", value: "q", visible: false, disabled: true },
        { ref: "e3", tag: "button" },
      ],
    });
    const backend = await opened(transport);
    const matches = await backend.find("Sign in", { timeoutMs: 5_000, limit: 2 });

    expect(sentArgs(transport, "find")).toEqual({ tab: "t1", query: "Sign in", limit: 2 });
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      ref: "e1", tag: "A", name: "Sign in", href: "/login", text: "Sign in",
      visible: true, disabled: false,
    });
    // Absent flags default the safe way round: visible unless told otherwise,
    // disabled only when the extension says so.
    expect(matches[1]).toMatchObject({ ref: "e2", visible: false, disabled: true, value: "q" });
  });

  it("sends a ref when it has one and a selector otherwise", async () => {
    const transport = transportWithPage();
    transport.answer("click", { page: PAGE });
    const backend = await opened(transport);

    await backend.click({ ref: " e3 " }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "click")).toEqual({ tab: "t1", ref: "e3" });

    await backend.click({ selector: "button.primary" }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "click")).toEqual({ tab: "t1", selector: "button.primary" });

    // A ref wins when both arrive: it is the more specific of the two.
    await backend.click({ ref: "e1", selector: "a" }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "click")).toEqual({ tab: "t1", ref: "e1" });
  });

  it("refuses to act with neither a ref nor a selector", async () => {
    const transport = transportWithPage();
    const backend = await opened(transport);
    const error = await expectGhostError(backend.click({}, { timeoutMs: 5_000 }));
    expect(error.details["failure"]).toBe("invalid_input");
  });

  it("makes submitting explicit on the wire", async () => {
    const transport = transportWithPage();
    transport.answer("type", { page: PAGE });
    const backend = await opened(transport);

    await backend.type({ ref: "e2", text: "letterpress", submit: false }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "type"))
      .toEqual({ tab: "t1", ref: "e2", text: "letterpress", submit: false });

    await backend.type({ ref: "e2", text: "x", submit: true }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "type")).toMatchObject({ submit: true });
  });

  it("reports honestly when there was nowhere to go back to", async () => {
    const transport = transportWithPage();
    transport.answer("back", { page: PAGE, moved: false });
    const backend = await opened(transport);
    expect(await backend.back({ timeoutMs: 5_000 })).toMatchObject({ moved: false });
  });

  it("closes the ghost's tab without closing the browser", async () => {
    const transport = transportWithPage();
    transport.answer("close", { closed: true });
    const backend = await opened(transport);
    expect(await backend.close()).toBe(true);
    expect(backend.running).toBe(false);
    expect(transport.lastFor("close")).toBeDefined();
  });
});


describe("the Tier-1 relay ops translate the seam to the wire", () => {
  it("forwards, mirroring back", async () => {
    const transport = transportWithPage();
    transport.answer("forward", { page: PAGE, moved: true });
    const backend = await opened(transport);
    expect(await backend.forward({ timeoutMs: 5_000 })).toMatchObject({ moved: true });
  });

  it("scrolls with a wheel delta and an optional anchor", async () => {
    const transport = transportWithPage();
    transport.answer("scroll", { page: PAGE });
    const backend = await opened(transport);
    await backend.scroll({ deltaX: 0, deltaY: 300, x: 10, y: 20 }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "scroll")).toEqual({ tab: "t1", deltaX: 0, deltaY: 300, x: 10, y: 20 });
  });

  it("drags from one point to another", async () => {
    const transport = transportWithPage();
    transport.answer("drag", { page: PAGE });
    const backend = await opened(transport);
    await backend.drag({ fromX: 1, fromY: 2, toX: 3, toY: 4, steps: 5 }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "drag")).toEqual({ tab: "t1", fromX: 1, fromY: 2, toX: 3, toY: 4, steps: 5 });
  });

  it("sends a key with its modifiers", async () => {
    const transport = transportWithPage();
    transport.answer("key", { page: PAGE });
    const backend = await opened(transport);
    await backend.key({ key: "a", modifiers: ["Control"] }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "key")).toMatchObject({ key: "a", modifiers: ["Control"] });
  });

  it("runs javascript and returns the value and its type", async () => {
    const transport = transportWithPage();
    transport.answer("javascript", { value: 42, type: "number" });
    const backend = await opened(transport);
    const result = await backend.javascript("40+2", { timeoutMs: 5_000 });
    expect(sentArgs(transport, "javascript")).toEqual({ tab: "t1", code: "40+2" });
    expect(result).toEqual({ value: 42, type: "number" });
  });

  it("drains console and network buffers, tolerating a stray shape", async () => {
    const transport = transportWithPage();
    transport.answer("console", {
      entries: [{ level: "warn", text: "hi", url: "https://x", line: 3 }, "junk"],
    });
    transport.answer("network", {
      entries: [{ method: "GET", url: "https://x", status: 200, type: "document", bodyBytes: 12 }],
    });
    const backend = await opened(transport);
    expect(await backend.readConsole({ timeoutMs: 5_000 })).toEqual([
      { level: "warn", text: "hi", url: "https://x", line: 3 },
    ]);
    expect(await backend.readNetwork({ timeoutMs: 5_000 })).toEqual([
      { method: "GET", url: "https://x", status: 200, type: "document", bodyBytes: 12 },
    ]);
  });

  it("sends upload paths with the target", async () => {
    const transport = transportWithPage();
    transport.answer("upload", { page: PAGE });
    const backend = await opened(transport);
    await backend.upload({ ref: "e1", paths: ["/tmp/a"] }, { timeoutMs: 5_000 });
    expect(sentArgs(transport, "upload")).toEqual({ tab: "t1", ref: "e1", paths: ["/tmp/a"] });
  });

  it("resizes and reports whether it applied", async () => {
    const transport = transportWithPage();
    transport.answer("resize", { page: PAGE, applied: true });
    const backend = await opened(transport);
    expect(await backend.resize({ width: 800, height: 600 }, { timeoutMs: 5_000 }))
      .toMatchObject({ applied: true });
    expect(sentArgs(transport, "resize")).toEqual({ tab: "t1", width: 800, height: 600 });
  });
});

describe("the relaxed one-tab invariant, on the relay backend", () => {
  it.each([
    ["open", "open" as const],
    ["tab create", "tabs" as const],
  ])("retires a cancelled %s and rotates before reopening", async (_label, op) => {
    const transport = transportWithPage();
    transport.answer("tabs", {
      tabs: [{ id: "t2", url: PAGE.url, title: PAGE.title, active: true }],
      active: "t2",
      id: "t2",
      page: PAGE,
    });
    const held = deferred();
    transport.barriers.set(op, held.promise);
    const backend = new RelayBrowserBackend({ transport });
    const controller = new AbortController();
    const creating: Promise<unknown> = op === "open"
      ? backend.open(PAGE.url, { timeoutMs: 5_000, signal: controller.signal })
      : backend.tabs(
          { op: "create", url: PAGE.url },
          { timeoutMs: 5_000, signal: controller.signal },
        );
    await vi.waitFor(() => expect(transport.lastFor(op)).toBeDefined());
    const retiredSession = transport.lastFor(op)?.args["session"];

    controller.abort();
    const cancelled = await expectGhostError(creating);
    expect(cancelled.details["reason"]).toBe("aborted");
    expect(backend.running).toBe(true);
    expect(await backend.close()).toBe(true);
    expect(transport.lastFor("close")?.args["session"]).toBe(retiredSession);

    transport.barriers.delete(op);
    held.resolve();
    await backend.open(PAGE.url, { timeoutMs: 5_000 });
    expect(transport.lastFor("open")?.args["session"]).not.toBe(retiredSession);
  });

  it("tracks several tabs as a set and stays running while any remain", async () => {
    const transport = transportWithPage();
    transport.replies.set("tabs", (args) => {
      if (args["op"] === "create") {
        return {
          ok: true,
          result: {
            tabs: [
              { id: "t1", url: PAGE.url, title: PAGE.title, active: false },
              { id: "t2", url: "https://example.com/second", title: "Second", active: true },
            ],
            active: "t2",
            id: "t2",
            page: { url: "https://example.com/second", title: "Second" },
          },
        };
      }
      // close t2 → t1 remains
      return {
        ok: true,
        result: {
          tabs: [{ id: "t1", url: PAGE.url, title: PAGE.title, active: true }],
          active: "t1",
        },
      };
    });
    const backend = await opened(transport);
    expect(backend.running).toBe(true);

    const created = await backend.tabs({ op: "create", url: "https://example.com/second" }, { timeoutMs: 5_000 });
    expect(created.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect(created.active).toBe("t2");
    expect(backend.running).toBe(true);

    const closed = await backend.tabs({ op: "close", id: "t2" }, { timeoutMs: 5_000 });
    expect(closed.tabs.map((tab) => tab.id)).toEqual(["t1"]);
    expect(backend.running).toBe(true);
  });

  it("names one stable session on every op, and a different one per backend", async () => {
    const transport = transportWithPage();
    transport.answer("read", { page: PAGE, text: "hi" });
    const backend = await opened(transport);
    await backend.read({ timeoutMs: 5_000 });

    const sessionOf = (op: string): unknown =>
      (transport.lastFor(op as never)?.args as Record<string, unknown> | undefined)?.["session"];
    const session = sessionOf("open");
    expect(typeof session).toBe("string");
    expect(sessionOf("read")).toBe(session);

    // A second conversation is a second owner, or the extension could not tell
    // whose tab is whose over the one socket they share.
    const other = new RelayBrowserBackend({ transport: transportWithPage() });
    await other.open(PAGE.url, { timeoutMs: 5_000 });
    expect(new RelayBrowserBackend({ transport }).running).toBe(false);
  });

  it("records the tab id the extension names on open", async () => {
    const transport = transportWithPage();
    transport.answer("open", { page: PAGE, id: "t9" });
    const backend = new RelayBrowserBackend({ transport });
    await backend.open(PAGE.url, { timeoutMs: 5_000 });
    expect(backend.running).toBe(true);
  });

  it("closes the protocol session after the current tab disappears", async () => {
    const transport = transportWithPage();
    transport.answer("tabs", {
      tabs: [
        { id: "t1", url: PAGE.url, title: PAGE.title, active: false },
        { id: "t2", url: "https://example.com/second", title: "Second", active: true },
      ],
      active: "t2",
      id: "t2",
      page: { url: "https://example.com/second", title: "Second" },
    });
    const backend = await opened(transport);
    await backend.tabs(
      { op: "create", url: "https://example.com/second" },
      { timeoutMs: 5_000 },
    );
    transport.refuse("current", "no_page", "the current tab was closed");

    await expectGhostError(backend.current());
    expect(backend.running).toBe(true);
    expect(await backend.close()).toBe(true);
    expect(sentArgs(transport, "close")).toEqual({});
    expect(backend.running).toBe(false);
  });
});


describe("screenshots", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-relay-shot-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns bounded bytes for the session to publish", async () => {
    const png = Buffer.from("not really a png", "utf8");
    const transport = transportWithPage();
    transport.answer("screenshot", { page: PAGE, png: png.toString("base64") });
    const backend = await opened(transport);

    const page = await backend.screenshot({ timeoutMs: 5_000, fullPage: true });

    expect(page).toEqual({ ...PAGE, bytes: png });
    // fullPage is the backend's to forward, not to decide.
    expect(sentArgs(transport, "screenshot")).toEqual({ tab: "t1", fullPage: true });
  });

  it("complains rather than writing an empty file when no image came back", async () => {
    const transport = transportWithPage();
    transport.answer("screenshot", { page: PAGE });
    const backend = await opened(transport);
    const error = await expectGhostError(
      backend.screenshot({ timeoutMs: 5_000, fullPage: false }),
    );
    expect(error.message).toMatch(/no image came back/i);
  });

  it("rejects an oversized encoded screenshot before writing it", async () => {
    const transport = transportWithPage();
    transport.answer("screenshot", {
      page: PAGE,
      png: Buffer.alloc(MAX_SCREENSHOT_BYTES + 1).toString("base64"),
    });
    const backend = await opened(transport);
    const error = await expectGhostError(
      backend.screenshot({ timeoutMs: 5_000, fullPage: false }),
    );
    expect(error.code).toBe("limit_exceeded");
  });
});


describe("when the relay is not there", () => {
  it("says what to do about it, without going to the wire", async () => {
    const transport = transportWithPage();
    transport.connected = false;
    const backend = new RelayBrowserBackend({ transport });

    const error = await expectGhostError(backend.open(PAGE.url, { timeoutMs: 5_000 }));
    expect(error.code).toBe("not_found");
    expect(error.details["failure"]).toBe("browser_unavailable");
    expect(error.message).toMatch(/extension.*paired|popup/i);
    expect(transport.sent).toHaveLength(0);
  });

  it("names the real remedy when the daemon has no relay hub at all", async () => {
    // `GHOSTD_RELAY=off`: there is no second browser to fall back to, so the
    // tool stays registered rather than vanishing from under a conversation that
    // was using it — but telling the model to pair an extension would be a dead
    // end, because there is no endpoint to pair against.
    const backend = new RelayBrowserBackend({});
    expect(backend.running).toBe(false);
    expect(await backend.current()).toBeUndefined();

    const error = await expectGhostError(backend.open(PAGE.url, { timeoutMs: 5_000 }));
    expect(error.details["failure"]).toBe("browser_unavailable");
    expect(error.message).toBe(RELAY_OFF_MESSAGE);
    expect(error.message).toMatch(/restart ghostd/i);
  });

  it("forgets its tab when the extension disappears mid-request", async () => {
    const transport = transportWithPage();
    transport.answer("read", { page: PAGE, text: "hi" });
    const backend = await opened(transport);
    expect(backend.running).toBe(true);

    transport.dropOn.add("read");
    await expectGhostError(backend.read({ timeoutMs: 5_000 }));
    expect(backend.running).toBe(false);
    // And `current` stays quiet rather than throwing out of a cheap probe.
    expect(await backend.current()).toBeUndefined();
  });

  it("keeps a disconnected close retryable after the relay reconnects", async () => {
    const transport = transportWithPage();
    const backend = await opened(transport);
    transport.connected = false;
    const error = await expectGhostError(backend.close());
    expect(error.details["failure"]).toBe("browser_unavailable");
    expect(backend.running).toBe(false);

    transport.connected = true;
    expect(backend.running).toBe(true);
    expect(await backend.close()).toBe(true);
    expect(sentArgs(transport, "close")).toEqual({});
  });

  it("reports a disconnected current probe when it previously had a tab", async () => {
    const transport = transportWithPage();
    const backend = await opened(transport);
    transport.connected = false;

    const error = await expectGhostError(backend.current());
    expect(error.details["failure"]).toBe("browser_unavailable");
    expect(await backend.current()).toBeUndefined();
  });

  it("does not turn current or close failures into false no-page results", async () => {
    const transport = transportWithPage();
    const backend = await opened(transport);

    transport.refuse("current", "timeout", "current timed out");
    const currentError = await expectGhostError(backend.current());
    expect(currentError.details["failure"]).toBe("timeout");
    expect(currentError.message).toBe("current timed out");
    expect(backend.running).toBe(true);

    transport.refuse("close", "timeout", "close timed out");
    const closeError = await expectGhostError(backend.close());
    expect(closeError.details["failure"]).toBe("timeout");
    expect(closeError.message).toBe("close timed out");
    expect(backend.running).toBe(true);
  });

  it("carries each failure through as itself", async () => {
    const cases: BrowserFailure[] = [
      "element_not_found", "unknown_ref", "timeout", "blocked_url", "invalid_input",
    ];
    for (const failure of cases) {
      const transport = transportWithPage();
      transport.refuse("click", failure, `because ${failure}`);
      const backend = await opened(transport);
      const error = await expectGhostError(
        backend.click({ ref: "e1" }, { timeoutMs: 5_000 }),
      );
      expect(error.details["failure"]).toBe(failure);
      expect(error.message).toBe(`because ${failure}`);
      // The op that failed rides along, so a details payload is diagnosable.
      expect(error.details["op"]).toBe("click");
    }
  });

  it("refuses a reply it cannot make sense of instead of inventing a page", async () => {
    const transport = transportWithPage();
    transport.answer("read", { page: { title: "no url here" }, text: "x" });
    const backend = await opened(transport);
    const error = await expectGhostError(backend.read({ timeoutMs: 5_000 }));
    expect(error.message).toMatch(/different versions/i);
  });
});


describe("the session layer's policy applies to the relay too", () => {
  let dir: string;
  let shots: string;
  let transport: ScriptedTransport;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-relay-home-"));
    shots = join(dir, "Pictures");
    vi.stubEnv("OMARCHY_SCREENSHOT_DIR", shots);
    transport = transportWithPage();
  });

  afterEach(async () => {
    await closeAllBrowserSessions();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  function session() {
    return browserSessionFor(dir, {
      backend: relayBackend({ transport }),
      idleTimeoutMs: 0,
      resolver: PUBLIC_RESOLVER,
    });
  }

  it("reuses independently-created relay factories for the same transport", () => {
    expect(session()).toBe(session());
  });

  it("refuses a file URL before the relay hears about it", async () => {
    await expectGhostError(session().open("file:///etc/shadow"));
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses localhost by default, on the owner's machine most of all", async () => {
    await expectGhostError(session().open("http://127.0.0.1:8787/admin"));
    expect(transport.sent).toHaveLength(0);
  });

  it("rechecks a relay-returned URL and rejects a changed private DNS answer", async () => {
    let lookups = 0;
    const live = browserSessionFor(dir, {
      backend: relayBackend({ transport }),
      idleTimeoutMs: 0,
      resolver: async () => {
        lookups += 1;
        return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
      },
    });
    const error = await expectGhostError(live.open(PAGE.url));
    expect(error.details["failure"]).toBe("blocked_url");
    expect(lookups).toBe(2);
    expect(transport.lastFor("open")).toBeDefined();
  });

  it("applies the read budget to whatever the extension returns", async () => {
    transport.answer("read", { page: PAGE, text: "z".repeat(9_000) });
    const live = session();
    await live.open(PAGE.url);
    const result = await live.read({ maxChars: 400 });
    expect(result.text).toHaveLength(400);
    expect(result.totalLength).toBe(9_000);
  });

  it("refuses a ref no find minted, before the relay hears about it", async () => {
    const live = session();
    await live.open(PAGE.url);
    const before = transport.sent.length;
    const error = await expectGhostError(live.click({ ref: "e9" }));
    expect(error.details["failure"]).toBe("unknown_ref");
    expect(transport.sent.filter((entry) => entry.op === "click")).toHaveLength(0);
    expect(transport.sent.length).toBeGreaterThanOrEqual(before);
  });

  it("still owns where screenshots are written", async () => {
    transport.answer("screenshot", {
      page: PAGE,
      png: Buffer.from("png-ish").toString("base64"),
    });
    const live = session();
    await live.open(PAGE.url);
    const shot = await live.screenshot();
    expect(shot.path.startsWith(shots)).toBe(true);
    expect(await readFile(shot.path, "utf8")).toBe("png-ish");
  });

  it("drops refs when a click navigates, for this backend as for the other", async () => {
    transport.answer("find", { page: PAGE, matches: [{ ref: "e1", tag: "a" }, { ref: "e2", tag: "a" }] });
    transport.replies.set("click", { ok: true, result: { page: { url: "https://example.com/login", title: "Login" } } });
    const live = session();
    await live.open(PAGE.url);
    await live.find("Sign in");
    await live.click({ ref: "e1" });
    const error = await expectGhostError(live.click({ ref: "e2" }));
    expect(error.details["failure"]).toBe("unknown_ref");
  });
});
