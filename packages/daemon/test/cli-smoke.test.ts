import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ghostCli } from "../src/cli/main.js";

class Sink {
  value = "";
  write(chunk: string): void {
    this.value += chunk;
  }
}

let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe("ghost smoke", () => {
  it.skipIf(process.platform === "win32")("runs against bun src/main.ts without a provider turn", async () => {
    home = mkdtempSync(join(tmpdir(), "ghost-cli-smoke-test-"));
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await ghostCli(["smoke", "--no-turn"], {
      env: { ...process.env, GHOSTD: "bun src/main.ts" },
      home,
      stdout,
      stderr,
      stdin: { isTTY: true },
    });
    expect(code, stderr.value).toBe(0);
    expect(stdout.value).toContain("ok daemon");
    expect(stdout.value).toContain("ok new probe");
    expect(stdout.value).toContain("ok turn: skipped (--no-turn)");
  }, 20_000);
});
