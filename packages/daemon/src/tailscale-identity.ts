/**
 * Who is calling over the tailnet. `tailscale serve` terminates TLS on the
 * tailnet address, proxies to the loopback daemon, and stamps the caller's
 * identity on the request as `Tailscale-User-Login` / `Tailscale-User-Name`,
 * stripping any such header a client sent itself. Ghost accepts the identity
 * only on a loopback connection: on this owner-only machine a local process
 * that could forge the header could already read the API token file, so the
 * header is exactly as trustworthy as Tailscale documents it to be.
 */
import { execFile } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { LOOPBACK_ADDRESSES } from "./relay-protocol.js";

const run = promisify(execFile);

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

/** The login this node is signed in as, from `tailscale status --json`. */
export async function tailscaleSelfLogin(): Promise<string | null> {
  try {
    const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 5_000 });
    const status = JSON.parse(stdout) as { Self?: { UserID?: unknown }; User?: Record<string, { LoginName?: unknown }> };
    const login = status.User?.[String(status.Self?.UserID)]?.LoginName;
    return typeof login === "string" ? login : null;
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
