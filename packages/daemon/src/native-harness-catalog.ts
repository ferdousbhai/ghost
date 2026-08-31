import { createHash } from "node:crypto";
import {
  ClaudeCodeProbe,
  type ClaudeCodeProbeOptions,
} from "./claude-code.js";
import { ClaudeAgentSdkLoader } from "./claude-agent-sdk-loader.js";
import { captureNativeHarnessEnvironment } from "./env-scrub.js";
import {
  inspectNativeHarnessExecutable,
  resolveNativeHarnessExecutable,
  type NativeHarnessExecutable,
  type NativeHarnessId,
} from "./native-harness-identity.js";
import { runOwnedCommand } from "./owned-process.js";

export const CODEX_BINARY_ENV = "GHOST_CODEX_BINARY";
export const PI_BINARY_ENV = "GHOST_PI_BINARY";
export const NATIVE_HARNESS_CATALOG_TTL_MS = 5_000;
export const MAX_NATIVE_HARNESS_CATALOG_TTL_MS = 30_000;
export const NATIVE_HARNESS_PROBE_TIMEOUT_MS = 10_000;

export type NativeHarnessAuthentication = "authenticated" | "logged_out" | "unknown";
export type NativeHarnessAvailability = "available" | "unavailable";

/** The complete public row exposed by the daemon, HUD, and local status CLI. */
export interface NativeHarnessStatus {
  readonly id: NativeHarnessId;
  readonly availability: NativeHarnessAvailability;
  readonly authentication: NativeHarnessAuthentication;
}

/** Private process-admission evidence. Never project this onto the daemon wire. */
export interface NativeHarnessProbeResult {
  readonly id: NativeHarnessId;
  readonly executable: NativeHarnessExecutable;
  readonly version: string;
  readonly authentication: NativeHarnessAuthentication;
  readonly runtimeIdentity: string;
  readonly accountFingerprint?: string;
}

export interface NativeHarnessFreshProbe {
  readonly id: NativeHarnessId;
  readFresh(signal?: AbortSignal): Promise<NativeHarnessProbeResult>;
}

interface NativeHarnessProbeOptions {
  /** `null` deliberately disables the ambient selector fallback. */
  binaryPath?: string | null;
  environment?: Readonly<NodeJS.ProcessEnv>;
  timeoutMs?: number;
}

function probeTimeout(value: number | undefined): number {
  const timeoutMs = value ?? NATIVE_HARNESS_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Native harness probe timeout must be a finite positive number.");
  }
  return timeoutMs;
}

function privateRuntimeIdentity(
  executable: NativeHarnessExecutable,
  version: string,
  authentication: NativeHarnessAuthentication,
  accountFingerprint?: string,
): string {
  return createHash("sha256").update(JSON.stringify([
    executable.identity,
    version,
    authentication,
    accountFingerprint ?? null,
  ])).digest("hex");
}

function frozenProbeResult(
  id: NativeHarnessId,
  executable: NativeHarnessExecutable,
  version: string,
  authentication: NativeHarnessAuthentication,
  accountFingerprint?: string,
): NativeHarnessProbeResult {
  return Object.freeze({
    id,
    executable,
    version,
    authentication,
    runtimeIdentity: privateRuntimeIdentity(
      executable,
      version,
      authentication,
      accountFingerprint,
    ),
    ...(accountFingerprint ? { accountFingerprint } : {}),
  });
}

function assertProbeActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Native harness probe was aborted.");
}

async function revalidateExecutable(
  executable: NativeHarnessExecutable,
  signal?: AbortSignal,
): Promise<void> {
  const current = await inspectNativeHarnessExecutable(
    executable.path,
    executable.literalBoundary,
    signal,
  );
  if (current !== executable.identity) {
    throw new Error("Native harness executable changed during its probe.");
  }
}

function stableVersion(
  raw: string,
  pattern: RegExp,
  label: string,
): string {
  const match = pattern.exec(raw);
  if (!match) throw new Error(`${label} returned an invalid stable version.`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export interface ClaudeNativeHarnessProbeOptions
  extends Omit<ClaudeCodeProbeOptions, "loadSdk"> {
  sdkLoader: ClaudeAgentSdkLoader;
}

export class ClaudeNativeHarnessProbe implements NativeHarnessFreshProbe {
  readonly id = "claude-code" as const;
  private readonly probe: ClaudeCodeProbe;
  private readonly literalBoundary: boolean;

  constructor(options: ClaudeNativeHarnessProbeOptions) {
    if (!(options?.sdkLoader instanceof ClaudeAgentSdkLoader)) {
      throw new TypeError("Claude native harness probe requires the principal SDK loader.");
    }
    const { sdkLoader, ...probeOptions } = options;
    const binaryPath = options.binaryPath === null
      ? undefined
      : options.binaryPath ?? process.env.GHOST_CLAUDE_BINARY;
    this.literalBoundary = binaryPath !== undefined;
    this.probe = new ClaudeCodeProbe({
      ...probeOptions,
      binaryPath: binaryPath ?? null,
      environmentProfile: "native",
      loadSdk: (signal) => sdkLoader.load(signal),
    });
  }

  async readFresh(signal?: AbortSignal): Promise<NativeHarnessProbeResult> {
    const result = await this.probe.readForTurn(signal);
    assertProbeActive(signal);
    const executable = Object.freeze({
      path: result.binaryPath,
      identity: result.executableIdentity,
      literalBoundary: this.literalBoundary,
    });
    const authentication = result.authStatus.loggedIn ? "authenticated" : "logged_out";
    return frozenProbeResult(
      this.id,
      executable,
      result.cliVersion,
      authentication,
      result.authStatus.accountFingerprint,
    );
  }
}

export class CodexNativeHarnessProbe implements NativeHarnessFreshProbe {
  readonly id = "codex" as const;
  private readonly binaryPath: string | undefined;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly timeoutMs: number;

  constructor(options: NativeHarnessProbeOptions = {}) {
    this.binaryPath = options.binaryPath === null
      ? undefined
      : options.binaryPath ?? process.env[CODEX_BINARY_ENV];
    this.environment = captureNativeHarnessEnvironment(
      "codex-native",
      options.environment ?? process.env,
    );
    this.timeoutMs = probeTimeout(options.timeoutMs);
  }

  async readFresh(signal?: AbortSignal): Promise<NativeHarnessProbeResult> {
    assertProbeActive(signal);
    const executable = await resolveNativeHarnessExecutable({
      harness: this.id,
      ...(this.binaryPath === undefined ? {} : { explicitBinary: this.binaryPath }),
      environment: this.environment,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    const versionResult = await runOwnedCommand(executable.path, ["--version"], {
      environment: this.environment,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (versionResult.exitCode !== 0 || versionResult.signal) {
      throw new Error("Codex version probe failed.");
    }
    const version = stableVersion(
      versionResult.stdout,
      /^codex-cli (0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\n?$/u,
      "Codex version probe",
    );
    await revalidateExecutable(executable, signal);
    const account = await readCodexAccount(
      executable,
      this.environment,
      this.timeoutMs,
      signal,
    );
    await revalidateExecutable(executable, signal);
    assertProbeActive(signal);
    return frozenProbeResult(
      this.id,
      executable,
      version,
      account.authentication,
      account.accountFingerprint,
    );
  }
}

interface CodexAccountState {
  authentication: NativeHarnessAuthentication;
  accountFingerprint?: string;
}

const CODEX_INITIALIZE_ID = "ghost-initialize";
const CODEX_ACCOUNT_ID = "ghost-account";

async function readCodexAccount(
  executable: NativeHarnessExecutable,
  environment: Readonly<NodeJS.ProcessEnv>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CodexAccountState> {
  const initializeRequest = JSON.stringify({
    id: CODEX_INITIALIZE_ID,
    method: "initialize",
    params: { clientInfo: { name: "ghostd", version: "0.0.1" } },
  }) + "\n";
  const afterInitialize = [
    { method: "initialized" },
    {
      id: CODEX_ACCOUNT_ID,
      method: "account/read",
      params: { refreshToken: false },
    },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  let initializationAccepted = false;
  let accountReceived = false;
  const result = await runOwnedCommand(executable.path, ["app-server"], {
    environment,
    timeoutMs,
    ...(signal ? { signal } : {}),
    start: (input) => input.write(initializeRequest),
    onStdout: (stdout, input) => {
      for (const line of stdout.split(/\r?\n/u).slice(0, -1)) {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          throw new Error("Codex initialize response was malformed.");
        }
        if (!isRecord(message)) throw new Error("Codex app-server response was invalid.");
        if ("id" in message
          && (typeof message.id !== "string"
            || (message.id !== CODEX_INITIALIZE_ID && message.id !== CODEX_ACCOUNT_ID)
            || typeof message.method === "string")) {
          throw new Error("Codex app-server returned an unexpected response.");
        }
        if (message.id === CODEX_INITIALIZE_ID && !initializationAccepted) {
          if (!isRecord(message.result) || message.error !== undefined) {
            throw new Error("Codex initialize response was invalid.");
          }
          initializationAccepted = true;
          input.write(afterInitialize);
        } else if (message.id === CODEX_ACCOUNT_ID && !accountReceived) {
          accountReceived = true;
          input.end();
        }
      }
    },
  });
  if (result.exitCode !== 0 || result.signal) throw new Error("Codex account probe failed.");
  const responses = parseCodexResponses(result.stdout);
  const initialize = responses.get(CODEX_INITIALIZE_ID);
  const account = responses.get(CODEX_ACCOUNT_ID);
  if (!isRecord(initialize?.result) || initialize?.error !== undefined) {
    throw new Error("Codex initialize response was invalid.");
  }
  if (!isRecord(account?.result) || account?.error !== undefined) {
    throw new Error("Codex account response was invalid.");
  }
  const accountResult = account.result;
  if (typeof accountResult.requiresOpenaiAuth !== "boolean") {
    throw new Error("Codex account response omitted its authentication requirement.");
  }
  if (accountResult.account === null) {
    return {
      authentication: accountResult.requiresOpenaiAuth ? "logged_out" : "unknown",
    };
  }
  if (!isRecord(accountResult.account)) throw new Error("Codex account response was invalid.");
  const type = accountResult.account.type;
  if (typeof type !== "string" || !/^[a-z][a-zA-Z0-9]{0,63}$/u.test(type)) {
    throw new Error("Codex account response had an invalid account type.");
  }
  const email = boundedAccountField(accountResult.account.email);
  const accountFingerprint = createHash("sha256")
    .update(JSON.stringify([type, email ?? null]))
    .digest("hex");
  return { authentication: "authenticated", accountFingerprint };
}

function boundedAccountField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const scalars = [...trimmed];
  if (!trimmed || scalars.length > 512) return undefined;
  if (scalars.some((scalar) => {
    const codePoint = scalar.charCodeAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) return undefined;
  return trimmed;
}

interface CodexResponse {
  result?: unknown;
  error?: unknown;
}

function parseCodexResponses(raw: string): Map<string, CodexResponse> {
  const responses = new Map<string, CodexResponse>();
  const lines = raw.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0 || lines.length > 64) {
    throw new Error("Codex app-server returned an invalid response count.");
  }
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Codex app-server returned malformed JSON.");
    }
    if (!isRecord(parsed)) throw new Error("Codex app-server returned a malformed message.");
    if (!("id" in parsed)) {
      if (typeof parsed.method !== "string") {
        throw new Error("Codex app-server returned a malformed notification.");
      }
      continue;
    }
    if (typeof parsed.id !== "string"
      || (parsed.id !== CODEX_INITIALIZE_ID && parsed.id !== CODEX_ACCOUNT_ID)
      || responses.has(parsed.id)
      || typeof parsed.method === "string") {
      throw new Error("Codex app-server returned an unexpected response.");
    }
    responses.set(parsed.id, { result: parsed.result, error: parsed.error });
  }
  if (responses.size !== 2) throw new Error("Codex app-server omitted a response.");
  return responses;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class PiNativeHarnessProbe implements NativeHarnessFreshProbe {
  readonly id = "pi" as const;
  private readonly binaryPath: string | undefined;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly timeoutMs: number;

  constructor(options: NativeHarnessProbeOptions = {}) {
    this.binaryPath = options.binaryPath === null
      ? undefined
      : options.binaryPath ?? process.env[PI_BINARY_ENV];
    this.environment = captureNativeHarnessEnvironment(
      "pi-native",
      options.environment ?? process.env,
    );
    this.timeoutMs = probeTimeout(options.timeoutMs);
  }

  async readFresh(signal?: AbortSignal): Promise<NativeHarnessProbeResult> {
    assertProbeActive(signal);
    const executable = await resolveNativeHarnessExecutable({
      harness: this.id,
      ...(this.binaryPath === undefined ? {} : { explicitBinary: this.binaryPath }),
      environment: this.environment,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    const result = await runOwnedCommand(executable.path, ["--version"], {
      environment: this.environment,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0 || result.signal) throw new Error("Pi version probe failed.");
    const version = stableVersion(
      result.stdout,
      /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\n?$/u,
      "Pi version probe",
    );
    await revalidateExecutable(executable, signal);
    assertProbeActive(signal);
    return frozenProbeResult(this.id, executable, version, "unknown");
  }
}

interface NativeHarnessCatalogBaseOptions {
  ttlMs?: number;
  now?: () => number;
}

export interface NativeHarnessCatalogOptions extends NativeHarnessCatalogBaseOptions {
  claudeAgentSdkLoader: ClaudeAgentSdkLoader;
  claudeCode?: Omit<ClaudeNativeHarnessProbeOptions, "sdkLoader">;
  /** Dependency seam for deterministic catalogue tests. */
  probes?: Readonly<Record<NativeHarnessId, NativeHarnessFreshProbe>>;
}

export class NativeHarnessCatalog {
  private readonly probes: Readonly<Record<NativeHarnessId, NativeHarnessFreshProbe>>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private generation = 0;
  private cached?: { statuses: readonly NativeHarnessStatus[]; expiresAt: number };
  private inFlight?: {
    generation: number;
    promise: Promise<readonly NativeHarnessStatus[]>;
  };

  constructor(options: NativeHarnessCatalogOptions) {
    if (!(options?.claudeAgentSdkLoader instanceof ClaudeAgentSdkLoader)) {
      throw new TypeError("Native harness catalogue requires the principal SDK loader.");
    }
    this.probes = options.probes ?? {
      "claude-code": new ClaudeNativeHarnessProbe({
        ...options.claudeCode,
        sdkLoader: options.claudeAgentSdkLoader,
      }),
      codex: new CodexNativeHarnessProbe(),
      pi: new PiNativeHarnessProbe(),
    };
    this.ttlMs = options.ttlMs ?? NATIVE_HARNESS_CATALOG_TTL_MS;
    if (!Number.isFinite(this.ttlMs)
      || this.ttlMs <= 0
      || this.ttlMs > MAX_NATIVE_HARNESS_CATALOG_TTL_MS) {
      throw new RangeError(
        `Native harness catalogue ttlMs must be finite and in `
          + `(0, ${MAX_NATIVE_HARNESS_CATALOG_TTL_MS}].`,
      );
    }
    this.now = options.now ?? Date.now;
  }

  list(): Promise<readonly NativeHarnessStatus[]> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt) return Promise.resolve(this.cached.statuses);
    const generation = this.generation;
    if (this.inFlight?.generation === generation) return this.inFlight.promise;
    const promise = this.readStatuses(generation);
    this.inFlight = { generation, promise };
    void promise.then(
      () => {
        if (this.inFlight?.promise === promise) this.inFlight = undefined;
      },
      () => {
        if (this.inFlight?.promise === promise) this.inFlight = undefined;
      },
    );
    return promise;
  }

  /** Admission path: deliberately bypasses the display cache. */
  async readForStart(
    id: NativeHarnessId,
    signal: AbortSignal,
  ): Promise<NativeHarnessProbeResult> {
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError("Native harness start probe requires an AbortSignal.");
    }
    assertProbeActive(signal);
    const result = await this.probes[id].readFresh(signal);
    assertProbeActive(signal);
    if (result.id !== id) throw new Error("Native harness probe identity did not match its slot.");
    return result;
  }

  invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.inFlight = undefined;
  }

  private async readStatuses(generation: number): Promise<readonly NativeHarnessStatus[]> {
    const ids = ["claude-code", "codex", "pi"] as const;
    const statuses = await Promise.all(ids.map(async (id): Promise<NativeHarnessStatus> => {
      try {
        const result = await this.probes[id].readFresh();
        if (result.id !== id) throw new Error("Native harness probe identity did not match its slot.");
        return Object.freeze({
          id,
          availability: "available",
          authentication: result.authentication,
        });
      } catch {
        return Object.freeze({ id, availability: "unavailable", authentication: "unknown" });
      }
    }));
    const frozen = Object.freeze(statuses);
    if (generation === this.generation) {
      this.cached = { statuses: frozen, expiresAt: this.now() + this.ttlMs };
    }
    return frozen;
  }
}
