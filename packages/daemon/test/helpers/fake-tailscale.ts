import type { CommandRunner } from "../../src/command-runner.js";

export interface FakeTailscale {
  run: CommandRunner;
  calls: string[][];
  /** The listeners `tailscale serve status` reports; `serve --bg` turns HTTPS on and `serve ... off` either off. */
  https: boolean;
  /** A plain-HTTP (port 80) entry only an earlier version wrote; Ghost now only clears it. */
  http: boolean;
  certs: boolean;
  backendState: string;
}

export const FAKE_TARGET = "http://127.0.0.1:7717";
export const FAKE_HOSTNAME = "ghostbox.example.ts.net";

/** A `tailscale` that answers `status`, `serve status`, `serve --bg`, and `serve ... off` from its fields. */
export function fakeTailscale(initial: Partial<Pick<FakeTailscale, "https" | "http" | "certs" | "backendState">> = {}): FakeTailscale {
  const fake: FakeTailscale = {
    calls: [],
    https: initial.https ?? false,
    http: initial.http ?? false,
    certs: initial.certs ?? true,
    backendState: initial.backendState ?? "Running",
    run: async (args) => {
      fake.calls.push([...args]);
      const line = args.join(" ");
      if (line === "status --json") {
        return ok(JSON.stringify({
          BackendState: fake.backendState,
          Self: { DNSName: `${FAKE_HOSTNAME}.`, UserID: 42 },
          // The owner's laptop and phone, a partner's shared machine, and a tagged server.
          Peer: {
            a: { DNSName: "laptop.example.ts.net.", UserID: 42, Online: true },
            b: { DNSName: "phone.example.ts.net.", UserID: 42, Online: false },
            c: { DNSName: "partner.example.ts.net.", UserID: 7, Online: true },
            d: { DNSName: "server.example.ts.net.", UserID: 42, Online: true, Tags: ["tag:server"] },
          },
          User: { 42: { LoginName: "owner@example.com" }, 7: { LoginName: "partner@example.com" } },
          CertDomains: fake.certs ? [FAKE_HOSTNAME] : [],
        }));
      }
      if (line === "serve status --json") {
        const ports = [...(fake.https ? ["443"] : []), ...(fake.http ? ["80"] : [])];
        return ok(JSON.stringify(ports.length > 0
          ? { Web: Object.fromEntries(ports.map((port) => [`${FAKE_HOSTNAME}:${port}`, { Handlers: { "/": { Proxy: FAKE_TARGET } } }])) }
          : {}));
      }
      if (line === `serve --bg --https=443 ${FAKE_TARGET}`) {
        fake.https = true;
        return ok();
      }
      if (line === "serve --https=443 off") {
        fake.https = false;
        return ok();
      }
      if (line === "serve --http=80 off") {
        fake.http = false;
        return ok();
      }
      throw new Error(`Unexpected command: ${line}`);
    },
  };
  return fake;
}

export function ok(stdout = ""): { stdout: string; stderr: string; code: number } {
  return { stdout, stderr: "", code: 0 };
}

export function missingBinary(): CommandRunner {
  return async () => {
    const error = new Error("spawn tailscale ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  };
}
