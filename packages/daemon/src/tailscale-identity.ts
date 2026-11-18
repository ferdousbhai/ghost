/**
 * Who is calling over the tailnet. `tailscale serve` terminates TLS on the
 * tailnet address, proxies to the loopback daemon, and stamps the caller's
 * identity on the request as `Tailscale-User-Login`,
 * stripping any such header a client sent itself. Ghost accepts the identity
 * only on a loopback connection: on this owner-only machine a local process
 * that could forge the header could already read the API token file, so the
 * header is exactly as trustworthy as Tailscale documents it to be.
 */
import type { IncomingMessage } from "node:http";
import { commandRunner, type CommandRunner } from "./command-runner.js";
import { LOOPBACK_ADDRESSES } from "./loopback.js";

interface TailscaleNode {
  /** `Running`, `NeedsLogin`, `Stopped`, ... as `tailscale status` reports it. */
  backendState: string;
  /** The login this node is signed in as. */
  login: string | null;
  /** The node's MagicDNS name, without the trailing dot. */
  hostname: string | null;
  /** Whether the tailnet has HTTPS certificates enabled. */
  certs: boolean;
  /** The other nodes this one sees, each with its login (null for a tagged node). */
  peers: TailscalePeer[];
}

interface TailscalePeer {
  hostname: string;
  login: string | null;
  online: boolean;
}

type StatusUsers = Record<string, { LoginName?: unknown }> | undefined;

function loginOf(users: StatusUsers, userId: unknown): string | null {
  const login = users?.[String(userId)]?.LoginName;
  return typeof login === "string" && login.trim() ? login.trim() : null;
}

function dnsHostname(dnsName: unknown): string | null {
  return typeof dnsName === "string" ? dnsName.trim().replace(/\.$/, "") || null : null;
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
    Peer?: Record<string, { DNSName?: unknown; UserID?: unknown; Online?: unknown; Tags?: unknown }>;
    User?: StatusUsers;
  };
  const peers = Object.values(status.Peer ?? {}).flatMap((peer) => {
    const hostname = dnsHostname(peer?.DNSName);
    // A tagged node is owned by its tags, whatever user id it reports.
    const tagged = Array.isArray(peer?.Tags) && peer.Tags.length > 0;
    return hostname ? [{ hostname, login: tagged ? null : loginOf(status.User, peer.UserID), online: peer.Online === true }] : [];
  });
  return {
    backendState: typeof status.BackendState === "string" ? status.BackendState : "",
    login: loginOf(status.User, status.Self?.UserID),
    hostname: dnsHostname(status.Self?.DNSName),
    certs: Array.isArray(status.CertDomains) && status.CertDomains.some((domain) => typeof domain === "string" && domain !== ""),
    peers,
  };
}

type RemoteRole = "owner" | "guest";

export interface TailscaleIdentity {
  login: string;
  role: RemoteRole;
}

export interface RemoteAccessOptions {
  /** The login that owns the ghosts; default: the login this node is signed in as. */
  owner?: string;
  /** What other tailnet members may do; default nothing. */
  guests?: "read-only" | "none";
  /** Test seam over `tailscale status`. */
  selfLogin?: () => Promise<string | null>;
}

/** The login this node is signed in as, or null when Tailscale does not say. */
async function tailscaleSelfLogin(): Promise<string | null> {
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
    this.guests = options.guests ?? "none";
    this.configuredOwner = options.owner?.trim().toLowerCase() || undefined;
  }

  /** The tailnet identity a proxied request carries, or null when it carries none Ghost admits. */
  async identify(request: IncomingMessage): Promise<TailscaleIdentity | null> {
    const login = header(request, "tailscale-user-login")?.toLowerCase();
    if (!login || !LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "")) return null;
    const role: RemoteRole = (await this.ownerLogin()) === login ? "owner" : "guest";
    if (role === "guest" && this.guests === "none") return null;
    return { login, role };
  }

  /** The owner's login; resolved once it is known, an unanswered `tailscale status` is asked again next time. */
  async ownerLogin(): Promise<string | undefined> {
    if (this.configuredOwner) return this.configuredOwner;
    this.owner ??= (await this.selfLogin())?.toLowerCase();
    return this.owner;
  }
}
