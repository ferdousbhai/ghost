/**
 * The API's authentication, over a real listening loopback server.
 *
 * The hole this closes (issue #485) is not exotic: binding to `127.0.0.1` keeps
 * the *network* out and does nothing about the browser already running as the
 * same user. A page the owner visits can POST `text/plain` to
 * `http://127.0.0.1:7717/api/ghosts/casper/messages` with no preflight, because
 * a simple request never asks permission — CORS only decides whether the page
 * may *read* the answer, and the attacker does not care about the answer. These
 * tests pin the three checks that make that request fail, and the two
 * deliberate exemptions that must not be widened.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiTokenCommand,
  API_TOKEN_PATTERN,
  defaultApiTokenPath,
  readApiToken,
  readOrCreateApiToken,
  rotateApiToken,
} from "../src/api-token.js";
import { GHOST_SESSION_STOP_CONTINUATION_CAP } from "../src/hooks.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);

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

async function serve(apiToken: string | null = TOKEN): Promise<string> {
  temp = makeTempGhosts();
  temp.registry.ensureRoot();
  seedGhost(temp.root, { name: "casper" });
  host = new SessionHost({ registry: temp.registry, offline: true });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    port: 0,
    relay: null,
    apiToken,
  });
  return `http://127.0.0.1:${listening.port}`;
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("the bearer token", () => {
  it("refuses a request that presents none", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`);
    expect(response.status).toBe(401);
    // Without this a client cannot tell "wrong token" from "wrong route".
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toMatch(/ghostd api-token/);
  });

  it("refuses a request that presents the wrong one", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`, {
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });

  it("refuses a token smuggled somewhere other than the Authorization header", async () => {
    const base = await serve();
    // A query parameter would land in logs and in `Referer`; only the header
    // counts.
    expect((await fetch(`${base}/api/ghosts?token=${TOKEN}`)).status).toBe(401);
    expect((await fetch(`${base}/api/ghosts`, {
      headers: { "x-ghost-api-token": TOKEN },
    })).status).toBe(401);
  });

  it("lets the real one through", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(1);
    const hooks = await fetch(`${base}/api/hooks`, { headers: auth });
    expect(hooks.status).toBe(200);
    expect(await hooks.json()).toEqual({
      active: false,
      total: 0,
      events: [],
      hooks: [],
      sessionStopContinuationCap: GHOST_SESSION_STOP_CONTINUATION_CAP,
    });
  });

  it("accepts the scheme case-insensitively, as RFC 7235 requires", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/ghosts`, {
      headers: { authorization: `bearer ${TOKEN}` },
    })).status).toBe(200);
  });

  it("guards every route, not just the mutating ones", async () => {
    const base = await serve();
    for (const path of [
      "/api/ghosts",
      "/api/ghosts/casper/sessions",
      "/api/ghosts/casper/model",
      "/api/ghosts/casper/models",
      "/api/ghosts/casper/providers",
      "/api/ghosts/casper/sessions/pi%3Adraft/project/draft",
      "/api/hooks",
      "/api/nonsense",
    ]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401);
    }
  });

  it("can be switched off, but only deliberately", async () => {
    const base = await serve(null);
    expect((await fetch(`${base}/api/ghosts`)).status).toBe(200);
  });
});

describe("the Origin check", () => {
  it("refuses a foreign origin even when the token is right", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`, {
      headers: { ...auth, origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("forbidden_origin");
  });

  it("refuses a foreign origin before it even looks at the token", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("still allows a loopback origin — a dev UI is a different origin", async () => {
    const base = await serve();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:7717"]) {
      const response = await fetch(`${base}/api/ghosts`, { headers: { ...auth, origin } });
      expect(response.status, origin).toBe(200);
    }
  });

  it("allows a request with no Origin at all — that is what a file-reading client sends", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/ghosts`, { headers: auth })).status).toBe(200);
  });
});

describe("the content type of a mutating request", () => {
  it("refuses the text/plain POST that is the whole CSRF vector", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/casper/messages`, {
      method: "POST",
      // Even holding the token, this shape must not be reachable: it is the
      // one a cross-site form post can produce without a preflight.
      headers: { ...auth, "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ model: "ghost/casper", context: { messages: [] } }),
    });
    expect(response.status).toBe(415);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("unsupported_media_type");
  });

  it("refuses the other two simple-request types as well", async () => {
    const base = await serve();
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = await fetch(`${base}/api/ghosts`, {
        method: "POST",
        headers: { ...auth, "content-type": type },
        body: "name=ghoul",
      });
      expect(response.status, type).toBe(415);
    }
  });

  it("refuses a POST with no content type at all", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { ...auth, "content-type": "" },
      body: "{}",
    });
    expect(response.status).toBe(415);
  });

  it("accepts application/json with parameters", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "ghoul" }),
    });
    expect(response.status).toBe(201);
  });

  it("leaves GET alone — a body-less read has nothing to smuggle", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/ghosts`, {
      headers: { ...auth, "content-type": "text/plain" },
    })).status).toBe(200);
  });
});

describe("the two deliberate exemptions", () => {
  it("answers a preflight without credentials, because a preflight cannot carry any", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/ghosts/casper/messages`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("serves /api/relay/status unauthenticated, and it still leaks nothing", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/relay/status`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("does not extend that exemption to a foreign origin's other requests", async () => {
    const base = await serve();
    // The status route is open on purpose; nothing next to it is.
    expect((await fetch(`${base}/api/relay`)).status).toBe(401);
    expect((await fetch(`${base}/api/relay/status/extra`)).status).toBe(401);
  });
});


describe("the API token store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-api-token-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sits beside the relay token under XDG state", () => {
    expect(defaultApiTokenPath({ XDG_STATE_HOME: "/xdg/state" }, "/home/x"))
      .toBe("/xdg/state/ghost/api-token");
    expect(defaultApiTokenPath({}, "/home/x"))
      .toBe("/home/x/.local/state/ghost/api-token");
    expect(defaultApiTokenPath({ GHOSTD_API_TOKEN_FILE: "/tmp/t" }, "/home/x")).toBe("/tmp/t");
  });

  it("mints once and reads back the same token forever after", () => {
    const path = join(dir, "state", "api-token");
    const first = readOrCreateApiToken({ path });
    expect(first.created).toBe(true);
    expect(first.token).toMatch(API_TOKEN_PATTERN);
    const second = readOrCreateApiToken({ path });
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(readApiToken({ path })).toBe(first.token);
  });

  it("writes it 0600, because everything else on this box runs as the same user", async () => {
    const path = join(dir, "api-token");
    readOrCreateApiToken({ path });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rotates to something new, invalidating whatever a client holds", () => {
    const path = join(dir, "api-token");
    const before = readOrCreateApiToken({ path }).token;
    const after = rotateApiToken({ path }).token;
    expect(after).not.toBe(before);
    expect(readApiToken({ path })).toBe(after);
  });

  it("does not share a file with the relay token — one leak must not be two", () => {
    expect(defaultApiTokenPath({}, "/home/x")).not.toBe(
      join("/home/x", ".local", "state", "ghost", "relay-token"),
    );
  });
});

describe("ghostd api-token", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-api-token-cli-"));
    out = [];
    err = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const path = () => join(dir, "api-token");
  const run = (argv: string[]) =>
    apiTokenCommand(argv, {
      path: path(),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });

  it("mints, prints, and says where it lives", async () => {
    expect(run([])).toBe(0);
    const text = out.join("");
    expect(text.split("\n")[0]).toMatch(API_TOKEN_PATTERN);
    expect(text).toMatch(/Local API clients read this file/);
    expect(text).toContain(path());
    expect((await stat(path())).mode & 0o777).toBe(0o600);
  });

  it("prints only the token under --quiet, so it can be piped into curl", () => {
    expect(run(["--quiet"])).toBe(0);
    expect(out.join("").trim()).toMatch(API_TOKEN_PATTERN);
    expect(out.join("")).not.toMatch(/Stored at/);
  });

  it("rotates, and says the old one is dead", async () => {
    run(["--quiet"]);
    const before = out.join("").trim();
    out.length = 0;
    expect(run(["--rotate"])).toBe(0);
    const after = out.join("").split("\n")[0];
    expect(after).toMatch(API_TOKEN_PATTERN);
    expect(after).not.toBe(before);
    expect(out.join("")).toMatch(/no longer works/);
    expect(readApiToken({ path: path() })).toBe(after);
    expect((await stat(path())).mode & 0o777).toBe(0o600);
  });

  it("refuses an option it does not know rather than guessing", () => {
    expect(run(["--rotate-all"])).toBe(2);
    expect(err.join("")).toMatch(/api-token: unknown option/);
  });
});

describe("a rotated token", () => {
  it("stops working immediately, which is the point of rotating", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/ghosts`, { headers: auth })).status).toBe(200);
    // The server holds the token it was built with; a client that rotated the
    // file behind its back is simply presenting the wrong secret now.
    expect((await fetch(`${base}/api/ghosts`, {
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
    })).status).toBe(401);
  });
});
