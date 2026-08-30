/**
 * The relay hub, over a real WebSocket, against a fake extension.
 *
 * The pure decisions are covered in `relay-protocol.test.ts`; what is left is the
 * behaviour that only exists once a socket does — token rejection at the upgrade,
 * one connection at a time, request correlation, the timeout backstop, and what
 * happens to work in flight when the browser goes away. Those are exactly the
 * things a scripted transport cannot tell you about, so this suite stands up a
 * `http.Server`, points `ws` at it, and pretends to be Chromium.
 */
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  attachRelay,
  closeRelaySocket,
  createRelayHub,
  MAX_RELAY_MESSAGE_BYTES,
  RelayHub,
} from "../src/relay.js";
import {
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
} from "../src/relay-protocol.js";

const TOKEN = "f".repeat(64);
const INCARNATION = "11111111-1111-4111-8111-111111111111";

let server: Server;
let hub: RelayHub;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  hub = new RelayHub({
    token: TOKEN,
    pingIntervalMs: 60_000,
    helloTimeoutMs: 100,
    closeTimeoutMs: 100,
    incarnation: INCARNATION,
  });
  server = createServer((_request, response) => response.writeHead(404).end());
  attachRelay(server, hub);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    socket.removeAllListeners();
    socket.terminate();
  }
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connectExtension(options: {
  token?: string;
  origin?: string | null;
  protocol?: number;
  skipHello?: boolean;
  onRequest?: (frame: { id: number; op: string; args: Record<string, unknown> }) => unknown;
} = {}): Promise<WebSocket> {
  const token = options.token ?? TOKEN;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}${RELAY_PATH}`,
    [RELAY_SUBPROTOCOL, `${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${token}`],
    options.origin === null ? {} : { origin: options.origin ?? "chrome-extension://fakefakefake" },
  );
  openSockets.push(socket);

  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as {
      t: string; id: number; op: string; args: Record<string, unknown>;
    };
    if (frame.t !== "req") return;
    if (!options.onRequest) return;
    try {
      const result = options.onRequest(frame);
      // `undefined` means "say nothing", so a test can exercise the timeout.
      if (result === undefined) return;
      socket.send(JSON.stringify({ t: "res", id: frame.id, ok: true, result }));
    } catch (error) {
      socket.send(JSON.stringify({
        t: "res",
        id: frame.id,
        ok: false,
        error: { failure: (error as { failure?: string }).failure ?? "element_not_found",
          message: (error as Error).message },
      }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  if (!options.skipHello) {
    socket.send(JSON.stringify({
      t: "hello",
      protocol: options.protocol ?? RELAY_PROTOCOL_VERSION,
      agent: "fake-extension/1",
      browser: "Chromium/141",
    }));
    // Let the hub process the hello before a test asks about the peer.
    await waitFor(() => hub.peer !== undefined, 2_000).catch(() => undefined);
  }
  return socket;
}

async function expectUpgradeRefused(options: Parameters<typeof connectExtension>[0] = {}) {
  const token = options.token ?? TOKEN;
  const status = await new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": Buffer.from("ghost-relay-test").toString("base64"),
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Protocol": [
        RELAY_SUBPROTOCOL,
        `${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${token}`,
      ].join(", "),
    };
    if (options.origin !== null) {
      headers.Origin = options.origin ?? "chrome-extension://fakefakefake";
    }
    const upgrade = request({
      host: "127.0.0.1",
      port,
      path: RELAY_PATH,
      headers,
    });
    upgrade.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    upgrade.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    upgrade.once("error", reject);
    upgrade.end();
  });
  expect(status, "expected the upgrade to be refused").not.toBe(101);
  return new Error(`HTTP ${status}`);
}

async function connectSilentUpgrade(): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const upgrade = request({
      host: "127.0.0.1",
      port,
      path: RELAY_PATH,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: "chrome-extension://fakefakefake",
        "Sec-WebSocket-Key": Buffer.from("ghost-relay-test").toString("base64"),
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Protocol": [
          RELAY_SUBPROTOCOL,
          `${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}`,
        ].join(", "),
      },
    });
    upgrade.once("upgrade", (_response, socket) => {
      socket.pause();
      resolve(socket);
    });
    upgrade.once("response", (response) => {
      response.resume();
      reject(new Error(`upgrade was refused with ${response.statusCode}`));
    });
    upgrade.once("error", reject);
    upgrade.end();
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting"));
      setTimeout(tick, 10);
    };
    tick();
  });
}


describe("pairing", () => {
  it("accepts the extension and reports who connected", async () => {
    await connectExtension();
    expect(hub.connected).toBe(true);
    expect(hub.peer).toBe("Chromium/141 via fake-extension/1");
    expect(hub.status()).toMatchObject({ connected: true, protocol: RELAY_PROTOCOL_VERSION });
    expect(hub.status().since).toBeTypeOf("string");
  });

  it("refuses the wrong token before a socket exists", async () => {
    const error = await expectUpgradeRefused({ token: "0".repeat(64) });
    expect(error.message).toMatch(/401/);
    expect(hub.connected).toBe(false);
  });

  it("refuses a web page's origin, however good its token", async () => {
    const error = await expectUpgradeRefused({ origin: "https://evil.example" });
    expect(error.message).toMatch(/403/);
  });

  it("refuses a second browser rather than letting two interleave clicks", async () => {
    await connectExtension();
    const error = await expectUpgradeRefused();
    expect(error.message).toMatch(/409/);
    // And the first one is untouched.
    expect(hub.connected).toBe(true);
  });

  it("does not admit or dispatch work to a socket before compatible hello", async () => {
    let requests = 0;
    await connectExtension({
      skipHello: true,
      onRequest: () => {
        requests += 1;
        return {};
      },
    });

    expect(hub.connected).toBe(false);
    expect(hub.status()).toMatchObject({ connected: false, peer: null, since: null });
    expect(await hub.request("read", {}, { timeoutMs: 3_000 })).toMatchObject({
      ok: false,
      failure: "browser_unavailable",
    });
    expect(requests).toBe(0);
  });

  it("force-retires a silent predecessor and still shuts down its replacement", async () => {
    const silent = await connectExtension({ skipHello: true });
    const silentClosed = new Promise<number>((resolve) => silent.once("close", resolve));

    const replacement = await connectExtension();

    expect(await silentClosed).toBe(1006);
    expect(hub.connected).toBe(true);
    expect(hub.peer).toBe("Chromium/141 via fake-extension/1");
    const replacementClosed = new Promise<number>((resolve) => replacement.once("close", resolve));
    await hub.close();
    expect(await replacementClosed).toBe(1001);
  });

  it("shuts down after a silent raw predecessor is replaced", async () => {
    const silent = await connectSilentUpgrade();
    const replacement = await connectExtension();
    const replacementClosed = new Promise<number>((resolve) => replacement.once("close", resolve));

    try {
      await hub.close();
      expect(await replacementClosed).toBe(1001);
    } finally {
      silent.destroy();
    }
  });

  it("closes a silent socket when its hello deadline expires", async () => {
    const silent = await connectExtension({ skipHello: true });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      silent.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    expect(await closed).toEqual({ code: 1008, reason: "relay hello timed out" });
    expect(hub.connected).toBe(false);
    expect(hub.status()).toMatchObject({ peer: null, since: null });
  });

  it("takes a new connection once the first has gone", async () => {
    const first = await connectExtension();
    first.close();
    await waitFor(() => !hub.connected);
    await connectExtension();
    expect(hub.connected).toBe(true);
  });

  it("refuses an old protocol-3 extension with update guidance", async () => {
    // Watch for the close *before* sending the bad hello: the hub answers it
    // immediately, and a listener attached afterwards would miss the event and
    // wait forever.
    const socket = await connectExtension({ skipHello: true });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const priorProtocol = RELAY_PROTOCOL_VERSION - 1;
    socket.send(JSON.stringify({ t: "hello", protocol: priorProtocol }));

    const result = await closed;
    expect(result.code).toBe(4000);
    expect(result.reason).toMatch(
      new RegExp(`relay protocol ${RELAY_PROTOCOL_VERSION}, not ${priorProtocol}`, "i"),
    );
    expect(result.reason).toMatch(/update whichever.*older/i);
    await waitFor(() => !hub.connected);
  });

  it("sends a welcome as soon as the socket opens", async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${RELAY_PATH}?token=${TOKEN}`,
      [RELAY_SUBPROTOCOL],
    );
    openSockets.push(socket);
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      socket.once("error", reject);
    });
    expect(welcome).toMatchObject({
      t: "welcome",
      protocol: RELAY_PROTOCOL_VERSION,
      incarnation: INCARNATION,
    });
  });
});


describe("requests", () => {
  it("correlates replies with their requests, even out of order", async () => {
    const pending = new Map<number, () => void>();
    await connectExtension({
      onRequest: (frame) => {
        // Answer `read` late and `find` early: ids are what must sort it out.
        if (frame.op === "read") {
          pending.set(frame.id, () => undefined);
          return undefined;
        }
        return { page: { url: "https://example.com/", title: "E" }, matches: [] };
      },
    });
    const read = hub.request("read", {}, { timeoutMs: 3_000 });
    const find = hub.request("find", { query: "a", limit: 1 }, { timeoutMs: 3_000 });

    expect(await find).toMatchObject({ ok: true });
    expect(hub.status().pending).toBe(1);
    // Nothing ever answers `read`; the backstop below covers that path.
    void read.catch(() => undefined);
  });

  it("passes op, args, and timeout through verbatim", async () => {
    const seen: { op: string; args: Record<string, unknown>; timeoutMs?: number }[] = [];
    await connectExtension({
      onRequest: (frame) => {
        seen.push(frame as never);
        return { page: { url: "https://example.com/", title: "E" } };
      },
    });
    await hub.request("click", { ref: "e3" }, { timeoutMs: 12_345 });
    expect(seen[0]).toMatchObject({ op: "click", args: { ref: "e3" }, timeoutMs: 12_345 });
  });

  it("carries a structured failure back as a value, not a throw", async () => {
    await connectExtension({
      onRequest: () => {
        const error = Object.assign(new Error("nothing matched e3"), {
          failure: "element_not_found",
        });
        throw error;
      },
    });
    const reply = await hub.request("click", { ref: "e3" }, { timeoutMs: 3_000 });
    expect(reply).toEqual({
      ok: false,
      failure: "element_not_found",
      message: "nothing matched e3",
    });
  });

  it("narrows an invented failure name to something the seam knows", async () => {
    const socket = await connectExtension();
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { t: string; id: number };
      if (frame.t !== "req") return;
      socket.send(JSON.stringify({
        t: "res", id: frame.id, ok: false,
        error: { failure: "catastrophe", message: "oh no" },
      }));
    });
    const reply = await hub.request("read", {}, { timeoutMs: 3_000 });
    expect(reply).toMatchObject({ ok: false, failure: "navigation_failed", message: "oh no" });
  });

  it("gives up past the caller's own deadline and says the extension went quiet", async () => {
    await connectExtension({ onRequest: () => undefined });
    const reply = await hub.request("read", {}, { timeoutMs: 1_000 });
    expect(reply).toMatchObject({ ok: false, failure: "timeout" });
    if (reply.ok) return;
    expect(reply.message).toMatch(/did not answer read/);
    // The pending entry is cleaned up, not leaked.
    expect(hub.status().pending).toBe(0);
  }, 10_000);

  it("answers immediately when nothing is connected", async () => {
    const reply = await hub.request("open", { url: "https://example.com" }, { timeoutMs: 3_000 });
    expect(reply).toMatchObject({ ok: false, failure: "browser_unavailable" });
    if (reply.ok) return;
    expect(reply.message).toMatch(/not connected/i);
  });

  it("fails everything in flight when the browser disappears", async () => {
    const socket = await connectExtension({ onRequest: () => undefined });
    const first = hub.request("read", {}, { timeoutMs: 30_000 });
    const second = hub.request("find", { query: "x", limit: 1 }, { timeoutMs: 30_000 });
    await waitFor(() => hub.status().pending === 2);

    socket.terminate();
    for (const reply of await Promise.all([first, second])) {
      expect(reply).toMatchObject({ ok: false, failure: "browser_unavailable" });
      if (!reply.ok) expect(reply.message).toMatch(/disconnected/i);
    }
    expect(hub.status().pending).toBe(0);
  });

  it("ignores a reply to a request that already gave up", async () => {
    const socket = await connectExtension();
    let captured = 0;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { t: string; id: number };
      if (frame.t !== "req") return;
      captured = frame.id;
    });
    const reply = await hub.request("read", {}, { timeoutMs: 1_000 });
    expect(reply).toMatchObject({ ok: false, failure: "timeout" });
    // Late reply arrives; nothing should blow up and nothing should resolve twice.
    socket.send(JSON.stringify({ t: "res", id: captured, ok: true, result: {} }));
    await new Promise((done) => setTimeout(done, 50));
    expect(hub.status().pending).toBe(0);
  }, 10_000);

  it("cancels a pending request locally and ignores its late relay reply", async () => {
    const socket = await connectExtension();
    let captured = 0;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { t: string; id: number };
      if (frame.t === "req") captured = frame.id;
    });
    const controller = new AbortController();
    const request = hub.request("read", {}, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await waitFor(() => captured !== 0 && hub.status().pending === 1);

    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(hub.status().pending).toBe(0);

    socket.send(JSON.stringify({ t: "res", id: captured, ok: true, result: {} }));
    await new Promise((done) => setTimeout(done, 50));
    expect(hub.status().pending).toBe(0);
  });

  it("does not send or retain a request whose signal was already aborted", async () => {
    let requests = 0;
    await connectExtension({
      onRequest: () => {
        requests += 1;
        return {};
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(hub.request("read", {}, {
      timeoutMs: 30_000,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((done) => setTimeout(done, 50));
    expect(requests).toBe(0);
    expect(hub.status().pending).toBe(0);
  });

  it("drops an unusable frame without losing the connection", async () => {
    const socket = await connectExtension({
      onRequest: () => ({ page: { url: "https://example.com/", title: "E" } }),
    });
    socket.send("this is not JSON");
    socket.send(JSON.stringify({ t: "res" }));
    socket.send(JSON.stringify({ t: "made-up" }));
    expect(hub.connected).toBe(true);
    expect(await hub.request("read", {}, { timeoutMs: 3_000 })).toMatchObject({ ok: true });
  });

  it("closes before parsing a relay message beyond the screenshot budget", async () => {
    const socket = await connectExtension();
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send("x".repeat(MAX_RELAY_MESSAGE_BYTES + 1));

    expect(await closed).toBe(1009);
    await waitFor(() => !hub.connected);
  }, 10_000);
});


describe("shutdown", () => {
  it("hangs up on the browser and refuses new upgrades", async () => {
    const socket = await connectExtension();
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    await hub.close();
    expect(await closed).toBe(1001);
    expect(hub.connected).toBe(false);

    const error = await expectUpgradeRefused();
    expect(error.message).toMatch(/503/);
  });

  it("force-terminates an upgraded peer that never answers the close handshake", async () => {
    const silent = await connectSilentUpgrade();
    const started = Date.now();

    try {
      await hub.close();
    } finally {
      silent.destroy();
    }

    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    expect(hub.status()).toMatchObject({ connected: false, peer: null, since: null });
  });

  it("force-terminates a relay socket whose close handshake never settles", async () => {
    let onClose: (() => void) | undefined;
    let terminations = 0;
    await closeRelaySocket({
      readyState: 1,
      CLOSED: 3,
      once: (_event, listener) => {
        onClose = listener;
      },
      close: () => {},
      terminate: () => {
        terminations += 1;
        onClose?.();
      },
    }, 10);

    expect(terminations).toBe(1);
  });
});


describe("the relay can be turned off entirely", () => {
  it.each(["0", "off", "false", "NO"])("GHOSTD_RELAY=%s builds no hub", (value) => {
    expect(createRelayHub({ env: { GHOSTD_RELAY: value }, token: TOKEN })).toBeUndefined();
  });

  it("builds one otherwise", () => {
    const built = createRelayHub({ env: {}, token: TOKEN });
    expect(built).toBeInstanceOf(RelayHub);
    void built?.close();
  });
});
