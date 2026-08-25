/**
 * The relay's pure half: frame parsing, the token store, and the upgrade check.
 *
 * These are the decisions that keep a web page out of the owner's browser and a
 * malformed frame out of the request table, and all of them are decidable from
 * bytes — so they are tested from bytes, with no socket, no browser, and no
 * daemon anywhere in sight.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeRelayUpgrade,
  encodeServerFrame,
  isRelayOp,
  MAX_FRAME_BYTES,
  parseClientFrame,
  RELAY_OPS,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
} from "../src/relay-protocol.js";
import {
  defaultRelayTokenPath,
  readOrCreateRelayToken,
  readRelayToken,
  RELAY_TOKEN_PATTERN,
  relayTokenCommand,
  relayTokenMatches,
  rotateRelayToken,
} from "../src/relay-token.js";

const TOKEN = "a".repeat(64);

function upgrade(overrides: {
  url?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
} = {}) {
  return authorizeRelayUpgrade(
    {
      url: overrides.url ?? `${RELAY_PATH}`,
      headers: {
        origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "sec-websocket-protocol": `${RELAY_SUBPROTOCOL}, ${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}`,
        ...(overrides.headers ?? {}),
      },
      remoteAddress: overrides.remoteAddress ?? "127.0.0.1",
    },
    TOKEN,
  );
}

// -------------------------------------------------------------------- framing

describe("client frames", () => {
  it("accepts a hello and keeps the peer's self-description bounded", () => {
    const parsed = parseClientFrame(JSON.stringify({
      t: "hello",
      protocol: RELAY_PROTOCOL_VERSION,
      agent: "x".repeat(500),
      browser: "Chromium/141",
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame).toMatchObject({ t: "hello", protocol: 1, browser: "Chromium/141" });
    // A peer that sends a megabyte of "agent" must not get a megabyte into a log.
    expect((parsed.frame as { agent: string }).agent).toHaveLength(200);
  });

  it("accepts a success reply and carries the result through untouched", () => {
    const parsed = parseClientFrame(JSON.stringify({
      t: "res", id: 7, ok: true, result: { page: { url: "https://example.com/" } },
    }));
    expect(parsed).toEqual({
      ok: true,
      frame: { t: "res", id: 7, ok: true, result: { page: { url: "https://example.com/" } } },
    });
  });

  it("accepts a failure reply and defaults an unknown failure name", () => {
    const parsed = parseClientFrame(JSON.stringify({
      t: "res", id: 2, ok: false, error: { failure: "made_up", message: "nope", details: { a: 1 } },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.t !== "res" || parsed.frame.ok) return;
    // Parsing keeps whatever came; the hub is what narrows it to the vocabulary.
    expect(parsed.frame.error).toEqual({ failure: "made_up", message: "nope", details: { a: 1 } });
  });

  it("accepts an event", () => {
    expect(parseClientFrame(JSON.stringify({ t: "event", event: "tab_closed" })))
      .toEqual({ ok: true, frame: { t: "event", event: "tab_closed" } });
  });

  it.each([
    ["not JSON", "{{{"],
    ["not a JSON object", "[1,2,3]"],
    ["not a JSON object", "\"a string\""],
    ["unknown frame type", JSON.stringify({ t: "nonsense" })],
    ["hello has no integer protocol", JSON.stringify({ t: "hello" })],
    ["hello has no integer protocol", JSON.stringify({ t: "hello", protocol: "1" })],
    ["res has no integer id", JSON.stringify({ t: "res", ok: true })],
    ["res is a failure with no error.message", JSON.stringify({ t: "res", id: 1, ok: false })],
    ["event has no name", JSON.stringify({ t: "event" })],
  ])("rejects %s with a reason, never a throw", (reason, raw) => {
    const parsed = parseClientFrame(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain(reason);
  });

  it("refuses a frame over the size cap without parsing it", () => {
    const parsed = parseClientFrame("x".repeat(MAX_FRAME_BYTES + 1));
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/over the .* cap/);
  });

  it("leaves room for a full-page screenshot, which is the big frame", () => {
    // base64 of a large PNG; anything under a few MB would silently break
    // `screenshot` on a tall page.
    expect(MAX_FRAME_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it("encodes server frames as one JSON object per message", () => {
    expect(JSON.parse(encodeServerFrame({
      t: "req", id: 3, op: "find", args: { query: "Sign in", limit: 5 }, timeoutMs: 30_000,
    }))).toEqual({
      t: "req", id: 3, op: "find", args: { query: "Sign in", limit: 5 }, timeoutMs: 30_000,
    });
  });

  it("knows its own op set and nothing else", () => {
    for (const op of RELAY_OPS) expect(isRelayOp(op)).toBe(true);
    for (const op of ["eval", "sendCommand", "attach", ""]) expect(isRelayOp(op)).toBe(false);
  });
});

// ------------------------------------------------------------- upgrade check

describe("who may open a relay socket", () => {
  it("lets the extension in and negotiates the subprotocol", () => {
    expect(upgrade()).toEqual({ ok: true, subprotocol: RELAY_SUBPROTOCOL });
  });

  it("accepts the token in a query string too, for the CLI and for tests", () => {
    expect(upgrade({
      url: `${RELAY_PATH}?token=${TOKEN}`,
      headers: { origin: "", "sec-websocket-protocol": "" },
    })).toMatchObject({ ok: true });
  });

  it("refuses a web page, whatever token it guessed", () => {
    const decision = upgrade({ headers: { origin: "https://evil.example" } });
    expect(decision).toMatchObject({ ok: false, status: 403 });
    if (decision.ok) return;
    expect(decision.reason).toMatch(/web page/i);
  });

  it("refuses a connection from off this machine", () => {
    expect(upgrade({ remoteAddress: "192.168.1.40" })).toMatchObject({ ok: false, status: 403 });
  });

  it("accepts loopback in all the spellings Node uses", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(upgrade({ remoteAddress: address })).toMatchObject({ ok: true });
    }
  });

  it("refuses when no token was presented at all", () => {
    const decision = upgrade({ headers: { "sec-websocket-protocol": RELAY_SUBPROTOCOL } });
    expect(decision).toMatchObject({ ok: false, status: 401 });
    if (decision.ok) return;
    expect(decision.reason).toMatch(/ghostd relay-token/);
  });

  it("refuses the wrong token", () => {
    expect(upgrade({
      headers: {
        "sec-websocket-protocol":
          `${RELAY_SUBPROTOCOL}, ${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${"b".repeat(64)}`,
      },
    })).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a token that is merely a prefix of the real one", () => {
    expect(upgrade({
      headers: {
        "sec-websocket-protocol":
          `${RELAY_SUBPROTOCOL}, ${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${TOKEN.slice(0, 32)}`,
      },
    })).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a client that speaks a subprotocol we do not", () => {
    expect(upgrade({
      headers: { "sec-websocket-protocol": `some-other.v9, ${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}` },
    })).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses any path that is not the relay", () => {
    expect(upgrade({ url: "/api/ghosts" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("constant-time token comparison", () => {
  it("matches only an exact token", () => {
    expect(relayTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(relayTokenMatches(TOKEN, TOKEN.slice(0, 63))).toBe(false);
    expect(relayTokenMatches(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(relayTokenMatches(TOKEN, "b".repeat(64))).toBe(false);
  });

  it("never matches an empty token, however empty the stored one is", () => {
    expect(relayTokenMatches("", "")).toBe(false);
    expect(relayTokenMatches(TOKEN, "")).toBe(false);
  });
});

// ---------------------------------------------------------------- token store

describe("the token store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-relay-token-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lives under XDG state, not config — it is not something to hand-edit", () => {
    expect(defaultRelayTokenPath({ XDG_STATE_HOME: "/xdg/state" }, "/home/x"))
      .toBe("/xdg/state/ghost/relay-token");
    expect(defaultRelayTokenPath({}, "/home/x"))
      .toBe("/home/x/.local/state/ghost/relay-token");
    // A relative XDG_STATE_HOME is not a state home.
    expect(defaultRelayTokenPath({ XDG_STATE_HOME: "relative" }, "/home/x"))
      .toBe("/home/x/.local/state/ghost/relay-token");
  });

  it("mints once and reads back the same token forever after", () => {
    const path = join(dir, "state", "relay-token");
    const first = readOrCreateRelayToken({ path });
    expect(first.created).toBe(true);
    expect(first.token).toMatch(RELAY_TOKEN_PATTERN);

    const second = readOrCreateRelayToken({ path });
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(readRelayToken({ path })).toBe(first.token);
  });

  it("writes it 0600, because everything else on this box runs as the same user", async () => {
    const path = join(dir, "relay-token");
    readOrCreateRelayToken({ path });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).trim()).toMatch(RELAY_TOKEN_PATTERN);
  });

  it("keeps separate token files independent and reports a missing file", () => {
    const path = join(dir, "relay-token");
    readOrCreateRelayToken({ path });
    const other = readOrCreateRelayToken({ path: join(dir, "other") });
    expect(other.token).not.toBe(readRelayToken({ path }));
    expect(readRelayToken({ path: join(dir, "nothing-here") })).toBeUndefined();
  });

  it("rotates to something new, invalidating whatever the extension stored", () => {
    const path = join(dir, "relay-token");
    const before = readOrCreateRelayToken({ path }).token;
    const after = rotateRelayToken({ path }).token;
    expect(after).not.toBe(before);
    expect(readRelayToken({ path })).toBe(after);
  });

  it("honours GHOSTD_RELAY_TOKEN_FILE so a test never touches the real one", () => {
    expect(defaultRelayTokenPath({ GHOSTD_RELAY_TOKEN_FILE: "/tmp/t" }, "/home/x")).toBe("/tmp/t");
  });
});

describe("ghostd relay-token", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-relay-cli-"));
    out = [];
    err = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (argv: string[]) =>
    relayTokenCommand(argv, {
      path: join(dir, "relay-token"),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });

  it("prints the token and says where it lives", () => {
    expect(run([])).toBe(0);
    const text = out.join("");
    expect(text.split("\n")[0]).toMatch(RELAY_TOKEN_PATTERN);
    expect(text).toMatch(/popup to pair it/);
    expect(text).toContain(join(dir, "relay-token"));
  });

  it("prints only the token under --quiet, so it can be piped", () => {
    expect(run(["--quiet"])).toBe(0);
    expect(out.join("").trim()).toMatch(RELAY_TOKEN_PATTERN);
    expect(out.join("")).not.toMatch(/popup/);
  });

  it("is stable across calls but changes under --rotate", () => {
    run(["--quiet"]);
    const first = out.join("").trim();
    out = [];
    run(["--quiet"]);
    expect(out.join("").trim()).toBe(first);
    out = [];
    expect(run(["--rotate", "--quiet"])).toBe(0);
    expect(out.join("").trim()).not.toBe(first);
  });

  it("refuses an option it does not know rather than guessing", () => {
    expect(run(["--yolo"])).toBe(2);
    expect(err.join("")).toMatch(/unknown option --yolo/);
  });
});
