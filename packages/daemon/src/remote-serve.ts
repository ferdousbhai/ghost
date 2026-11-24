/**
 * Ghost's Tailscale Serve exposure: `tailscale serve --bg --https=443`
 * proxying to the loopback daemon, so an app in `remote.apps` reaches its API
 * at the node's tailnet name with the caller's identity stamped (see
 * tailscale-identity.ts). The app is an https page, which cannot call an http
 * address, so a tailnet without HTTPS certificates gets no Serve entry at all.
 * Status is read from Tailscale on every call; the one thing remembered is an
 * operator refusal, because only a write attempt can reveal it. Tailscale keeps
 * a `--bg` Serve entry across restarts, so Ghost stores no on/off of its own.
 */
import { type CommandResult, type CommandRunner, commandRunner } from "./command-runner.js";
import { readTailscaleNode } from "./tailscale-identity.js";
import { errorMessage, GhostError } from "./errors.js";
import { DAEMON_HOST } from "./loopback.js";

interface RemoteProblem {
  code: string;
  message: string;
  /** A command the owner can run to clear the problem. */
  action?: string;
}

export interface RemoteStatus {
  state: "on" | "off" | "unavailable";
  hostname: string | null;
  guests: "read-only" | "none";
  owner: string | null;
  /**
   * The first of `remote.apps`, null when there are none, and its link adding
   * this machine (`<origin>/#add=<hostname>`), null while Serve is off.
   */
  app: { origin: string; url: string | null } | null;
  problem: RemoteProblem | null;
}

/** One of the owner's other tailnet machines, as `GET /api/remote/machines` lists it. */
interface RemoteMachine {
  hostname: string;
  online: boolean;
}

interface RemoteServeOptions {
  owner?: string;
  guests?: "read-only" | "none";
  /** `remote.apps`; omitted, none. */
  apps?: readonly string[];
  /** Test seam over `tailscale`. */
  run?: CommandRunner;
}

/** The listeners Ghost writes: HTTPS, and plain HTTP, which earlier versions used without certificates and are now only cleared. */
const HTTPS = "--https=443";
const HTTP = "--http=80";

const TAILSCALE_MISSING: RemoteProblem = {
  code: "tailscale_missing",
  message: "Tailscale is not installed.",
  action: "omarchy-install-service-tailscale",
};
const NOT_LOGGED_IN: RemoteProblem = {
  code: "not_logged_in",
  message: "This machine is not logged in to Tailscale.",
  action: "tailscale up",
};
const OPERATOR_ACTION = "sudo tailscale set --operator=$USER";
const HTTPS_REQUIRED: RemoteProblem = {
  code: "https_required",
  message: "This tailnet has no HTTPS certificates, which the app needs: turn on HTTPS Certificates on the DNS page of the Tailscale admin console (https://login.tailscale.com/admin/dns), then turn remote access on again.",
};

function isMissingBinary(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function detail(result: CommandResult): string {
  return firstLine(result.stderr) || firstLine(result.stdout) || `tailscale exited with code ${result.code}`;
}

function serveFailed(message: string): RemoteProblem {
  return { code: "serve_failed", message };
}

/**
 * Ghost's own Serve listeners, from `tailscale serve status --json`: the `Web`
 * map is keyed by `host:port`, and Ghost only ever writes ports 443 and 80.
 */
function servedListeners(config: unknown, target: string): { https: boolean; http: boolean } {
  const served = { https: false, http: false };
  const web = (config as { Web?: unknown } | null)?.Web;
  if (!web || typeof web !== "object") return served;
  for (const [hostPort, server] of Object.entries(web as Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>)) {
    const proxied = Object.values(server?.Handlers ?? {})
      .some((handler) => typeof handler?.Proxy === "string" && handler.Proxy.replace(/\/$/, "") === target);
    if (!proxied) continue;
    if (hostPort.endsWith(":443")) served.https = true;
    else if (hostPort.endsWith(":80")) served.http = true;
  }
  return served;
}

/** Status plus what only enable and disable need: certificates, and a leftover HTTP entry. */
interface Inspection {
  status: RemoteStatus;
  certs: boolean;
  http: boolean;
}

export class RemoteServe {
  private readonly target: string;
  private readonly run: CommandRunner;
  private readonly owner: string | null;
  private readonly guests: "read-only" | "none";
  private readonly app: string | null;
  /** The last Serve refusal for lack of the operator right; cleared by the next accepted write. */
  private operatorProblem: RemoteProblem | null = null;

  constructor(port: number, options: RemoteServeOptions = {}) {
    this.target = `http://${DAEMON_HOST}:${port}`;
    this.run = options.run ?? commandRunner("tailscale");
    // Lowercased as RemoteAccess compares it, so what is reported is what is enforced.
    this.owner = options.owner?.trim().toLowerCase() || null;
    this.guests = options.guests ?? "none";
    this.app = options.apps?.[0] ?? null;
  }

  async status(): Promise<RemoteStatus> {
    return (await this.inspect()).status;
  }

  /**
   * Turn the exposure on over HTTPS, clearing a plain-HTTP entry an earlier
   * version left. Without certificates nothing is written and the problem
   * says how to get them.
   */
  async enable(): Promise<RemoteStatus> {
    const { status, certs, http } = await this.inspect();
    if (status.state === "unavailable") return status;
    if (http) {
      const problem = await this.change(["serve", HTTP, "off"]);
      if (problem) return { ...status, problem };
    }
    if (!certs) return { ...(await this.status()), problem: this.operatorProblem ?? HTTPS_REQUIRED };
    const problem = await this.change(["serve", "--bg", HTTPS, this.target]);
    return problem ? { ...status, problem } : this.status();
  }

  /** Turn off each listener Ghost has on, the plain-HTTP one an earlier version wrote included. */
  async disable(): Promise<RemoteStatus> {
    const { status, http } = await this.inspect();
    const listeners = [...(status.state === "on" ? [HTTPS] : []), ...(http ? [HTTP] : [])];
    if (listeners.length === 0) return status;
    for (const listener of listeners) {
      const problem = await this.change(["serve", listener, "off"]);
      if (problem) return { ...status, problem };
    }
    return this.status();
  }

  /**
   * The owner's other tailnet machines, from `tailscale status --json`: nodes
   * signed in as the owner's login, which excludes this one and tagged nodes.
   * Whether one runs Ghost is the app's probe to find out.
   */
  async machines(): Promise<RemoteMachine[]> {
    let node: Awaited<ReturnType<typeof readTailscaleNode>>;
    try {
      node = await readTailscaleNode(this.run);
    } catch (error) {
      throw new GhostError("tailscale_unavailable", `Tailscale did not answer: ${firstLine(errorMessage(error))}`, 503);
    }
    const owner = this.owner ?? node.login?.toLowerCase();
    return node.peers
      .filter((peer) => owner !== undefined && peer.login?.toLowerCase() === owner)
      .map(({ hostname, online }) => ({ hostname, online }));
  }

  /**
   * The app's deep link to one conversation on this machine,
   * `<origin>/#/<hostname>/<id>`, null while there is no app link.
   */
  async conversationUrl(id: string): Promise<string | null> {
    const { app, hostname } = await this.status();
    if (!app?.url || !hostname) return null;
    return `${app.origin}/#/${[hostname, id].map(encodeURIComponent).join("/")}`;
  }

  private async inspect(): Promise<Inspection> {
    const off: RemoteStatus = {
      state: "off",
      hostname: null,
      guests: this.guests,
      owner: this.owner,
      app: this.app ? { origin: this.app, url: null } : null,
      problem: null,
    };
    const unavailable = (status: RemoteStatus, problem: RemoteProblem): Inspection =>
      ({ status: { ...status, state: "unavailable", problem }, certs: false, http: false });
    let node: Awaited<ReturnType<typeof readTailscaleNode>>;
    try {
      node = await readTailscaleNode(this.run);
    } catch (error) {
      return unavailable(off, isMissingBinary(error)
        ? TAILSCALE_MISSING
        : { code: "tailscale_stopped", message: firstLine(errorMessage(error)) });
    }
    const known: RemoteStatus = {
      ...off,
      hostname: node.hostname,
      owner: this.owner ?? node.login?.toLowerCase() ?? null,
    };
    if (node.backendState === "NeedsLogin" || node.hostname === null) return unavailable(known, NOT_LOGGED_IN);
    if (node.backendState !== "Running") return unavailable(known, { code: "tailscale_stopped", message: "Tailscale is not running." });
    const inspection = (status: RemoteStatus, http = false): Inspection => ({ status, certs: node.certs, http });
    let result: CommandResult;
    try {
      result = await this.run(["serve", "status", "--json"]);
    } catch (error) {
      return inspection({ ...known, problem: serveFailed(firstLine(errorMessage(error))) });
    }
    if (result.code !== 0) return inspection({ ...known, problem: serveFailed(detail(result)) });
    let served: { https: boolean; http: boolean };
    try {
      served = servedListeners(JSON.parse(result.stdout), this.target);
    } catch (error) {
      return inspection({ ...known, problem: serveFailed(`tailscale serve status returned invalid JSON: ${errorMessage(error)}`) });
    }
    return inspection({
      ...known,
      state: served.https ? "on" : "off",
      app: known.app && { ...known.app, url: served.https ? `${known.app.origin}/#add=${known.hostname}` : null },
      problem: this.operatorProblem,
    }, served.http);
  }

  /** Ask Tailscale for one Serve change; a refusal is returned, and remembered when it is the operator right. */
  private async change(args: string[]): Promise<RemoteProblem | null> {
    let result: CommandResult;
    try {
      result = await this.run(args);
    } catch (error) {
      return isMissingBinary(error) ? TAILSCALE_MISSING : serveFailed(firstLine(errorMessage(error)));
    }
    if (result.code !== 0) {
      const message = detail(result);
      const operator = /operator/i.test(`${result.stderr}\n${result.stdout}`);
      this.operatorProblem = operator ? { code: "operator_required", message, action: OPERATOR_ACTION } : null;
      return this.operatorProblem ?? serveFailed(message);
    }
    this.operatorProblem = null;
    return null;
  }
}
