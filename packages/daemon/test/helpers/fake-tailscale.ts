import type { CommandRunner } from "../../src/tailscale-identity.js";

export type FakeScheme = "https" | "http" | null;

export interface FakeTailscale {
  run: CommandRunner;
  calls: string[][];
  /** What `tailscale serve status` reports; `serve --bg` and `serve ... off` move it. */
  scheme: FakeScheme;
  certs: boolean;
  backendState: string;
}

export const FAKE_TARGET = "http://127.0.0.1:7717";
export const FAKE_HOSTNAME = "ghostbox.example.ts.net";

/** A `tailscale` that answers `status`, `serve status`, `serve --bg`, and `serve ... off` from its fields. */
export function fakeTailscale(initial: Partial<Pick<FakeTailscale, "scheme" | "certs" | "backendState">> = {}): FakeTailscale {
  const fake: FakeTailscale = {
    calls: [],
    scheme: initial.scheme ?? null,
    certs: initial.certs ?? true,
    backendState: initial.backendState ?? "Running",
    run: async (args) => {
      fake.calls.push([...args]);
      const line = args.join(" ");
      if (line === "status --json") {
        return ok(JSON.stringify({
          BackendState: fake.backendState,
          Self: { DNSName: `${FAKE_HOSTNAME}.`, UserID: 42 },
          User: { 42: { LoginName: "owner@example.com" } },
          CertDomains: fake.certs ? [FAKE_HOSTNAME] : [],
        }));
      }
      if (line === "serve status --json") {
        const port = fake.scheme === "https" ? "443" : "80";
        return ok(JSON.stringify(fake.scheme
          ? { Web: { [`${FAKE_HOSTNAME}:${port}`]: { Handlers: { "/": { Proxy: FAKE_TARGET } } } } }
          : {}));
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        fake.scheme = args[2] === "--https=443" ? "https" : "http";
        return ok();
      }
      if (args[0] === "serve" && args[2] === "off") {
        fake.scheme = null;
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
