#!/usr/bin/env bun
import { isDirectInvocation } from "./direct-invocation.js";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { apiTokenCommand } from "./api-token.js";
import { RemoteAccess } from "./tailscale-identity.js";
import { LoginManager } from "./auth.js";
import { CLAUDE_CODE_BINARY_ENV, ClaudeCodeProbe } from "./claude-code.js";
import { ClaudeAgentSdkLoader } from "./claude-agent-sdk-loader.js";
import { loginCommand } from "./login-command.js";
import { loadConfig, type DaemonConfig, type DaemonConfigOverrides } from "./config.js";
import { captureClaudeCodeEnvironment, scrubProviderEnv } from "./env-scrub.js";
import { closeAllBrowserSessions, ensureGhostHomeLayout } from "./extensions.js";
import { GhostRegistry } from "./ghosts.js";
import { GhostHookRunner } from "./hooks.js";
import { acquireHomeReservation, HomeReservationBusyError, type HomeReservation } from "./home-reservation.js";
import { HomeOperationCoordinator } from "./home-operations.js";
import { hookSmolCompleteCommand } from "./hook-smol-complete.js";
import { createJournalSink } from "./journal.js";
import { createLogger, stderrSink, type Logger, type LogLevel } from "./log.js";
import { McpCatalog } from "./mcp-catalog.js";
import { ModelSelection } from "./model-selection.js";
import { createRelayHub } from "./relay.js";
import { relayTokenCommand } from "./relay-token.js";
import { resolveRunningSource } from "./running-source.js";
import { DAEMON_VERSION } from "./version.js";
import { remoteCommand } from "./remote-command.js";
import { RemoteServe } from "./remote-serve.js";
import { startDaemonServer, type ListeningServer } from "./server.js";
import { SessionHost } from "./session-host.js";
import {
  resolveScheduleRuntimeUnitDirectory,
  resolveScheduleUnitDirectory,
} from "./schedules.js";

const USAGE = `ghostd — your ghost, on your machine

Usage:
  ghostd [options]
  ghostd login [<ghost>] [--provider <id>] [--api-key] [options]
  ghostd relay-token [--rotate] [--quiet]
  ghostd api-token [--rotate] [--quiet]
  ghostd remote [on|off|status]
  ghostd hook-smol-complete

Subcommands:
  login                    Sign a ghost into a model provider from the terminal
                           (the same flow the shell drives over HTTP). Prompts
                           for the ghost and provider when not given; --api-key
                           selects the api-key flow over OAuth.
  relay-token              Print the browser-relay pairing token (minting one on
                           first run) to paste into the Chromium extension.
                           --rotate mints a new one and invalidates the old.
  api-token                Print the bearer token local API clients present
                           (minting one on first run). The shell reads the file
                           itself; this is for curl, scripts, and diagnosing a
                           401. --rotate mints a new one and invalidates the old.
  remote                   Show or change the daemon's tailnet exposure through
                           Tailscale Serve. Defaults to status.
  hook-smol-complete       Internal command-hook bridge. Reads ghost_home,
                           prompt, and an optional role as JSON on stdin and
                           writes that role's one completion as JSON on stdout.

Options:
  -p, --port <port>        TCP port to bind on 127.0.0.1 (default 7717)
      --ghosts-root <dir>  Directory holding one sub-directory per ghost
      --config <file>      Config file (default ~/.config/ghost/config.json)
      --offline            Forbid pi's catalogue network calls (refresh off)
      --log-level <level>  debug | info | warn | error (default info)
  -h, --help               Show this message
  -v, --version            Show the version

Environment:
  GHOSTD_PORT, GHOSTD_HOST, GHOSTS_ROOT, GHOSTD_OFFLINE, GHOSTD_CONFIG,
  XDG_CONFIG_HOME, XDG_STATE_HOME, GHOSTD_API_TOKEN_FILE,
  GHOSTD_RELAY_TOKEN_FILE
`;

export interface ParsedArgs {
  overrides: DaemonConfigOverrides;
  logLevel: LogLevel;
  help: boolean;
  version: boolean;
}

export interface MainRuntime {
  afterHomeReservationAcquired?: () => Promise<void>;
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
export const DEFAULT_SHUTDOWN_FORCE_MS = 2_000;

export interface StagedShutdownOptions {
  /** Synchronously stop listener/session admission. */
  stopAdmission(): void;
  /** Synchronously signal cancellation to active work. */
  abortActive(): void;
  graceful(): Promise<void>;
  /** Best-effort terminal close after the grace deadline. */
  force(): void | Promise<void>;
  graceMs?: number;
  forceMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

function shutdownWait(delayMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, delayMs);
    timer.unref?.();
  });
}

export async function runStagedShutdown(options: StagedShutdownOptions): Promise<"graceful" | "forced"> {
  const wait = options.wait ?? shutdownWait;
  options.stopAdmission();
  options.abortActive();
  const graceful = Promise.resolve().then(options.graceful);
  const settled = graceful.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const result = await Promise.race([
    settled,
    wait(options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS).then(() => null),
  ]);
  if (result !== null) {
    if (!result.ok) {
      await options.force();
      throw result.error;
    }
    return "graceful";
  }
  const forcedCleanup = Promise.resolve().then(options.force);
  const forcedResult = await Promise.race([
    settled,
    wait(options.forceMs ?? DEFAULT_SHUTDOWN_FORCE_MS).then(() => null),
  ]);
  // Provider/session disposal retains a hard deadline, but native process
  // groups do not: returning while one is still owned would orphan it.
  await forcedCleanup;
  if (forcedResult !== null && !forcedResult.ok) throw forcedResult.error;
  return "forced";
}

export interface ShutdownSignalOptions {
  login: Pick<LoginManager, "dispose">;
  listening: Pick<ListeningServer, "server" | "relay" | "close">;
  host: Pick<SessionHost, "beginShutdown" | "disposeAll"> & {
    forceDisposeAll(): void | Promise<void>;
  };
  browsers: { closeAll(): Promise<void> };
  logger: Pick<Logger, "info" | "warn">;
  timing?: Pick<StagedShutdownOptions, "graceMs" | "forceMs" | "wait">;
}

export async function closeDaemonResources(
  options: Pick<ShutdownSignalOptions, "listening" | "host" | "browsers">,
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (close: () => Promise<void>): Promise<void> => {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  };
  // Session teardown is independent, so start it immediately. Browser teardown
  // is ordered: its protocol close needs the relay that listening.close() owns.
  const host = attempt(() => options.host.disposeAll());
  await attempt(() => options.browsers.closeAll());
  await attempt(() => options.listening.close());
  await host;
  if (failures.length > 0) {
    throw new AggregateError(failures, "daemon resources did not close cleanly");
  }
}

export async function waitForShutdownSignal(options: ShutdownSignalOptions): Promise<void> {
  const signalProcess = process as unknown as {
    listeners(event: "SIGINT" | "SIGTERM"): Array<(...args: unknown[]) => void>;
    on(event: "SIGINT" | "SIGTERM", listener: (...args: unknown[]) => void): void;
    off(event: "SIGINT" | "SIGTERM", listener: (...args: unknown[]) => void): void;
  };
  // A CLI-oriented dependency may install eager signal handlers that hard-exit
  // after its own cleanup. ghostd owns process teardown instead: its
  // sessions/providers are drained below, under shorter bounded deadlines.
  const inherited = {
    SIGINT: signalProcess.listeners("SIGINT"),
    SIGTERM: signalProcess.listeners("SIGTERM"),
  };
  for (const listener of inherited.SIGINT) signalProcess.off("SIGINT", listener);
  for (const listener of inherited.SIGTERM) signalProcess.off("SIGTERM", listener);
  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false;
    let forcePromise: Promise<void> | undefined;
    const force = (): Promise<void> => {
      if (forcePromise) return forcePromise;
      options.listening.server.closeAllConnections();
      void options.listening.relay?.close().catch(() => {});
      forcePromise = Promise.resolve(options.host.forceDisposeAll());
      return forcePromise;
    };
    const shutdown = (signal: "SIGINT" | "SIGTERM") => {
      if (shuttingDown) {
        void force().catch(() => {});
        return;
      }
      shuttingDown = true;
      options.logger.info("shutting down", { signal });
      void (async () => {
        try {
          const result = await runStagedShutdown({
            stopAdmission: () => {
              options.login.dispose();
              options.listening.server.close();
              options.listening.server.closeIdleConnections();
            },
            abortActive: () => options.host.beginShutdown(),
            graceful: () => closeDaemonResources(options),
            force,
            ...options.timing,
          });
          if (result === "forced") options.logger.warn("shutdown grace deadline expired");
        } catch (error) {
          options.logger.warn("shutdown was not clean", { error: (error as Error).message });
        } finally {
          signalProcess.off("SIGINT", onSigint);
          signalProcess.off("SIGTERM", onSigterm);
          for (const listener of inherited.SIGINT) signalProcess.on("SIGINT", listener);
          for (const listener of inherited.SIGTERM) signalProcess.on("SIGTERM", listener);
          resolvePromise();
        }
      })();
    };
    const onSigint = () => shutdown("SIGINT");
    const onSigterm = () => shutdown("SIGTERM");
    signalProcess.on("SIGINT", onSigint);
    signalProcess.on("SIGTERM", onSigterm);
  });
}

class UsageError extends Error {}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${flag} requires a value.`);
  }
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: DaemonConfigOverrides = {};
  let logLevel: LogLevel = "info";
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      case "-p":
      case "--port": {
        index += 1;
        const raw = requireValue(argv, index, arg);
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new UsageError(`Invalid port: ${raw}`);
        }
        overrides.port = port;
        break;
      }
      case "--ghosts-root":
        index += 1;
        overrides.ghostsRoot = requireValue(argv, index, arg);
        break;
      case "--config":
        index += 1;
        overrides.configPath = requireValue(argv, index, arg);
        break;
      case "--offline":
        overrides.offline = true;
        break;
      case "--log-level": {
        index += 1;
        const value = requireValue(argv, index, arg);
        if (!["debug", "info", "warn", "error"].includes(value)) {
          throw new UsageError(`Invalid log level: ${value}`);
        }
        logLevel = value as LogLevel;
        break;
      }
      default:
        throw new UsageError(`Unknown option: ${arg}`);
    }
  }
  return { overrides, logLevel, help, version };
}

export async function main(argv: string[] = process.argv.slice(2), runtime: MainRuntime = {}): Promise<number> {
  // Subcommands own their narrower persistence lifecycle. Token commands touch
  // only XDG state, remote touches config and Tailscale Serve, and login takes
  // the home reservation itself.
  if (argv[0] === "relay-token") return relayTokenCommand(argv.slice(1));
  if (argv[0] === "api-token") return apiTokenCommand(argv.slice(1));
  if (argv[0] === "remote") return remoteCommand(argv.slice(1));
  if (argv[0] === "login") return loginCommand(argv.slice(1));
  if (argv[0] === "hook-smol-complete") return hookSmolCompleteCommand(argv.slice(1));

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${DAEMON_VERSION}\n`);
    return 0;
  }

  const journalSink = createJournalSink();
  const logger = createLogger(parsed.logLevel, journalSink ?? stderrSink);
  let config: DaemonConfig;
  try {
    config = loadConfig(parsed.overrides);
  } catch (error) {
    logger.error("configuration is invalid", { error: (error as Error).message });
    return 1;
  }

  // Capture the reviewed Claude child profile before the process-global
  // provider scrub.
  const claudeCodeEnvironment = captureClaudeCodeEnvironment(process.env);
  const claudeBinary = process.env[CLAUDE_CODE_BINARY_ENV];

  // Before pi, before any session. Idempotent, but this is the call that
  // matters: everything downstream inherits this environment.
  const { removed } = scrubProviderEnv(process.env, { offline: config.offline });
  if (removed.length > 0) {
    logger.warn("removed inherited provider credentials and routing overrides", { removed });
  }

  let hooks: GhostHookRunner;
  const hooksPath = config.hooksPath;
  try {
    hooks = GhostHookRunner.fromConfig(hooksPath, { logger });
  } catch (error) {
    logger.error("hook configuration is invalid", {
      path: hooksPath,
      error: (error as Error).message,
    });
    return 1;
  }

  let homeReservation: HomeReservation;
  try {
    homeReservation = await acquireHomeReservation(config.ghostsRoot);
  } catch (error) {
    const detail =
      error instanceof HomeReservationBusyError
        ? "another ghostd is running or a login is in progress"
        : (error as Error).message;
    logger.error("could not reserve the ghost home", {
      ghostsRoot: config.ghostsRoot,
      error: detail,
    });
    return 1;
  }

  try {
    await runtime.afterHomeReservationAcquired?.();
    return await serveDaemon(
      { ...config, ghostsRoot: homeReservation.ghostsRoot },
      logger,
      hooks,
      hooksPath,
      claudeCodeEnvironment,
      claudeBinary,
    );
  } finally {
    await homeReservation.close();
  }
}

async function serveDaemon(
  config: DaemonConfig,
  logger: ReturnType<typeof createLogger>,
  hooks: GhostHookRunner,
  hooksPath: string,
  claudeCodeEnvironment: Readonly<NodeJS.ProcessEnv>,
  claudeBinary: string | undefined,
): Promise<number> {
  const registry = new GhostRegistry(config.ghostsRoot);
  const ownerHome = homedir();
  const scheduleUnitDir = resolveScheduleUnitDirectory(ownerHome);
  const scheduleRuntimeUnitDir = resolveScheduleRuntimeUnitDirectory();
  // What is running: the source checkout behind this process, if it has one.
  const runningSource = resolveRunningSource(
    DAEMON_VERSION,
    dirname(fileURLToPath(import.meta.url)),
  );
  registry.ensureRoot();
  try {
    await Promise.all(registry.list().map(async (ghost) => {
      await ensureGhostHomeLayout(ghost.dir);
    }));
  } catch (error) {
    logger.error("could not ensure a ghost home layout", {
      error: (error as Error).message,
    });
    return 1;
  }

  // One relay hub, shared: the server exposes /relay over it and the session
  // host uses it as the browser backend's transport, so a ghost drives the
  // very browser the extension is connected to. `undefined` when GHOSTD_RELAY
  // is off — there is no second browser to fall back to, so `ghost_browser`
  // then reports that none is reachable.
  const relay = createRelayHub({ logger });
  const homeOperations = new HomeOperationCoordinator(registry);
  const claudeAgentSdk = new ClaudeAgentSdkLoader({ ownerHome });
  const loadClaudeAgentSdk = () => claudeAgentSdk.load();
  const claudeCodeProbe = new ClaudeCodeProbe({
    environment: claudeCodeEnvironment,
    binaryPath: claudeBinary ?? null,
    loadSdk: loadClaudeAgentSdk,
  });
  // One validated SDK install, one executable probe, one reviewed child
  // environment: the principal runtime and the review advisor share them.
  const claudeCode = {
    environment: claudeCodeEnvironment,
    probe: claudeCodeProbe,
    loadSdk: loadClaudeAgentSdk,
  };
  const host = new SessionHost({
    registry,
    homeOperations,
    ownerHome,
    scheduleUnitDir,
    scheduleRuntimeUnitDir,
    runningSource,
    logger,
    offline: config.offline,
    compaction: config.compaction,
    askTimeoutSeconds: config.askTimeoutSeconds,
    hooks,
    extensionOptions: {
      ...(relay ? { relayTransport: relay } : {}),
    },
    claudeCode,
  });
  const login = new LoginManager({
    registry,
    homeOperations,
    logger,
    offline: config.offline,
    onLoginSucceeded: (name, signal) => host.refreshAuth(name, signal),
  });
  const modelSelection = new ModelSelection({
    registry,
    homeOperations,
    // A model switch must reach any conversation that is already open, not just
    // the next freshly built session: rebind the live cached sessions.
    onModelRoutingChanged: (name) => host.rebindModel(name),
  });
  const mcp = new McpCatalog({ registry, homeOperations, logger });
  const remoteServe = new RemoteServe(config.port, { ...config.remote, configPath: config.configPath });

  let listening: ListeningServer;
  try {
    listening = await startDaemonServer({
      registry,
      host,
      homeOperations,
      login,
      models: modelSelection,
      mcp,
      hooks,
      runningSource,
      logger,
      port: config.port,
      address: config.host,
      relay: relay ?? null,
      remote: new RemoteAccess(config.remote),
      remoteServe,
    });
  } catch (error) {
    logger.error("could not bind", {
      host: config.host,
      port: config.port,
      error: (error as Error).message,
    });
    await host.disposeAll();
    return 1;
  }

  if (config.remote.enabled) {
    const status = await remoteServe.ensure();
    if (status.url && !status.problem) logger.info("remote access ready", { url: status.url });
    else logger.warn("remote access is unavailable", { problem: status.problem });
  }

  logger.info("listening", {
    url: `http://${config.host}:${listening.port}`,
    ghostsRoot: config.ghostsRoot,
    ghosts: registry.list().length,
    version: runningSource.version,
    commit: runningSource.commit,
    source: runningSource.root,
    offline: config.offline,
    config: config.configPath,
    hooks: hooksPath,
    // Never the token; `ghostd relay-token` is the only way to see it.
    relay: listening.relay ? `ws://${config.host}:${listening.port}/relay` : "off",
  });

  await waitForShutdownSignal({
    login,
    listening,
    host,
    browsers: { closeAll: closeAllBrowserSessions },
    logger,
  });

  logger.info("stopped");
  return 0;
}

// Only run when executed, so tests can import parseArgs/main.
const invokedDirectly = isDirectInvocation(import.meta.url, process.argv[1]);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`ghostd: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
