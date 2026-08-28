/**
 * Ghost's Tailscale Serve exposure: `tailscale serve --bg --https=443` (or
 * `--http=80` on a tailnet without certificates) proxying to the loopback
 * daemon, so the viewer at `/` is reachable at the node's tailnet name with
 * the caller's identity stamped (see tailscale-identity.ts). Status is read
 * from Tailscale on every call; the one thing remembered is an operator
 * refusal, because only a write attempt can reveal it.
 */
import { writeConfigFile } from "./config.js";
import {
  type CommandResult,
  type CommandRunner,
  commandRunner,
  readTailscaleNode,
} from "./tailscale-identity.js";

export interface RemoteProblem {
  code: string;
  message: string;
  /** A command the owner can run to clear the problem. */
  action?: string;
}

export interface RemoteStatus {
  enabled: boolean;
  state: "on" | "off" | "unavailable";
  scheme: "https" | "http" | null;
  hostname: string | null;
  url: string | null;
  tailscale: {
    installed: boolean;
    running: boolean;
    loggedIn: boolean;
    /** False after Tailscale refused a Serve change for lack of the operator right. */
    operator: boolean;
    certs: boolean;
  };
  guests: "read-only" | "none";
  owner: string | null;
  problem: RemoteProblem | null;
}

export interface RemoteServeOptions {
  owner?: string;
  guests?: "read-only" | "none";
  /** Where `setEnabled` persists `remote.enabled`; omitted, the choice is not written. */
  configPath?: string;
  /** Test seams over `tailscale` and `qrencode`. */
  run?: CommandRunner;
  qrRun?: CommandRunner;
}

type Scheme = "https" | "http";

const PORT: Record<Scheme, number> = { https: 443, http: 80 };

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
 * The scheme Ghost's own entry is served on, from `tailscale serve status
 * --json`: the `Web` map is keyed by `host:port`, and Ghost only ever writes
 * ports 443 and 80. HTTPS wins while a move from HTTP is under way.
 */
function servedScheme(config: unknown, target: string): Scheme | null {
  const web = (config as { Web?: unknown } | null)?.Web;
  if (!web || typeof web !== "object") return null;
  const schemes = new Set<Scheme>();
  for (const [hostPort, server] of Object.entries(web as Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>)) {
    const proxied = Object.values(server?.Handlers ?? {})
      .some((handler) => typeof handler?.Proxy === "string" && handler.Proxy.replace(/\/$/, "") === target);
    if (!proxied) continue;
    if (hostPort.endsWith(":443")) schemes.add("https");
    else if (hostPort.endsWith(":80")) schemes.add("http");
  }
  return schemes.has("https") ? "https" : schemes.has("http") ? "http" : null;
}

export class RemoteServe {
  private readonly target: string;
  private readonly run: CommandRunner;
  private readonly qrRun: CommandRunner;
  private readonly owner: string | null;
  private readonly guests: "read-only" | "none";
  private readonly configPath: string | undefined;
  /** The last Serve refusal for lack of the operator right; cleared by the next accepted write. */
  private operatorProblem: RemoteProblem | null = null;

  constructor(port: number, options: RemoteServeOptions = {}) {
    this.target = `http://127.0.0.1:${port}`;
    this.run = options.run ?? commandRunner("tailscale");
    this.qrRun = options.qrRun ?? commandRunner("qrencode");
    this.owner = options.owner?.trim() || null;
    this.guests = options.guests ?? "read-only";
    this.configPath = options.configPath;
  }

  async status(): Promise<RemoteStatus> {
    const off: RemoteStatus = {
      enabled: false,
      state: "off",
      scheme: null,
      hostname: null,
      url: null,
      tailscale: { installed: true, running: false, loggedIn: false, operator: this.operatorProblem === null, certs: false },
      guests: this.guests,
      owner: this.owner,
      problem: null,
    };
    const unavailable = (status: RemoteStatus, problem: RemoteProblem): RemoteStatus =>
      ({ ...status, state: "unavailable", problem });
    let node: Awaited<ReturnType<typeof readTailscaleNode>>;
    try {
      node = await readTailscaleNode(this.run);
    } catch (error) {
      return isMissingBinary(error)
        ? unavailable({ ...off, tailscale: { ...off.tailscale, installed: false } }, TAILSCALE_MISSING)
        : unavailable(off, { code: "tailscale_stopped", message: firstLine((error as Error).message) });
    }
    const known: RemoteStatus = {
      ...off,
      hostname: node.hostname,
      owner: this.owner ?? node.login,
      tailscale: {
        ...off.tailscale,
        running: node.backendState === "Running",
        loggedIn: node.backendState !== "NeedsLogin" && node.hostname !== null,
        certs: node.certs,
      },
    };
    if (!known.tailscale.loggedIn) return unavailable(known, NOT_LOGGED_IN);
    if (!known.tailscale.running) {
      return unavailable(known, { code: "tailscale_stopped", message: "Tailscale is not running." });
    }
    return this.served(known);
  }

  /** Turn the exposure on for the scheme the tailnet supports, moving off the other one first. */
  async enable(): Promise<RemoteStatus> {
    const current = await this.status();
    if (current.state === "unavailable") return current;
    const wanted: Scheme = current.tailscale.certs ? "https" : "http";
    if (current.scheme && current.scheme !== wanted) {
      const cleared = await this.write(current, ["serve", `--${current.scheme}=${PORT[current.scheme]}`, "off"]);
      if (cleared.problem) return cleared;
    }
    return this.write(current, ["serve", "--bg", `--${wanted}=${PORT[wanted]}`, this.target]);
  }

  async disable(): Promise<RemoteStatus> {
    const current = await this.status();
    if (!current.scheme) return current;
    return this.write(current, ["serve", `--${current.scheme}=${PORT[current.scheme]}`, "off"]);
  }

  /** Apply the owner's choice and, when a config path is known, persist it as `remote.enabled`. */
  async setEnabled(enabled: boolean): Promise<RemoteStatus> {
    const status = enabled ? await this.enable() : await this.disable();
    if (this.configPath) await writeConfigFile(this.configPath, { remote: { enabled } });
    return status;
  }

  /** Re-apply a configured exposure after a start: a no-op when it is already on the right scheme. */
  async ensure(): Promise<RemoteStatus> {
    const current = await this.status();
    if (current.state === "unavailable") return current;
    const wanted: Scheme = current.tailscale.certs ? "https" : "http";
    return current.scheme === wanted ? current : this.enable();
  }

  async qrSvg(url: string): Promise<string> {
    let result: CommandResult;
    try {
      result = await this.qrRun(["-t", "SVG", "-o", "-", url]);
    } catch (error) {
      throw new Error(isMissingBinary(error)
        ? "qrencode is required to create the remote-access QR code."
        : `qrencode failed: ${firstLine((error as Error).message)}`);
    }
    if (result.code !== 0) throw new Error(`qrencode failed: ${firstLine(result.stderr) || result.code}`);
    return result.stdout;
  }

  /** `known` with the Serve side read from `tailscale serve status --json`. */
  private async served(known: RemoteStatus): Promise<RemoteStatus> {
    let result: CommandResult;
    try {
      result = await this.run(["serve", "status", "--json"]);
    } catch (error) {
      return { ...known, problem: serveFailed(firstLine((error as Error).message)) };
    }
    if (result.code !== 0) return { ...known, problem: serveFailed(detail(result)) };
    let scheme: Scheme | null;
    try {
      scheme = servedScheme(JSON.parse(result.stdout), this.target);
    } catch (error) {
      return { ...known, problem: serveFailed(`tailscale serve status returned invalid JSON: ${(error as Error).message}`) };
    }
    return {
      ...known,
      enabled: scheme !== null,
      state: scheme ? "on" : "off",
      scheme,
      url: scheme ? `${scheme}://${known.hostname}/` : null,
      problem: this.operatorProblem,
    };
  }

  /** Ask Tailscale for a Serve change, then re-read the Serve side. A refusal is this call's problem. */
  private async write(current: RemoteStatus, args: string[]): Promise<RemoteStatus> {
    let result: CommandResult;
    try {
      result = await this.run(args);
    } catch (error) {
      return {
        ...current,
        problem: isMissingBinary(error) ? TAILSCALE_MISSING : serveFailed(firstLine((error as Error).message)),
      };
    }
    if (result.code !== 0) {
      const message = detail(result);
      const operator = /operator/i.test(`${result.stderr}\n${result.stdout}`);
      this.operatorProblem = operator ? { code: "operator_required", message, action: OPERATOR_ACTION } : null;
      return {
        ...current,
        tailscale: { ...current.tailscale, operator: !operator },
        problem: this.operatorProblem ?? serveFailed(message),
      };
    }
    this.operatorProblem = null;
    return this.served({ ...current, tailscale: { ...current.tailscale, operator: true } });
  }
}
