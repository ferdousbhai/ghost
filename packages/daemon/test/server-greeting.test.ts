/**
 * `POST /api/ghosts/:name/greeting` — the empty-chat opener.
 *
 * The contract the shell codes against is narrow and load-bearing: 200 with
 * `{ greeting, onboarding }` whenever the ghost exists, `greeting: null`
 * whenever one could not be written, and a 404 only for a ghost that is not
 * there. A generation failure must never reach the shell as a 5xx — it would
 * turn "no greeting today" into an error dialog over an empty chat window.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { SessionHost, type GreetingGenerator } from "../src/session-host.js";
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

interface ServeOptions {
  /** Replace the model call. Omitted, the real generator runs (and finds nothing). */
  generate?: GreetingGenerator;
  /** Seed a written character.md ghost. Off, the ghost is created from the seed. */
  written?: boolean;
}

async function serve(options: ServeOptions = {}): Promise<string> {
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
    offline: true,
    ...(options.generate ? { greeting: { generate: options.generate } } : {}),
  });
  listening = await startDaemonServer({
    registry: temp.registry,
    host,
    port: 0,
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
  it("returns the generated greeting", async () => {
    const base = await serve({
      generate: async () => "Evening. What are we making?",
      written: true,
    });
    const { status, body } = await postGreeting(base);
    expect(status).toBe(200);
    expect(body).toEqual({ greeting: "Evening. What are we making?", onboarding: false });
  });

  it("hands the generator the ghost's own material", async () => {
    let seenName = "";
    let seenCharacter: string | null = null;
    const base = await serve({
      written: true,
      generate: async ({ ghost, context }) => {
        seenName = ghost.name;
        seenCharacter = context.character;
        return "Hello.";
      },
    });
    await postGreeting(base);
    expect(seenName).toBe("casper");
    expect(seenCharacter).toContain("letterpress printer");
  });

  it("answers 200 with a null greeting when no model can write one", async () => {
    // No provider is configured, so the real generator resolves nothing. That
    // is a greeting the shell simply does not show — never an error.
    const base = await serve({ written: true });
    const { status, body } = await postGreeting(base);
    expect(status).toBe(200);
    expect(body).toEqual({ greeting: null, onboarding: false });
  });

  it("accepts a request with no body at all", async () => {
    const base = await serve({ generate: async () => "Hi.", written: true });
    const { status, body } = await postGreeting(base, "casper", undefined);
    expect(status).toBe(200);
    expect(body.greeting).toBe("Hi.");
  });

  it("reports onboarding for a ghost whose character.md is still the seed", async () => {
    const base = await serve({ generate: async () => "New here. Who are you?" });
    const { status, body } = await postGreeting(base);
    expect(status).toBe(200);
    expect(body.onboarding).toBe(true);
  });

  it("tells the generator it is a first meeting", async () => {
    let onboarding: boolean | null = null;
    const base = await serve({
      generate: async ({ context }) => {
        onboarding = context.onboarding;
        return "Hello.";
      },
    });
    await postGreeting(base);
    expect(onboarding).toBe(true);
  });

  it("stops reporting onboarding once the character deviates from the seed", async () => {
    const base = await serve({ generate: async () => "Hi.", written: true });
    const { body } = await postGreeting(base);
    expect(body.onboarding).toBe(false);
  });

  it("regenerates when character.md changes, and caches otherwise", async () => {
    let calls = 0;
    const base = await serve({
      generate: async () => {
        calls += 1;
        return `greeting ${calls}`;
      },
    });
    expect((await postGreeting(base)).body.greeting).toBe("greeting 1");
    expect((await postGreeting(base)).body.greeting).toBe("greeting 1");
    expect(calls).toBe(1);

    // The owner writes the ghost's character: onboarding ends and the cached
    // "brand new ghost" greeting must not survive it.
    seedGhost(temp!.root, { name: "casper" });
    const after = await postGreeting(base);
    expect(after.body.greeting).toBe("greeting 2");
    expect(after.body.onboarding).toBe(false);
  });

  it("404s for a ghost that does not exist", async () => {
    const base = await serve({ generate: async () => "Hi.", written: true });
    const { status, body } = await postGreeting(base, "nobody");
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: "not_found" });
  });

  it("405s for anything but POST", async () => {
    const base = await serve({ generate: async () => "Hi.", written: true });
    const response = await fetch(`${base}/api/ghosts/casper/greeting`);
    expect(response.status).toBe(405);
  });

  it("answers 200 with a null greeting when the generator throws outright", async () => {
    const base = await serve({
      written: true,
      generate: async () => {
        throw new Error("the provider hung up");
      },
    });
    const { status, body } = await postGreeting(base);
    expect(status).toBe(200);
    expect(body).toEqual({ greeting: null, onboarding: false });
  });
});
