import { afterEach, describe, expect, it } from "vitest";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import type { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, parseSseStream, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

let listening: ListeningServer | null = null;
let temp: TempGhosts | null = null;

afterEach(async () => {
  await listening?.close();
  listening = null;
  temp?.cleanup();
  temp = null;
});

describe("SSE turn lifecycle", () => {
  it("flushes accepted stream headers before a silent turn produces an event", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    let finishTurn = () => {};
    const turnFinished = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const host = {
      async admitTurn() {
        return {
          async run() {
            await turnFinished;
          },
          release() {},
        };
      },
    } as unknown as SessionHost;
    listening = await startDaemonServer({
      registry: temp.registry,
      host,
      port: 0,
      apiToken: null,
    });

    const opening = new AbortController();
    const timer = setTimeout(() => opening.abort(), 1_000);
    let response: Response;
    try {
      response = await globalThis.fetch(
        `http://127.0.0.1:${listening.port}/api/ghosts/casper/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({
            context: { messages: [{ role: "user", content: "hello" }] },
            options: { sessionId: "silent-turn" },
          }),
          signal: opening.signal,
        },
      );
    } finally {
      clearTimeout(timer);
      finishTurn();
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(parseSseStream(await response.text())).toEqual([
      expect.objectContaining({ type: "error", reason: "error" }),
    ]);
  });

  it("adds an error terminal when a runtime ends without done or error", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const host = {
      async admitTurn() {
        return {
          async run(options: { emit: (event: { type: "start" }) => void }) {
            options.emit({ type: "start" });
          },
          release() {},
        };
      },
    } as unknown as SessionHost;
    listening = await startDaemonServer({
      registry: temp.registry,
      host,
      port: 0,
      apiToken: null,
    });

    const response = await fetch(
      `http://127.0.0.1:${listening.port}/api/ghosts/casper/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          context: { messages: [{ role: "user", content: "hello" }] },
          options: { sessionId: "missing-terminal" },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(parseSseStream(await response.text())).toEqual([
      { type: "start" },
      expect.objectContaining({
        type: "error",
        reason: "error",
        errorMessage: "The turn ended without a terminal event.",
      }),
    ]);
  });
});
