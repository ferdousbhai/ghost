import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
});

describe("DaemonClient request budgets", () => {
  function runtime(fetchImpl: CliRuntime["fetch"], base: string): CliRuntime {
    return {
      env: { GHOSTD_PORT: "7999", GHOSTD_HOST: "127.0.0.1" },
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
});
