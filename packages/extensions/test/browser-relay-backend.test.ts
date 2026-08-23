/**
 * The relay backend, driven against a scripted transport.
 *
 * Same shape as the `RecordingBackend` tests in `browser-extension.test.ts`, and
 * for the same reason: what wants pinning down is that the policy above the seam
 * (URL vetting, ref bookkeeping, the read budget, screenshot naming) applies to a
 * backend that is *not* Playwright, and that this particular backend translates a
 * socket into that seam faithfully — including when the socket is not there.
 *
 * No WebSocket, no browser, no daemon: the transport is three members and a
 * script of replies.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhostError } from "../src/errors.js";
import { visitorScope } from "../src/scope.js";
import type { BrowserFailure } from "../src/extensions/browser-backend.js";
import {
  RelayBrowserBackend,
  relayBackend,
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
  SCREENSHOT_DIRNAME,
} from "../src/extensions/browser-session.js";

interface Sent {
  readonly op: RelayOp;
  readonly args: Record<string, unknown>;
  readonly timeoutMs: number;
}

/** A transport that answers from a script and records what it was asked. */
class ScriptedTransport implements RelayTransport {
  connected = true;
  peer: string | undefined = "Chromium/141 via ghost-relay/0.0.1";
  readonly sent: Sent[] = [];
  /** Per-op reply. A function gets the args, so a test can branch on them. */
  replies = new Map<RelayOp, RelayReply | ((args: Record<string, unknown>) => RelayReply)>();
  /** Ops that should look like the extension vanished mid-request. */
  dropOn = new Set<RelayOp>();

  answer(op: RelayOp, result: unknown): void {
    this.replies.set(op, { ok: true, result });
  }

  refuse(op: RelayOp, failure: BrowserFailure, message = "no"): void {
    this.replies.set(op, { ok: false, failure, message });
  }

  async request(
    op: RelayOp,
    args: Readonly<Record<string, unknown>>,
    options: { timeoutMs: number },
  ): Promise<RelayReply> {
    this.sent.push({ op, args: { ...args }, timeoutMs: options.timeoutMs });
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

function transportWithPage(): ScriptedTransport {
  const transport = new ScriptedTransport();
  transport.answer("open", { page: PAGE });
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

// ------------------------------------------------------------------- protocol

describe("the protocol constants are a contract", () => {
  it("names exactly the verbs the seam has, plus current and status", () => {
    expect([...RELAY_OPS]).toEqual([
      "status", "current", "open", "read", "find",
      "click", "type", "screenshot", "back", "close",
    ]);
  });

  it("has no escape hatch that would run arbitrary script in the creator's browser", () => {
    for (const forbidden of ["eval", "evaluate", "exec", "script", "cdp", "raw"]) {
      expect(RELAY_OPS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("pins the version and subprotocol the extension has to agree with", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
    expect(RELAY_SUBPROTOCOL).toBe("ghost-relay.v1");
  });
});

// -------------------------------------------------------------------- actions

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

    expect(transport.lastFor("find")?.args).toEqual({ query: "Sign in", limit: 2 });
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
    expect(transport.lastFor("click")?.args).toEqual({ ref: "e3" });

    await backend.click({ selector: "button.primary" }, { timeoutMs: 5_000 });
    expect(transport.lastFor("click")?.args).toEqual({ selector: "button.primary" });

    // A ref wins when both arrive, matching the Playwright backend.
    await backend.click({ ref: "e1", selector: "a" }, { timeoutMs: 5_000 });
    expect(transport.lastFor("click")?.args).toEqual({ ref: "e1" });
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
    expect(transport.lastFor("type")?.args)
      .toEqual({ ref: "e2", text: "letterpress", submit: false });

    await backend.type({ ref: "e2", text: "x", submit: true }, { timeoutMs: 5_000 });
    expect(transport.lastFor("type")?.args).toMatchObject({ submit: true });
  });

  it("reports honestly when there was nowhere to go back to", async () => {
    const transport = transportWithPage();
    transport.answer("back", { page: PAGE, moved: false });
    const backend = await opened(transport);
    expect(await backend.back({ timeoutMs: 5_000 })).toMatchObject({ moved: false });
  });

  it("is never headless and says so rather than pretending the flag landed", async () => {
    const backend = new RelayBrowserBackend({ transport: transportWithPage() });
    expect(backend.headless).toBe(false);
    expect(backend.setHeadless(true)).toEqual({ applied: false });
    expect(backend.headless).toBe(false);
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

// ------------------------------------------------------------------ screenshots

describe("screenshots", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-relay-shot-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the bytes the extension sent to the path the session chose", async () => {
    const png = Buffer.from("not really a png", "utf8");
    const transport = transportWithPage();
    transport.answer("screenshot", { page: PAGE, png: png.toString("base64") });
    const backend = await opened(transport);

    const path = join(dir, "shot.png");
    const page = await backend.screenshot({ timeoutMs: 5_000, path, fullPage: true });

    expect(page).toEqual(PAGE);
    expect(await readFile(path)).toEqual(png);
    // fullPage is the backend's to forward, not to decide.
    expect(transport.lastFor("screenshot")?.args).toEqual({ fullPage: true });
  });

  it("complains rather than writing an empty file when no image came back", async () => {
    const transport = transportWithPage();
    transport.answer("screenshot", { page: PAGE });
    const backend = await opened(transport);
    const error = await expectGhostError(
      backend.screenshot({ timeoutMs: 5_000, path: join(dir, "shot.png"), fullPage: false }),
    );
    expect(error.message).toMatch(/no image came back/i);
  });
});

// ---------------------------------------------------------------- the sad paths

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

  it("reports a disconnected close as a relay failure, then remembers the tab is gone", async () => {
    const transport = transportWithPage();
    const backend = await opened(transport);
    transport.connected = false;
    const error = await expectGhostError(backend.close());
    expect(error.details["failure"]).toBe("browser_unavailable");
    expect(await backend.close()).toBe(false);
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

// ----------------------------------------------------------- the visitor guard

describe("a visitor can never reach the creator's browser", () => {
  it("refuses to build a backend for a visitor scope", () => {
    const transport = transportWithPage();
    expect(() => relayBackend({ transport, scope: visitorScope("visitor-1") }))
      .toThrow(/never available in a visitor conversation/i);
  });

  it("refuses to construct one directly either", () => {
    const transport = transportWithPage();
    expect(() => new RelayBrowserBackend({ transport, scope: visitorScope("visitor-1") }))
      .toThrow(/never available in a visitor conversation/i);
  });

  it("throws a forbidden GhostError, not a bare Error", () => {
    const transport = transportWithPage();
    try {
      relayBackend({ transport, scope: visitorScope("visitor-1") });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GhostError);
      expect((error as GhostError).code).toBe("forbidden");
      expect((error as GhostError).details["failure"]).toBe("forbidden_scope");
    }
  });

  it("builds happily for the creator", () => {
    const transport = transportWithPage();
    const backend = relayBackend({ transport })({ homeDir: "/tmp/whatever" });
    expect(backend.name).toBe("relay");
  });
});

// ------------------------------------------------------- policy above the seam

describe("the session layer's policy applies to the relay too", () => {
  let dir: string;
  let transport: ScriptedTransport;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-relay-home-"));
    transport = transportWithPage();
  });

  afterEach(async () => {
    await closeAllBrowserSessions();
    await rm(dir, { recursive: true, force: true });
  });

  function session() {
    return browserSessionFor(dir, { backend: relayBackend({ transport }), idleTimeoutMs: 0 });
  }

  it("reuses independently-created relay factories for the same transport", () => {
    expect(session()).toBe(session());
  });

  it("refuses a file URL before the relay hears about it", async () => {
    await expectGhostError(session().open("file:///etc/shadow"));
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses localhost by default, on the creator's own machine most of all", async () => {
    await expectGhostError(session().open("http://127.0.0.1:8787/admin"));
    expect(transport.sent).toHaveLength(0);
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
    expect(shot.path.startsWith(join(dir, SCREENSHOT_DIRNAME))).toBe(true);
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
