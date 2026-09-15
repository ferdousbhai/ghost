import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { smokeMemorySlugs } from "../src/cli/smoke.js";
import { runCli } from "./helpers/cli.js";
import { DaemonClient } from "../src/cli/client.js";
import type { CliRuntime } from "../src/cli/types.js";

let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe("ghost smoke", () => {
  it.skipIf(process.platform === "win32")("runs against bun src/main.ts without a provider turn", async () => {
    home = mkdtempSync(join(tmpdir(), "ghost-cli-smoke-test-"));
    const result = await runCli(["smoke", "--no-turn", "--json"], {
      env: { ...process.env, GHOSTD: `bun ${fileURLToPath(new URL("../src/main.ts", import.meta.url))}` },
      home,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { step: "daemon", ok: true, detail: "ok" },
      { step: "new probe", ok: true },
      { step: "turn", ok: true, detail: "skipped (--no-turn)" },
    ]);
  }, 20_000);

  it("rejects a memory turn that wrote no readable memory slug", () => {
    expect(() => smokeMemorySlugs(JSON.stringify({ memory: [], skipped: [] })))
      .toThrow("memory turn wrote no readable memory");
  });
});

describe("DaemonClient request budgets", () => {
  function runtime(
    fetchImpl: CliRuntime["fetch"],
    base: string,
    env: NodeJS.ProcessEnv = {},
  ): CliRuntime {
    return {
      env: { ...env, GHOSTD_PORT: "7999", GHOSTD_HOST: "127.0.0.1" },
      home: base,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      fetch: fetchImpl,
      stdin: Object.assign((async function* () {})(), { isTTY: false }),
    };
  }

  /** Answer only after the control budget would have fired. */
  const slowly = (make: () => Response): CliRuntime["fetch"] =>
    (async (_input: string, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 6_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
      return make();
    }) as CliRuntime["fetch"];

  it("gives a turn's event stream longer than a control request to answer", async () => {
    home = mkdtempSync(join(tmpdir(), "ghost-cli-budget-"));

    // A control request is a small round-trip; six seconds means it is gone.
    const control = new DaemonClient(runtime(
      slowly(() => new Response("{}", { status: 200 })),
      home,
    ));
    await expect(control.request("GET", "/api/status")).rejects.toThrow(/abort/i);

    // The same six seconds on a turn is just a model that has not spoken yet.
    const streamed = new DaemonClient(runtime(
      slowly(() => new Response("data: {\"type\":\"done\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })),
      home,
    ));
    const events: unknown[] = [];
    await streamed.stream("/api/turn", { prompt: "hi" }, (event) => {
      events.push(event);
    });
    expect(events).toEqual([{ type: "done" }]);
  }, 30_000);

  it("keeps the stream opening budget after refreshing a stale token", async () => {
    home = mkdtempSync(join(tmpdir(), "ghost-cli-budget-"));
    const tokenPath = join(home, "api-token");
    const staleToken = "a".repeat(64);
    const freshToken = "b".repeat(64);
    writeFileSync(tokenPath, `${staleToken}\n`, { mode: 0o600 });

    let attempts = 0;
    const delayedStream = slowly(() => new Response(
      "data: {\"type\":\"done\"}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const fetchImpl: CliRuntime["fetch"] = async (input, init) => {
      attempts += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      if (attempts === 1) {
        expect(authorization).toBe(`Bearer ${staleToken}`);
        writeFileSync(tokenPath, `${freshToken}\n`, { mode: 0o600 });
        return new Response(null, { status: 401 });
      }
      expect(authorization).toBe(`Bearer ${freshToken}`);
      return delayedStream(input, init);
    };
    const client = new DaemonClient(runtime(fetchImpl, home, {
      GHOSTD_API_TOKEN_FILE: tokenPath,
    }));

    const events: unknown[] = [];
    await client.stream("/api/turn", { prompt: "hi" }, (event) => {
      events.push(event);
    });

    expect(attempts).toBe(2);
    expect(events).toEqual([{ type: "done" }]);
  }, 15_000);
});
