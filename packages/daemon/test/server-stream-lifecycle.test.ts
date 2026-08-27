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
  it("adds an error terminal when a runtime ends without done or error", async () => {
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    seedGhost(temp.root, { name: "casper" });
    const host = {
      async runTurn(_ghost: string, options: {
        emit: (event: { type: "start" }) => void;
      }) {
        options.emit({ type: "start" });
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
