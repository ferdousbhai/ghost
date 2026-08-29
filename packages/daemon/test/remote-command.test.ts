import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remoteCommand } from "../src/remote-command.js";
import { fakeTailscale, missingBinary } from "./helpers/fake-tailscale.js";

let home: string | null = null;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function configPath(): string {
  home = mkdtempSync(join(tmpdir(), "ghostd-remote-command-"));
  const directory = join(home, ".config", "ghost");
  mkdirSync(directory, { recursive: true });
  return join(directory, "config.json");
}

describe("remoteCommand", () => {
  it("enables Serve, preserves config, and prints the resulting URL", async () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ future: true, remote: { guests: "none" } }));
    let output = "";
    await expect(remoteCommand(["on"], {
      env: {},
      home: home!,
      stdout: (text) => { output += text; },
      run: fakeTailscale().run,
    })).resolves.toBe(0);
    expect(output).toBe("https://ghostbox.example.ts.net/\n");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      future: true,
      remote: { guests: "none", enabled: true },
    });
  });

  it("prints the suggested action and exits one when status has a problem", async () => {
    configPath();
    let output = "";
    await expect(remoteCommand([], {
      env: {},
      home: home!,
      stdout: (text) => { output += text; },
      run: missingBinary(),
    })).resolves.toBe(1);
    expect(output).toContain("State: unavailable");
    expect(output).toContain("Action: omarchy-install-service-tailscale");
  });
});
