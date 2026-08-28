import { afterEach, describe, expect, it } from "vitest";
import { DocumentsService } from "../src/documents.js";
import { HomeOperationCoordinator } from "../src/home-operations.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
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

async function serve(remote: RemoteAccessOptions | null = {}): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  const homeOperations = new HomeOperationCoordinator(temp.registry);
  host = new SessionHost({ registry: temp.registry, homeOperations, ownerHome: temp.ownerHome, offline: true });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    documents: new DocumentsService(),
    homeOperations,
    port: 0,
    apiToken: TOKEN,
    remote: remote === null ? null : new RemoteAccess({ selfLogin: async () => "Owner@Example.com", ...remote }),
  });
  return `http://127.0.0.1:${listening.port}`;
}

const asTailnet = (login: string, extra: Record<string, string> = {}) => ({
  "tailscale-user-login": login,
  "tailscale-user-name": "Some One",
  ...extra,
});

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
    const plan = await fetch(`${base}/api/ghosts/casper/sessions/${encodeURIComponent("pi:conv-1")}/plan`, {
      method: "POST",
      headers: { ...asTailnet("OWNER@example.com"), "content-type": "application/json", origin: `http://127.0.0.1:${listening!.port}` },
      body: JSON.stringify({ action: "start" }),
    });
    expect(plan.status).toBe(200);
    expect((await fetch(`${base}/api/ghosts`, { headers: asTailnet("owner@example.com", { origin: "https://evil.example" }) })).status).toBe(403);

    expect(await (await fetch(`${base}/api/remote/whoami`, { headers: { authorization: `Bearer ${TOKEN}` } })).json())
      .toEqual({ login: null, role: "owner" });
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
});
