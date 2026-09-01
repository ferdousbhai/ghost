import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { RemoteServe, type RemoteStatus } from "../src/remote-serve.js";
import { REMOTE_MANIFEST } from "../src/remote-viewer.js";
import { SessionHost } from "../src/session-host.js";
import { RemoteAccess, type RemoteAccessOptions } from "../src/tailscale-identity.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

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
): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  const homeOperations = new HomeOperationCoordinator(temp.registry);
  host = new SessionHost({ registry: temp.registry, homeOperations, ownerHome: temp.ownerHome, offline: true });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    homeOperations,
    port: 0,
    apiToken: TOKEN,
    remote: remote === null ? null : new RemoteAccess({ selfLogin: async () => "Owner@Example.com", ...remote }),
    ...(remoteServe ? { remoteServe: remoteServe(temp.root) } : {}),
  });
  return `http://127.0.0.1:${listening.port}`;
}

const asTailnet = (login: string, extra: Record<string, string> = {}) => ({
  "tailscale-user-login": login,
  "tailscale-user-name": "Some One",
  ...extra,
});

function remoteStatus(enabled: boolean): RemoteStatus {
  return {
    enabled,
    state: enabled ? "on" : "off",
    scheme: enabled ? "https" : null,
    hostname: "ghostbox.example.ts.net",
    url: enabled ? "https://ghostbox.example.ts.net/" : null,
    tailscale: {
      installed: true,
      running: true,
      loggedIn: true,
      operator: true,
      certs: true,
    },
    guests: "read-only",
    owner: "owner@example.com",
    problem: null,
  };
}

class FakeRemoteServe extends RemoteServe {
  readonly mutations: boolean[] = [];
  current: RemoteStatus;

  constructor(enabled: boolean, configPath: string) {
    super(7717, { configPath, run: async () => { throw new Error("fake runner should not be called"); } });
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

  override async qrSvg(url: string): Promise<string> {
    return `<svg data-url="${url}"></svg>`;
  }
}

/** A server over a fake RemoteServe that persists `remote.enabled` into the temp root. */
async function serveFake(enabled: boolean): Promise<{ fake: FakeRemoteServe; base: string }> {
  let fake!: FakeRemoteServe;
  const base = await serve({}, (root) => {
    fake = new FakeRemoteServe(enabled, join(root, "config.json"));
    return fake;
  });
  return { fake, base };
}

describe("tailnet identity", () => {
  it("admits the owner fully and guests read-only", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/ghosts`)).status).toBe(401);

    const guest = await fetch(`${base}/api/remote/whoami`, { headers: asTailnet("guest@example.com") });
    expect(await guest.json()).toEqual({ login: "guest@example.com", role: "guest", name: "Some One" });
    expect((await fetch(`${base}/api/ghosts`, { headers: asTailnet("guest@example.com") })).status).toBe(200);
    const write = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { ...asTailnet("guest@example.com"), "content-type": "application/json" },
      body: JSON.stringify({ name: "intruder" }),
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { code: "read_only" } });

    expect(await (await fetch(`${base}/api/remote/whoami`, { headers: asTailnet("owner@example.com") })).json())
      .toMatchObject({ login: "owner@example.com", role: "owner" });
    const create = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { ...asTailnet("OWNER@example.com"), "content-type": "application/json", origin: `http://127.0.0.1:${listening!.port}` },
      body: JSON.stringify({ name: "owner-created" }),
    });
    expect(create.status).toBe(201);
    expect((await fetch(`${base}/api/ghosts`, { headers: asTailnet("owner@example.com", { origin: "https://evil.example" }) })).status).toBe(403);

    expect(await (await fetch(`${base}/api/remote/whoami`, { headers: { authorization: `Bearer ${TOKEN}` } })).json())
      .toEqual({ login: null, role: "owner" });
  });

  it("keeps local resource paths owner-only even though the route is read-only", async () => {
    const base = await serve();
    const response = await fetch(
      `${base}/api/ghosts/casper/sessions/${encodeURIComponent("pi:resources")}/resources`,
      { headers: asTailnet("guest@example.com") },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "owner_only" } });
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

  it("serves the viewer page at / with a hashed CSP", async () => {
    const base = await serve();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'; style-src 'sha256-/);
    expect(await page.text()).toContain("/remote/whoami");
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/remote`)).status).toBe(404);
  });

  it("serves the web app manifest without authentication", async () => {
    const base = await serve();
    const response = await fetch(`${base}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(await response.json()).toEqual(REMOTE_MANIFEST);
  });
});

describe("remote management", () => {
  it("gets status and persists owner POST changes", async () => {
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
    expect(JSON.parse(readFileSync(join(temp!.root, "config.json"), "utf8")))
      .toEqual({ remote: { enabled: true } });
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

  it("serves a no-store QR only while remote access is on", async () => {
    const { fake, base } = await serveFake(true);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const qr = await fetch(`${base}/api/remote/qr.svg`, { headers });
    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toContain("image/svg+xml");
    expect(qr.headers.get("cache-control")).toBe("no-store");
    expect(await qr.text()).toContain("https://ghostbox.example.ts.net/");

    fake.current = remoteStatus(false);
    const off = await fetch(`${base}/api/remote/qr.svg`, { headers });
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("has no remote routes on a server built without a RemoteServe", async () => {
    const base = await serve();
    const headers = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${base}/api/remote`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/api/remote/qr.svg`, { headers })).status).toBe(404);
  });
});
