import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remoteCommand } from "../src/remote-command.js";
import { type CommandRunner, RemoteServe } from "../src/remote-serve.js";

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
    let enabled = false;
    const run: CommandRunner = async (args) => {
      if (args.join(" ") === "status --json") {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "ghostbox.example.ts.net.", UserID: 1 },
            User: { 1: { LoginName: "owner@example.com" } },
            CertDomains: ["ghostbox.example.ts.net"],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args.join(" ") === "serve status --json") {
        return {
          stdout: JSON.stringify(enabled ? {
            TCP: { 443: { HTTPS: true } },
            Web: {
              "ghostbox.example.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:7717" } },
              },
            },
          } : {}),
          stderr: "",
          code: 0,
        };
      }
      if (args.join(" ") === "serve --bg --https=443 http://127.0.0.1:7717") {
        enabled = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    let output = "";
    await expect(remoteCommand(["on"], {
      env: {},
      home: home!,
      stdout: (text) => { output += text; },
      createRemoteServe: (port, options) => new RemoteServe(port, { ...options, run }),
    })).resolves.toBe(0);
    expect(output).toBe("https://ghostbox.example.ts.net/\n");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      future: true,
      remote: { guests: "none", enabled: true },
    });
  });

  it("prints the suggested action and exits one when status has a problem", async () => {
    configPath();
    const missing: CommandRunner = async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };
    let output = "";
    await expect(remoteCommand([], {
      env: {},
      home: home!,
      stdout: (text) => { output += text; },
      createRemoteServe: (port, options) => new RemoteServe(port, { ...options, run: missing }),
    })).resolves.toBe(1);
    expect(output).toContain("State: unavailable");
    expect(output).toContain("Action: omarchy-install-service-tailscale");
  });
});
