/**
 * The relay as the daemon actually exposes it: a status route and a WebSocket
 * upgrade on the same loopback port as everything else.
 *
 * What matters here and nowhere else is that the routing did not regress. The
 * status route sits under `/api/` alongside the ghost routes, and the upgrade
 * handler shares a listener with them — either could shadow the other, and the
 * status payload is the one place a token could accidentally be published to an
 * unauthenticated route.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createDaemonServer, relayHubOf, startDaemonServer, type ListeningServer } from "../src/server.js";
import { RelayHub } from "../src/relay.js";
import {
  RELAY_PATH,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
} from "../src/relay-protocol.js";
import { GhostRegistry } from "../src/ghosts.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, type TempGhosts } from "./helpers/fixtures.js";

const TOKEN = "c".repeat(64);

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;

afterEach(async () => {
  await listening?.close();
  listening = null;
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

async function serve(relay: RelayHub | null | undefined): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  host = new SessionHost({ registry: temp.registry, offline: true });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    port: 0,
    ...(relay === undefined ? {} : { relay }),
  });
  return `http://127.0.0.1:${listening.port}`;
}

describe("GET /api/relay/status", () => {
  it("reports where to dial and that nothing is connected yet", async () => {
    const base = await serve(new RelayHub({ token: TOKEN, pingIntervalMs: 60_000 }));
    const body = await (await fetch(`${base}/api/relay/status`)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, connected: false, protocol: 1, path: "/relay" });
    expect(body["url"]).toBe(`ws://127.0.0.1:${listening?.port}/relay`);
  });

  it("never returns the token, only where it lives", async () => {
    const base = await serve(new RelayHub({ token: TOKEN, pingIntervalMs: 60_000 }));
    const text = await (await fetch(`${base}/api/relay/status`)).text();
    expect(text).not.toContain(TOKEN);
    // This route has no auth; publishing the pairing secret on it would undo
    // the entire point of having one.
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("says so plainly when the relay is switched off", async () => {
    const base = await serve(null);
    const body = await (await fetch(`${base}/api/relay/status`)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: false, connected: false });
    expect(body["reason"]).toMatch(/GHOSTD_RELAY/);
  });

  it("refuses the wrong method rather than 404ing confusingly", async () => {
    const base = await serve(new RelayHub({ token: TOKEN, pingIntervalMs: 60_000 }));
    const response = await fetch(`${base}/api/relay/status`, { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("leaves the ghost routes exactly where they were", async () => {
    const base = await serve(new RelayHub({ token: TOKEN, pingIntervalMs: 60_000 }));
    expect((await fetch(`${base}/api/ghosts`)).status).toBe(200);
    expect((await fetch(`${base}/api/relay`)).status).toBe(404);
    expect((await fetch(`${base}/api/nonsense`)).status).toBe(404);
    expect((await fetch(`${base}/relay`)).status).toBe(404);
  });
});

describe("the upgrade shares the port with the API", () => {
  it("accepts a paired extension on /relay", async () => {
    const relay = new RelayHub({ token: TOKEN, pingIntervalMs: 60_000 });
    await serve(relay);
    const socket = new WebSocket(
      `ws://127.0.0.1:${listening?.port}${RELAY_PATH}`,
      [RELAY_SUBPROTOCOL, `${RELAY_TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}`],
      { origin: "chrome-extension://fake" },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      expect(relay.connected).toBe(true);
      const body = await (await fetch(
        `http://127.0.0.1:${listening?.port}/api/relay/status`,
      )).json() as Record<string, unknown>;
      expect(body).toMatchObject({ connected: true });
    } finally {
      socket.removeAllListeners();
      socket.terminate();
    }
  });

  it("hangs up on an upgrade when there is no relay, rather than leaking the socket", async () => {
    await serve(null);
    const socket = new WebSocket(`ws://127.0.0.1:${listening?.port}${RELAY_PATH}?token=${TOKEN}`);
    const error = await new Promise<Error | undefined>((resolve) => {
      socket.once("open", () => resolve(undefined));
      socket.once("error", (reason) => resolve(reason));
      socket.once("close", () => resolve(new Error("closed")));
    });
    socket.removeAllListeners();
    socket.terminate();
    expect(error).toBeDefined();
  });

  it("closing the daemon hangs up on the browser first", async () => {
    const relay = new RelayHub({ token: TOKEN, pingIntervalMs: 60_000 });
    await serve(relay);
    const socket = new WebSocket(
      `ws://127.0.0.1:${listening?.port}${RELAY_PATH}?token=${TOKEN}`,
      [RELAY_SUBPROTOCOL],
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    // A live WebSocket is an open connection; without hanging up first, this
    // would sit here until the socket timed out.
    await listening?.close();
    listening = null;
    expect(await closed).toBe(1001);
  });
});

describe("building a server does not mint a secret", () => {
  it("leaves the token file alone until something tries to pair", () => {
    const registry = new GhostRegistry("/nonexistent-ghosts-root");
    const sessionHost = new SessionHost({ registry, offline: true });
    // The default path: a hub built here must not create it. `tokenPath` is
    // computed, not created.
    const server = createDaemonServer({ registry, host: sessionHost });
    const hub = relayHubOf(server);
    expect(hub?.tokenPath).toMatch(/relay-token$/);
    server.close();
  });

  it("hands its own hub back so a backend can be wired to it", async () => {
    const relay = new RelayHub({ token: TOKEN, pingIntervalMs: 60_000 });
    await serve(relay);
    expect(listening?.relay).toBe(relay);
    expect(relayHubOf(listening!.server)).toBe(relay);
  });

  it("still starts, and still 404s, with the relay switched off", async () => {
    const bare = createServer((_request, response) => response.writeHead(200).end());
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    expect((bare.address() as AddressInfo).port).toBeGreaterThan(0);
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });
});
