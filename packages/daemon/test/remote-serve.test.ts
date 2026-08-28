import { describe, expect, it } from "vitest";
import {
  type CommandResult,
  type CommandRunner,
  RemoteServe,
} from "../src/remote-serve.js";

const target = "http://127.0.0.1:7717";

function tailscaleStatus(certs = true, backendState = "Running"): object {
  return {
    BackendState: backendState,
    Self: { DNSName: "ghostbox.example.ts.net.", UserID: 42 },
    User: { 42: { LoginName: "owner@example.com" } },
    CertDomains: certs ? ["ghostbox.example.ts.net"] : [],
  };
}

function serveConfig(scheme: "https" | "http" | null): object {
  if (!scheme) return {};
  const port = scheme === "https" ? "443" : "80";
  return {
    TCP: { [port]: { [scheme.toUpperCase()]: true } },
    Web: {
      [`ghostbox.example.ts.net:${port}`]: {
        Handlers: { "/": { Proxy: target } },
      },
    },
  };
}

const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", code: 0 });

function statusRunner(certs: boolean, scheme: "https" | "http" | null): CommandRunner {
  return async (args) => {
    if (args.join(" ") === "status --json") return ok(JSON.stringify(tailscaleStatus(certs)));
    if (args.join(" ") === "serve status --json") return ok(JSON.stringify(serveConfig(scheme)));
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
}

describe("RemoteServe status", () => {
  it("derives an HTTPS URL, owner, and guest policy from Tailscale JSON", async () => {
    const status = await new RemoteServe(7717, {
      run: statusRunner(true, "https"),
      guests: "none",
    }).status();

    expect(status).toEqual({
      enabled: true,
      state: "on",
      scheme: "https",
      hostname: "ghostbox.example.ts.net",
      url: "https://ghostbox.example.ts.net/",
      tailscale: {
        installed: true,
        running: true,
        loggedIn: true,
        operator: true,
        certs: true,
      },
      guests: "none",
      owner: "owner@example.com",
      problem: null,
    });
  });

  it("uses plain HTTP on port 80 when the tailnet has no certificates", async () => {
    const status = await new RemoteServe(7717, { run: statusRunner(false, "http") }).status();
    expect(status).toMatchObject({
      enabled: true,
      state: "on",
      scheme: "http",
      url: "http://ghostbox.example.ts.net/",
      tailscale: { certs: false },
    });
  });

  it("reports a stopped daemon as unavailable", async () => {
    const run: CommandRunner = async () => ok(JSON.stringify({ BackendState: "Stopped" }));
    const status = await new RemoteServe(7717, { run }).status();
    expect(status).toMatchObject({
      enabled: false,
      state: "unavailable",
      tailscale: { installed: true, running: false },
      problem: { code: "tailscale_stopped" },
    });
  });

  it("reports a missing tailscale binary with its install action", async () => {
    const run: CommandRunner = async () => {
      const error = new Error("spawn tailscale ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };
    const status = await new RemoteServe(7717, { run }).status();
    expect(status).toMatchObject({
      state: "unavailable",
      tailscale: { installed: false },
      problem: {
        code: "tailscale_missing",
        action: "omarchy-install-service-tailscale",
      },
    });
  });
});

describe("RemoteServe mutations", () => {
  it("uses the HTTPS and HTTP command lines selected by certificate availability", async () => {
    for (const certs of [true, false]) {
      const calls: string[][] = [];
      let scheme: "https" | "http" | null = null;
      const run: CommandRunner = async (args) => {
        calls.push([...args]);
        if (args.join(" ") === "status --json") return ok(JSON.stringify(tailscaleStatus(certs)));
        if (args.join(" ") === "serve status --json") return ok(JSON.stringify(serveConfig(scheme)));
        if (args[0] === "serve" && args[1] === "--bg") {
          scheme = certs ? "https" : "http";
          return ok();
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      };
      await new RemoteServe(7717, { run }).enable();
      expect(calls).toContainEqual(certs
        ? ["serve", "--bg", "--https=443", target]
        : ["serve", "--bg", "--http=80", target]);
    }
  });

  it("disables both managed listeners and ignores no-such errors", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === "--https=443") return { stdout: "", stderr: "no such serve config", code: 1 };
      if (args[1] === "--http=80") return ok();
      if (args.join(" ") === "status --json") return ok(JSON.stringify(tailscaleStatus(false)));
      if (args.join(" ") === "serve status --json") return ok("{}");
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const status = await new RemoteServe(7717, { run }).disable();
    expect(calls.slice(0, 2)).toEqual([
      ["serve", "--https=443", "off"],
      ["serve", "--http=80", "off"],
    ]);
    expect(status).toMatchObject({ enabled: false, state: "off", problem: null });
  });

  it("turns an operator failure into the stable problem and action", async () => {
    const run: CommandRunner = async (args) => {
      if (args.join(" ") === "status --json") return ok(JSON.stringify(tailscaleStatus(true)));
      if (args.join(" ") === "serve status --json") return ok("{}");
      if (args[1] === "--bg") {
        return {
          stdout: "",
          stderr: "Access denied.\nUse 'sudo tailscale set --operator=$USER'.",
          code: 1,
        };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const status = await new RemoteServe(7717, { run }).enable();
    expect(status).toMatchObject({
      tailscale: { operator: false },
      problem: {
        code: "operator_required",
        message: "Access denied.",
        action: "sudo tailscale set --operator=$USER",
      },
    });
  });

  it("is idempotent and reapplies Serve only when the required scheme changes", async () => {
    const calls: string[][] = [];
    let certs = false;
    let scheme: "https" | "http" | null = "http";
    const run: CommandRunner = async (args) => {
      calls.push([...args]);
      if (args.join(" ") === "status --json") return ok(JSON.stringify(tailscaleStatus(certs)));
      if (args.join(" ") === "serve status --json") return ok(JSON.stringify(serveConfig(scheme)));
      if (args[1] === "--bg") {
        scheme = certs ? "https" : "http";
        return ok();
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const remote = new RemoteServe(7717, { run });
    await remote.ensure(true);
    expect(calls.filter((args) => args[1] === "--bg")).toHaveLength(0);
    certs = true;
    await remote.ensure(true);
    expect(calls.filter((args) => args[1] === "--bg")).toEqual([
      ["serve", "--bg", "--https=443", target],
    ]);
  });
});

describe("RemoteServe QR", () => {
  it("returns qrencode SVG output with the exact URL command line", async () => {
    const calls: string[][] = [];
    const qrRun: CommandRunner = async (args) => {
      calls.push([...args]);
      return ok("<svg>qr</svg>");
    };
    const remote = new RemoteServe(7717, { run: statusRunner(true, null), qrRun });
    await expect(remote.qrSvg("https://ghostbox.example.ts.net/")).resolves.toBe("<svg>qr</svg>");
    expect(calls).toEqual([
      ["-t", "SVG", "-o", "-", "https://ghostbox.example.ts.net/"],
    ]);
  });
});
