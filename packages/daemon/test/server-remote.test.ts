import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { RemoteServe, type RemoteStatus } from "../src/remote-serve.js";
import { SessionHost } from "../src/session-host.js";
import type { RunningSource } from "../src/running-source.js";
import { RemoteAccess, type RemoteAccessOptions } from "../src/tailscale-identity.js";
import { makeTempGhosts, seedGhost, type TempGhosts, serverServices } from "./helpers/fixtures.js";
import { fakeHarness, onlyHarnesses, replies } from "./helpers/fake-harness.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";
import { fakeTailscale, missingBinary } from "./helpers/fake-tailscale.js";

const TOKEN = "t".repeat(64);

let temp: TempGhosts | null = null;
let listening: ListeningServer | null = null;
let host: SessionHost | null = null;

async function stop(): Promise<void> {
  await listening?.close();
  await host?.disposeAll();
  temp?.cleanup();
  listening = null; host = null; temp = null;
}
afterEach(stop);

async function serve(
  remote: RemoteAccessOptions | null = {},
  remoteServe?: (root: string) => RemoteServe,
  runningSource?: RunningSource,
  remoteApps?: readonly string[],
): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  host = new SessionHost({ registry: temp.registry, ownerHome: temp.ownerHome });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    ...serverServices(temp.registry),
    port: 0,
    apiToken: TOKEN,
    remote: remote === null ? null : new RemoteAccess({ selfLogin: async () => "Owner@Example.com", guests: "read-only", ...remote }),
    ...(remoteServe ? { remoteServe: remoteServe(temp.root) } : {}),
    ...(runningSource ? { runningSource } : {}),
    ...(remoteApps ? { remoteApps } : {}),
  });
  return `http://127.0.0.1:${listening.port}`;
}

const asTailnet = (login: string, extra: Record<string, string> = {}) => ({
  "tailscale-user-login": login,
  ...extra,
});

function remoteStatus(enabled: boolean): RemoteStatus {
  return {
    state: enabled ? "on" : "off",
    hostname: "ghostbox.example.ts.net",
    guests: "read-only",
    owner: "owner@example.com",
    app: null,
    problem: null,
  };
}

class FakeRemoteServe extends RemoteServe {
  readonly mutations: boolean[] = [];
  current: RemoteStatus;

  constructor(enabled: boolean) {
    super(7717, { run: async () => { throw new Error("fake runner should not be called"); } });
    this.current = remoteStatus(enabled);
  }

  override async status(): Promise<RemoteStatus> {
    return this.current;
  }

  override async enable(): Promise<RemoteStatus> {
    this.mutations.push(true);
    this.current = remoteStatus(true);
    return this.current;
  }

  override async disable(): Promise<RemoteStatus> {
    this.mutations.push(false);
    this.current = remoteStatus(false);
    return this.current;
  }
}

/** A server over a fake RemoteServe. */
async function serveFake(enabled: boolean): Promise<{ fake: FakeRemoteServe; base: string }> {
  let fake!: FakeRemoteServe;
  const base = await serve({}, () => {
    fake = new FakeRemoteServe(enabled);
    return fake;
  });
  return { fake, base };
}

describe("tailnet identity", () => {
  it("admits the owner fully and guests read-only", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/ghosts`)).status).toBe(401);

    const guest = await fetch(`${base}/api/remote/whoami`, { headers: asTailnet("guest@example.com") });
    expect(await guest.json()).toEqual({ role: "guest" });
    const guestGhosts = await fetch(`${base}/api/ghosts`, { headers: asTailnet("guest@example.com") });
    expect(guestGhosts.status).toBe(200);
    // A guest sees names, never a ghost home's path; the owner sees both.
    expect(await guestGhosts.json()).toEqual([{ name: "casper" }]);
    const ownerGhosts = await (await fetch(`${base}/api/ghosts`, { headers: asTailnet("owner@example.com") })).json() as unknown[];
    expect(ownerGhosts[0]).toHaveProperty("dir");
    const write = await fetch(`${base}/api/ghosts/casper/character`, {
      method: "PUT",
      headers: { ...asTailnet("guest@example.com"), "content-type": "application/json" },
      body: JSON.stringify({ body: "# Intruder\n" }),
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { code: "read_only" } });
    const attach = await fetch(`${base}/api/ghosts/casper/sessions/remote-1/attachments`, {
      method: "POST",
      headers: { ...asTailnet("guest@example.com"), "content-type": "image/png" },
      body: Buffer.from("89504e47", "hex"),
    });
    expect(attach.status).toBe(403);
    const copy = await fetch(`${base}/api/ghosts/casper/sessions/remote-1/attachments`, {
      method: "POST",
      headers: { ...asTailnet("owner@example.com"), "content-type": "application/json", origin: `http://127.0.0.1:${listening!.port}` },
      body: JSON.stringify({ path: "/etc/hostname" }),
    });
    expect(await copy.json()).toMatchObject({ error: { code: "local_only" } });

    expect(await (await fetch(`${base}/api/remote/whoami`, { headers: asTailnet("owner@example.com") })).json())
      .toEqual({ role: "owner" });
    const ownerWrite = await fetch(`${base}/api/ghosts/casper/character`, {
      method: "PUT",
      headers: { ...asTailnet("OWNER@example.com"), "content-type": "application/json", origin: `http://127.0.0.1:${listening!.port}` },
      body: JSON.stringify({ body: "# Casper\n" }),
    });
    expect(ownerWrite.status).toBe(200);
    expect((await fetch(`${base}/api/ghosts`, { headers: asTailnet("owner@example.com", { origin: "https://evil.example" }) })).status).toBe(403);

    expect(await (await fetch(`${base}/api/remote/whoami`, { headers: { authorization: `Bearer ${TOKEN}` } })).json())
      .toEqual({ role: "owner" });
  });

  it("shows the owner what runs the daemon and refuses a guest the source path", async () => {
    const runningSource: RunningSource = {
      version: "1.4.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      root: "/home/owner/src/ghost",
      entry: fileURLToPath(import.meta.url),
      startedAt: Date.now(),
    };
    const base = await serve({}, undefined, runningSource);

    const owner = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({
      version: "1.4.0",
      source: { commit: runningSource.commit, root: runningSource.root },
      startedAt: new Date(runningSource.startedAt).toISOString(),
      restartNeeded: false,
    });

    const guest = await fetch(`${base}/api/status`, { headers: asTailnet("guest@example.com") });
    expect(guest.status).toBe(403);
    expect(await guest.json()).toMatchObject({ error: { code: "owner_only" } });
  });

  it("refuses guests the hook commands, the owner's sources, and hook completions", async () => {
    const base = await serve();
    for (const path of ["/api/hooks/config", "/api/sources", "/api/connections", "/api/sources/notes/items", "/api/sources/files/items/x", "/api/sources/photos/items/x/picture", "/api/search?q=x"]) {
      const guest = await fetch(`${base}${path}`, { headers: asTailnet("guest@example.com") });
      expect(guest.status).toBe(403);
      expect(await guest.json()).toMatchObject({ error: { code: "owner_only" } });
    }
    // Owner-only writes need no route guard: every guest write is refused first.
    for (const path of ["/api/ghosts/casper/complete", "/api/ghosts/casper/messages"]) {
      const guest = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { ...asTailnet("guest@example.com"), "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Spend the owner's subscription." }),
      });
      expect(guest.status).toBe(403);
      expect(await guest.json()).toMatchObject({ error: { code: "read_only" } });
    }
  });

  it("honours guests: none and a configured owner login", async () => {
    const base = await serve({ guests: "none", owner: "guest@example.com" });
    expect((await fetch(`${base}/api/ghosts`, { headers: asTailnet("owner@example.com") })).status).toBe(401);
    expect(await (await fetch(`${base}/api/remote/whoami`, { headers: asTailnet("guest@example.com") })).json())
      .toMatchObject({ role: "owner" });
  });

  it("admits no identity when the server has no RemoteAccess", async () => {
    const base = await serve(null);
    expect((await fetch(`${base}/api/ghosts`, { headers: asTailnet("owner@example.com") })).status).toBe(401);
  });

  it("serves no page: everything outside /api is a 404", async () => {
    const base = await serve();
    for (const path of ["/", "/manifest.webmanifest", "/remote"]) {
      const response = await fetch(`${base}${path}`, { headers: asTailnet("owner@example.com") });
      expect(response.status, path).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("refuses a page on the tailnet host itself: only loopback and remote.apps are origins", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`, {
      headers: asTailnet("owner@example.com", { origin: "https://ghostbox.example.ts.net", host: "ghostbox.example.ts.net" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden_origin" } });
  });
});

describe("remote management", () => {
  it("gets status and applies owner POST changes", async () => {
    const { fake, base } = await serveFake(false);
    const headers = { authorization: `Bearer ${TOKEN}` };

    expect(await (await fetch(`${base}/api/remote`, { headers })).json())
      .toEqual(remoteStatus(false));
    const response = await fetch(`${base}/api/remote`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(remoteStatus(true));
    expect(fake.mutations).toEqual([true]);
  });

  it("rejects malformed changes and guest writes", async () => {
    const { fake, base } = await serveFake(false);
    const invalid = await fetch(`${base}/api/remote`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });

    const guest = await fetch(`${base}/api/remote`, {
      method: "POST",
      headers: { ...asTailnet("guest@example.com"), "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(guest.status).toBe(403);
    expect(await guest.json()).toMatchObject({ error: { code: "read_only" } });
    expect(fake.mutations).toEqual([]);
  });

});


const APP = "https://summonghost.com";

describe("a web app in remote.apps", () => {
  const fromApp = (login: string | null, extra: Record<string, string> = {}) =>
    ({ origin: APP, ...(login ? asTailnet(login) : {}), ...extra });

  it("is admitted by tailnet identity, with CORS for its origin", async () => {
    const base = await serve({}, undefined, undefined, [APP]);
    const owner = await fetch(`${base}/api/ghosts`, { headers: fromApp("owner@example.com") });
    expect(owner.status).toBe(200);
    expect(owner.headers.get("access-control-allow-origin")).toBe(APP);
    expect(owner.headers.get("vary")).toBe("origin");
    expect(owner.headers.get("access-control-allow-credentials")).toBeNull();

    const anonymous = await fetch(`${base}/api/ghosts`, { headers: fromApp(null) });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("access-control-allow-origin")).toBe(APP);
  });

  it("refuses the bearer token from an app origin, even the right one", async () => {
    const base = await serve({}, undefined, undefined, [APP]);
    for (const headers of [fromApp(null, { authorization: `Bearer ${TOKEN}` }), fromApp("owner@example.com", { authorization: `Bearer ${TOKEN}` })]) {
      const response = await fetch(`${base}/api/ghosts`, { headers });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "app_token_refused" } });
    }
  });

  it("answers the preflight with the app's methods and headers, and private network when asked", async () => {
    const base = await serve({}, undefined, undefined, [APP]);
    const preflight = await fetch(`${base}/api/ghosts/casper/messages`, {
      method: "OPTIONS",
      headers: { origin: APP, "access-control-request-method": "POST", "access-control-request-private-network": "true" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(APP);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");

    const plain = await fetch(`${base}/api/ghosts`, { method: "OPTIONS", headers: { origin: APP } });
    expect(plain.headers.get("access-control-allow-private-network")).toBeNull();
    // A loopback client may still be offered the token header, and is never offered private network.
    const local = await fetch(`${base}/api/ghosts`, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-private-network": "true" } });
    expect(local.headers.get("access-control-allow-headers")).toBe("content-type, authorization");
    expect(local.headers.get("access-control-allow-private-network")).toBeNull();
  });

  it("keeps a guest calling through the app read-only", async () => {
    const base = await serve({}, undefined, undefined, [APP]);
    expect((await fetch(`${base}/api/ghosts`, { headers: fromApp("guest@example.com") })).status).toBe(200);
    const write = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: fromApp("guest@example.com", { "content-type": "application/json" }),
      body: JSON.stringify({ name: "wraith" }),
    });
    expect(await write.json()).toMatchObject({ error: { code: "read_only" } });
  });

  it("is an ordinary foreign origin when not listed, or when remote.apps is empty", async () => {
    for (const apps of [["https://lab.summonghost.com"], []]) {
      const base = await serve({}, undefined, undefined, apps);
      const response = await fetch(`${base}/api/ghosts`, { headers: fromApp("owner@example.com") });
      expect(response.status, JSON.stringify(apps)).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "forbidden_origin" } });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      await stop();
    }
  });
});

describe("the summonghost.com app's routes", () => {
  it("answers each one the app calls, admitted by tailnet identity alone", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    host = new SessionHost({ registry: temp.registry, ownerHome: temp.ownerHome, ...onlyHarnesses(fakeHarness(replies("hello"))) });
    listening = await startDaemonServer({
      registry: temp.registry, host, ...serverServices(temp.registry), port: 0, apiToken: TOKEN,
      remote: new RemoteAccess({ selfLogin: async () => "owner@example.com" }),
      remoteServe: new RemoteServe(7717, { run: fakeTailscale().run }),
      remoteApps: [APP],
    });
    const base = `http://127.0.0.1:${listening.port}/api`;
    const owner = { origin: APP, ...asTailnet("owner@example.com") };
    const json = { ...owner, "content-type": "application/json" };
    const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { headers: owner, ...init });
    const conversation = "/ghosts/casper/sessions/app-1";

    expect(await (await call("/remote/whoami")).json()).toEqual({ role: "owner" });
    expect((await call("/remote/machines")).status).toBe(200);
    expect((await call("/ghosts")).status).toBe(200);
    const events = new AbortController();
    // An EventSource stays open, so this one is read with the streaming fetch.
    const stream = await globalThis.fetch(`${base}/ghosts/casper/events`, { headers: owner, signal: events.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("access-control-allow-origin")).toBe(APP);
    events.abort();
    await stream.body?.cancel().catch(() => {});

    const turn = await call("/ghosts/casper/messages", { method: "POST", headers: json, body: JSON.stringify({ prompt: "hi", sessionId: "app-1" }) });
    expect(turn.status).toBe(200);
    expect(await turn.text()).toContain("hello");
    expect(await (await call("/ghosts/casper/sessions")).json()).toMatchObject({ sessions: [{ id: "app-1" }] });
    const transcript = await (await call(`${conversation}/transcript`)).json() as { readThrough: string };
    expect((await call(`${conversation}/transcript?offset=0`)).status).toBe(200);
    expect((await call(`${conversation}/read`, { method: "PUT", headers: json, body: JSON.stringify({ readThrough: transcript.readThrough }) })).status).toBe(200);
    expect((await call(`${conversation}/pin`, { method: "PUT", headers: json, body: JSON.stringify({ pinned: true }) })).status).toBe(200);
    const attached = await call(`${conversation}/attachments`, {
      method: "POST", headers: { ...owner, "content-type": "image/png" }, body: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    });
    expect(attached.status).toBe(201);
    const { path } = await attached.json() as { path: string };
    expect((await call(`${conversation}/${path}`)).status).toBe(200);
    expect(await (await call(`${conversation}/queue`)).json()).toMatchObject({ streaming: false });
    // Idle, so these answer the contract's idle refusal rather than an auth or routing one.
    for (const [path, body] of [["/queue", { text: "more" }], ["/stop", {}]] as const) {
      const response = await call(`${conversation}${path}`, { method: "POST", headers: json, body: JSON.stringify(body) });
      expect(await response.json(), path).toMatchObject({ error: { code: "session_not_streaming" } });
    }
    expect(await (await call(`${conversation}/stream?turn=gone&from=0`)).json()).toMatchObject({ error: { code: "turn_not_found" } });
    expect((await call(conversation, { method: "DELETE" })).status).toBe(200);
  });
});

describe("GET /api/remote/machines", () => {
  it("lists the owner's other machines to the owner, and to no guest", async () => {
    const base = await serve({}, () => new RemoteServe(7717, { run: fakeTailscale().run }), undefined, [APP]);
    const response = await fetch(`${base}/api/remote/machines`, { headers: { origin: APP, ...asTailnet("owner@example.com") } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ machines: [
      { hostname: "laptop.example.ts.net", online: true },
      { hostname: "phone.example.ts.net", online: false },
    ] });
    expect((await fetch(`${base}/api/remote/machines`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    const guest = await fetch(`${base}/api/remote/machines`, { headers: asTailnet("guest@example.com") });
    expect(await guest.json()).toMatchObject({ error: { code: "owner_only" } });
  });

  it("is a 503 when Tailscale does not answer", async () => {
    const base = await serve({}, () => new RemoteServe(7717, { run: missingBinary() }));
    const response = await fetch(`${base}/api/remote/machines`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "tailscale_unavailable" } });
  });
});
