import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

export interface RemoteProblem {
  code: string;
  message: string;
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
  run?: CommandRunner;
  qrRun?: CommandRunner;
}

interface TailscaleStatusJson {
  BackendState?: unknown;
  CertDomains?: unknown;
  Self?: {
    DNSName?: unknown;
    UserID?: unknown;
  };
  User?: Record<string, { LoginName?: unknown }>;
}

interface ServeMatch {
  scheme: "https" | "http";
}

const OPERATOR_ACTION = "sudo tailscale set --operator=$USER";

function execRunner(binary: string): CommandRunner {
  return (args) => new Promise((resolvePromise, rejectPromise) => {
    execFile(binary, [...args], { encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise({ stdout, stderr, code: 0 });
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rejectPromise(error);
        return;
      }
      resolvePromise({
        stdout,
        stderr,
        code: typeof error.code === "number" ? error.code : 1,
      });
    });
  });
}

function isMissingBinary(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function oneLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function commandDetail(result: CommandResult, binary = "tailscale"): string {
  return oneLine(result.stderr) || oneLine(result.stdout) || `${binary} exited with code ${result.code}`;
}

function operatorRequired(detail: string): boolean {
  return /requires? operator|operator permissions|use ['"]sudo tailscale|sudo tailscale set --operator/i.test(detail);
}

function unavailableStatus(
  problem: RemoteProblem,
  tailscale: RemoteStatus["tailscale"],
  guests: RemoteStatus["guests"],
  owner: string | null,
  hostname: string | null = null,
): RemoteStatus {
  return {
    enabled: false,
    state: "unavailable",
    scheme: null,
    hostname,
    url: null,
    tailscale,
    guests,
    owner,
    problem,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function proxyMatches(value: unknown, target: string): boolean {
  if (typeof value !== "string") return false;
  return value.replace(/\/$/, "") === target;
}

function findServeMatch(config: unknown, target: string, preferred: "https" | "http"): ServeMatch | null {
  const matches: ServeMatch[] = [];
  const visit = (candidate: unknown): void => {
    const container = object(candidate);
    if (!container) return;
    const tcp = object(container.TCP);
    const web = object(container.Web);
    if (web) {
      for (const [hostPort, rawServer] of Object.entries(web)) {
        const handlers = object(object(rawServer)?.Handlers);
        if (!handlers) continue;
        const found = Object.values(handlers).some((rawHandler) => {
          const handler = object(rawHandler);
          return handler ? proxyMatches(handler.Proxy, target) : false;
        });
        if (!found) continue;
        const port = hostPort.match(/:(\d+)$/)?.[1];
        const portConfig = port ? object(tcp?.[port]) : null;
        if (portConfig?.HTTPS === true || port === "443") matches.push({ scheme: "https" });
        else if (portConfig?.HTTP === true || port === "80") matches.push({ scheme: "http" });
      }
    }
    const services = object(container.Services);
    if (services) for (const service of Object.values(services)) visit(service);
    const foreground = object(container.Foreground);
    if (foreground) for (const entry of Object.values(foreground)) visit(entry);
  };
  visit(config);
  return matches.find((match) => match.scheme === preferred) ?? matches[0] ?? null;
}

function parseJson(stdout: string, command: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${(error as Error).message}`);
  }
}

export class RemoteServe {
  private port: number;
  private readonly run: CommandRunner;
  private readonly qrRun: CommandRunner;
  private readonly configuredOwner: string | null;
  private readonly guests: "read-only" | "none";
  private mutationProblem: RemoteProblem | null = null;

  constructor(port: number, options: RemoteServeOptions = {}) {
    this.port = port;
    this.run = options.run ?? execRunner("tailscale");
    this.qrRun = options.qrRun ?? execRunner("qrencode");
    this.configuredOwner = options.owner?.trim() || null;
    this.guests = options.guests ?? "read-only";
  }

  setPort(port: number): void {
    this.port = port;
  }

  async status(): Promise<RemoteStatus> {
    const blankTailscale: RemoteStatus["tailscale"] = {
      installed: false,
      running: false,
      loggedIn: false,
      operator: this.mutationProblem?.code !== "operator_required",
      certs: false,
    };
    let statusResult: CommandResult;
    try {
      statusResult = await this.run(["status", "--json"]);
    } catch (error) {
      if (isMissingBinary(error)) {
        return unavailableStatus({
          code: "tailscale_missing",
          message: "Tailscale is not installed.",
          action: "omarchy-install-service-tailscale",
        }, blankTailscale, this.guests, this.configuredOwner);
      }
      return unavailableStatus({
        code: "serve_failed",
        message: oneLine((error as Error).message),
      }, { ...blankTailscale, installed: true }, this.guests, this.configuredOwner);
    }
    blankTailscale.installed = true;
    if (statusResult.code !== 0) {
      const detail = commandDetail(statusResult);
      const stopped = /not running|failed to connect to local tailscaled|tailscaled.*stopped/i.test(detail);
      const loggedOut = /not logged in|logged out|needslogin/i.test(detail);
      const problem = stopped
        ? { code: "tailscale_stopped", message: "Tailscale is not running." }
        : loggedOut
          ? { code: "not_logged_in", message: "This machine is not logged in to Tailscale.", action: "tailscale up" }
          : { code: "serve_failed", message: detail };
      return unavailableStatus(problem, blankTailscale, this.guests, this.configuredOwner);
    }

    let statusJson: TailscaleStatusJson;
    try {
      statusJson = parseJson(statusResult.stdout, "tailscale status --json") as TailscaleStatusJson;
    } catch (error) {
      return unavailableStatus({
        code: "serve_failed",
        message: oneLine((error as Error).message),
      }, blankTailscale, this.guests, this.configuredOwner);
    }
    const backendState = typeof statusJson.BackendState === "string" ? statusJson.BackendState : "";
    const running = backendState === "Running";
    const self = object(statusJson.Self);
    const loggedIn = backendState !== "NeedsLogin" && self !== null;
    const hostnameValue = self?.DNSName;
    const hostname = typeof hostnameValue === "string"
      ? hostnameValue.trim().replace(/\.$/, "") || null
      : null;
    const certs = Array.isArray(statusJson.CertDomains)
      && statusJson.CertDomains.some((domain) => typeof domain === "string" && domain.trim() !== "");
    const userId = self?.UserID;
    const selfLogin = statusJson.User?.[String(userId)]?.LoginName;
    const owner = this.configuredOwner
      ?? (typeof selfLogin === "string" && selfLogin.trim() ? selfLogin.trim() : null);
    const tailscale: RemoteStatus["tailscale"] = {
      installed: true,
      running,
      loggedIn,
      operator: this.mutationProblem?.code !== "operator_required",
      certs,
    };
    if (backendState === "NeedsLogin") {
      return unavailableStatus({
        code: "not_logged_in",
        message: "This machine is not logged in to Tailscale.",
        action: "tailscale up",
      }, tailscale, this.guests, owner, hostname);
    }
    if (!running) {
      return unavailableStatus({
        code: "tailscale_stopped",
        message: "Tailscale is not running.",
      }, tailscale, this.guests, owner, hostname);
    }
    if (!loggedIn || !hostname) {
      return unavailableStatus({
        code: "not_logged_in",
        message: "This machine is not logged in to Tailscale.",
        action: "tailscale up",
      }, tailscale, this.guests, owner, hostname);
    }

    let serveResult: CommandResult;
    try {
      serveResult = await this.run(["serve", "status", "--json"]);
    } catch (error) {
      const problem = isMissingBinary(error)
        ? {
            code: "tailscale_missing",
            message: "Tailscale is not installed.",
            action: "omarchy-install-service-tailscale",
          }
        : { code: "serve_failed", message: oneLine((error as Error).message) };
      return unavailableStatus(problem, {
        ...tailscale,
        installed: !isMissingBinary(error),
        running: false,
        loggedIn: false,
      }, this.guests, owner);
    }
    if (serveResult.code !== 0) {
      return {
        enabled: false,
        state: "off",
        scheme: null,
        hostname,
        url: null,
        tailscale,
        guests: this.guests,
        owner,
        problem: this.mutationProblem ?? {
          code: "serve_failed",
          message: commandDetail(serveResult),
        },
      };
    }
    let serveJson: unknown;
    try {
      serveJson = parseJson(serveResult.stdout, "tailscale serve status --json");
    } catch (error) {
      return {
        enabled: false,
        state: "off",
        scheme: null,
        hostname,
        url: null,
        tailscale,
        guests: this.guests,
        owner,
        problem: { code: "serve_failed", message: oneLine((error as Error).message) },
      };
    }
    const preferred = certs ? "https" : "http";
    const match = findServeMatch(serveJson, this.target, preferred);
    const scheme = match?.scheme ?? null;
    const enabled = scheme !== null;
    return {
      enabled,
      state: enabled ? "on" : "off",
      scheme,
      hostname,
      url: scheme ? `${scheme}://${hostname}/` : null,
      tailscale,
      guests: this.guests,
      owner,
      problem: this.mutationProblem,
    };
  }

  async enable(): Promise<RemoteStatus> {
    const before = await this.status();
    if (before.state === "unavailable") return before;
    const scheme = before.tailscale.certs ? "https" : "http";
    const port = scheme === "https" ? 443 : 80;
    this.mutationProblem = null;
    try {
      const result = await this.run(["serve", "--bg", `--${scheme}=${port}`, this.target]);
      if (result.code !== 0) this.mutationProblem = this.problemForMutation(result);
    } catch (error) {
      this.mutationProblem = isMissingBinary(error)
        ? {
            code: "tailscale_missing",
            message: "Tailscale is not installed.",
            action: "omarchy-install-service-tailscale",
          }
        : { code: "serve_failed", message: oneLine((error as Error).message) };
    }
    return this.status();
  }

  async disable(): Promise<RemoteStatus> {
    this.mutationProblem = null;
    let failure: RemoteProblem | null = null;
    for (const args of [
      ["serve", "--https=443", "off"],
      ["serve", "--http=80", "off"],
    ] as const) {
      try {
        const result = await this.run(args);
        if (result.code !== 0 && !/no such/i.test(`${result.stderr}\n${result.stdout}`)) {
          failure ??= this.problemForMutation(result);
        }
      } catch (error) {
        failure ??= isMissingBinary(error)
          ? {
              code: "tailscale_missing",
              message: "Tailscale is not installed.",
              action: "omarchy-install-service-tailscale",
            }
          : { code: "serve_failed", message: oneLine((error as Error).message) };
      }
    }
    this.mutationProblem = failure;
    return this.status();
  }

  async ensure(enabled: boolean): Promise<RemoteStatus> {
    const current = await this.status();
    if (current.state === "unavailable") return current;
    if (!enabled) return current.enabled ? this.disable() : current;
    const expectedScheme = current.tailscale.certs ? "https" : "http";
    return current.enabled && current.scheme === expectedScheme ? current : this.enable();
  }

  async qrSvg(url: string): Promise<string> {
    let result: CommandResult;
    try {
      result = await this.qrRun(["-t", "SVG", "-o", "-", url]);
    } catch (error) {
      if (isMissingBinary(error)) {
        throw new Error("qrencode is required to create the remote-access QR code.");
      }
      throw new Error(`qrencode failed: ${oneLine((error as Error).message)}`);
    }
    if (result.code !== 0) throw new Error(`qrencode failed: ${commandDetail(result, "qrencode")}`);
    return result.stdout;
  }

  private get target(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private problemForMutation(result: CommandResult): RemoteProblem {
    const detail = commandDetail(result);
    return operatorRequired(`${result.stderr}\n${result.stdout}`)
      ? { code: "operator_required", message: detail, action: OPERATOR_ACTION }
      : { code: "serve_failed", message: detail };
  }
}
