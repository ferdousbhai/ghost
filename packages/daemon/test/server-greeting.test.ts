/**
 * `POST /api/ghosts/:name/greeting` — the empty-chat opener.
 *
 * Ghost writes no greeting of its own any more; the route stays because the
 * shell codes against it for the first-meeting state. The contract is narrow:
 * 200 with `{ greeting: null, onboarding }` whenever the ghost exists, and a
 * 404 only for a ghost that is not there. An unreadable character must never
 * reach the shell as a 5xx.
 */
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ghostPaths } from "../src/ghosts.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

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

async function serve(options: { written?: boolean } = {}): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  if (options.written) {
    seedGhost(temp.root, { name: "casper" });
  } else {
    // The registry's own `create` is the only writer of the seed, and a seeded
    // character.md is precisely what "never been met" means.
    temp.registry.create("casper");
  }
  host = new SessionHost({
    registry: temp.registry,
    ownerHome: temp.ownerHome,
    scheduleUnitDir: join(temp.ownerHome, ".config", "systemd", "user"),
    scheduleRuntimeUnitDir: join(temp.ownerHome, ".runtime", "systemd", "user"),
    scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    port: 0,
    relay: null,
    // Routing is the subject here; auth has its own file.
    apiToken: null,
  });
  return `http://127.0.0.1:${listening.port}`;
}

async function postGreeting(
  base: string,
  ghost = "casper",
  body: string | undefined = "{}",
): Promise<{ status: number; body: { greeting?: unknown; onboarding?: unknown; error?: unknown } }> {
  const response = await fetch(`${base}/api/ghosts/${ghost}/greeting`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  return { status: response.status, body: await response.json() as never };
}

describe("POST /api/ghosts/:name/greeting", () => {
  it("answers 200 with a null greeting for a ghost the owner has met", async () => {
    const base = await serve({ written: true });
    expect(await postGreeting(base)).toEqual({ status: 200, body: { greeting: null, onboarding: false } });
  });

  it("accepts a request with no body at all", async () => {
    const base = await serve({ written: true });
    expect(await postGreeting(base, "casper", undefined)).toEqual({
      status: 200,
      body: { greeting: null, onboarding: false },
    });
  });

  it("reports onboarding while character.md is still the seed, and not once it is written", async () => {
    const base = await serve();
    expect(await postGreeting(base)).toEqual({ status: 200, body: { greeting: null, onboarding: true } });
    seedGhost(temp!.root, { name: "casper" });
    expect((await postGreeting(base)).body.onboarding).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("keeps the route at 200, not onboarding, when the character cannot be read", async () => {
    const base = await serve();
    const { characterFile } = ghostPaths(join(temp!.root, "casper"));
    chmodSync(characterFile, 0o000);
    try {
      expect(await postGreeting(base)).toEqual({ status: 200, body: { greeting: null, onboarding: false } });
    } finally {
      chmodSync(characterFile, 0o600);
    }
  });

  it("404s for a ghost that does not exist", async () => {
    const base = await serve({ written: true });
    const { status, body } = await postGreeting(base, "nobody");
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: "not_found" });
  });

  it("405s for anything but POST", async () => {
    const base = await serve({ written: true });
    const response = await fetch(`${base}/api/ghosts/casper/greeting`);
    expect(response.status).toBe(405);
  });
});
