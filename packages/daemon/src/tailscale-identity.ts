/**
 * Who is calling over the tailnet. `tailscale serve` terminates TLS on the
 * tailnet address, proxies to the loopback daemon, and stamps the caller's
 * identity on the request as `Tailscale-User-Login` / `Tailscale-User-Name`,
 * stripping any such header a client sent itself. Ghost accepts the identity
 * only on a loopback connection: on this owner-only machine a local process
 * that could forge the header could already read the API token file, so the
 * header is exactly as trustworthy as Tailscale documents it to be.
 */
import { execFile, type ExecFileException } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { LOOPBACK_ADDRESSES } from "./relay-protocol.js";

const exec = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs one binary; a non-zero exit is a result, a missing binary (ENOENT) rejects. */
export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

export function commandRunner(binary: string): CommandRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await exec(binary, [...args], { encoding: "utf8", timeout: 10_000 });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failed = error as ExecFileException & { stdout?: string; stderr?: string };
      if (failed.code === "ENOENT") throw error;
      return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: typeof failed.code === "number" ? failed.code : 1 };
    }
  };
}

export interface TailscaleNode {
  /** `Running`, `NeedsLogin`, `Stopped`, ... as `tailscale status` reports it. */
  backendState: string;
  /** The login this node is signed in as. */
  login: string | null;
  /** The node's MagicDNS name, without the trailing dot. */
  hostname: string | null;
  /** Whether the tailnet has HTTPS certificates enabled. */
  certs: boolean;
}

/** `tailscale status --json`, reduced to what Ghost asks of it; rejects when tailscale is missing or does not answer. */
export async function readTailscaleNode(run: CommandRunner = commandRunner("tailscale")): Promise<TailscaleNode> {
  const result = await run(["status", "--json"]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `tailscale exited with code ${result.code}`);
  }
  const status = JSON.parse(result.stdout) as {
    BackendState?: unknown;
    CertDomains?: unknown;
    Self?: { DNSName?: unknown; UserID?: unknown };
    User?: Record<string, { LoginName?: unknown }>;
  };
  const login = status.User?.[String(status.Self?.UserID)]?.LoginName;
  const dnsName = status.Self?.DNSName;
  return {
    backendState: typeof status.BackendState === "string" ? status.BackendState : "",
    login: typeof login === "string" && login.trim() ? login.trim() : null,
    hostname: typeof dnsName === "string" ? dnsName.trim().replace(/\.$/, "") || null : null,
    certs: Array.isArray(status.CertDomains) && status.CertDomains.some((domain) => typeof domain === "string" && domain !== ""),
  };
}

export type RemoteRole = "owner" | "guest";

export interface TailscaleIdentity {
  login: string;
  name?: string;
  role: RemoteRole;
}

export interface RemoteAccessOptions {
  /** The login that owns the ghosts; default: the login this node is signed in as. */
  owner?: string;
  /** What other tailnet members may do; default read-only. */
  guests?: "read-only" | "none";
  /** Test seam over `tailscale status`. */
  selfLogin?: () => Promise<string | null>;
}

/** The login this node is signed in as, or null when Tailscale does not say. */
export async function tailscaleSelfLogin(): Promise<string | null> {
  try {
    return (await readTailscaleNode()).login;
  } catch {
    return null;
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}

export class RemoteAccess {
  private readonly selfLogin: () => Promise<string | null>;
  private readonly guests: "read-only" | "none";
  private readonly configuredOwner: string | undefined;
  private owner: string | undefined;

  constructor(options: RemoteAccessOptions = {}) {
    this.selfLogin = options.selfLogin ?? tailscaleSelfLogin;
    this.guests = options.guests ?? "read-only";
    this.configuredOwner = options.owner?.trim().toLowerCase() || undefined;
  }

  /** The tailnet identity a proxied request carries, or null when it carries none Ghost admits. */
  async identify(request: IncomingMessage): Promise<TailscaleIdentity | null> {
    const login = header(request, "tailscale-user-login")?.toLowerCase();
    if (!login || !LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "")) return null;
    const role: RemoteRole = (await this.ownerLogin()) === login ? "owner" : "guest";
    if (role === "guest" && this.guests === "none") return null;
    const name = header(request, "tailscale-user-name");
    return { login, role, ...(name ? { name } : {}) };
  }

  /** Resolved once it is known; an unanswered `tailscale status` is asked again next time. */
  private async ownerLogin(): Promise<string | undefined> {
    if (this.configuredOwner) return this.configuredOwner;
    this.owner ??= (await this.selfLogin())?.toLowerCase();
    return this.owner;
  }
}
