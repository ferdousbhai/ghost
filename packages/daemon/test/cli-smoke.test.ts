import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";

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
