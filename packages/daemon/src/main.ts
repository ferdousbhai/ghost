#!/usr/bin/env bun
import { apiTokenCommand } from "./token-store.js";
import { isDirectInvocation } from "./direct-invocation.js";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { RemoteAccess } from "./tailscale-identity.js";
import {
  loadConfig,
  type DaemonConfig,
  type DaemonConfigOverrides,
} from "./config.js";
import { parseArgs as parseNodeArgs } from "node:util";
import { errorMessage } from "./errors.js";
import { GhostRegistry } from "./ghosts.js";
import { type ConfiguredHookRunner, GhostHookRunner } from "./hooks.js";
import { hookCompleteCommand } from "./hook-complete.js";
import { createLogger, stderrLogSink, type Logger, type LogLevel } from "./log.js";
import { LocalModel } from "./local-model.js";
import { DAEMON_HOST } from "./loopback.js";
import { McpCatalog } from "./mcp-catalog.js";
import { resolveRunningSource } from "./running-source.js";
import { DAEMON_VERSION } from "./version.js";
import { RemoteServe } from "./remote-serve.js";
import { startDaemonServer, type ListeningServer } from "./server.js";
import { SessionHost } from "./session-host.js";
import {
  resolveScheduleUnitDirectory,
} from "./schedules.js";

const USAGE = `ghostd — your ghost, on your machine

Usage:
  ghostd [options]
  ghostd api-token [--quiet]
  ghostd hook-complete

Subcommands:
  api-token                Print the bearer token local API clients present
                           (minting one on first run). The shell reads the file
                           itself; this is for curl, scripts, and diagnosing a
                           401. To replace it, delete the file and restart.
  hook-complete            Command-hook bridge. Reads ghost_home and prompt as
                           JSON on stdin, asks the running daemon, and writes
                           one completion from the ghost's preferred harness
                           or the local model as JSON on stdout.

Options:
  -p, --port <port>        TCP port to bind on 127.0.0.1 (default 7717)
      --ghosts-root <dir>  Directory holding one sub-directory per ghost
      --config <file>      Config file (default ~/.config/ghost/config.json)
      --log-level <level>  info | warn | error (default info)
  -h, --help               Show this message
  -v, --version            Show the version

Environment:
  GHOSTD_PORT, GHOSTS_ROOT, GHOSTD_CONFIG, GHOSTD_HOOKS,
  GHOSTD_API_TOKEN_FILE, XDG_CONFIG_HOME, XDG_STATE_HOME,
  XDG_CACHE_HOME, XDG_DOCUMENTS_DIR
`;

interface ParsedArgs {
  overrides: DaemonConfigOverrides;
  logLevel: LogLevel;
  help: boolean;
  version: boolean;
}

interface ShutdownSignalOptions {
  listening: Pick<ListeningServer, "close">;
  host: Pick<SessionHost, "disposeAll">;
  logger: Pick<Logger, "info" | "warn">;
}

export async function closeDaemonResources(
  options: Pick<ShutdownSignalOptions, "listening" | "host">,
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (close: () => Promise<void>): Promise<void> => {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  };
  const host = attempt(() => options.host.disposeAll());
  await attempt(() => options.listening.close());
  await host;
  if (failures.length > 0) {
    throw new AggregateError(failures, "daemon resources did not close cleanly");
  }
}

/**
 * Wait for SIGINT or SIGTERM, then stop accepting work, abort running turns,
 * and close everything. A second signal finds no handler and ends the
 * process outright; systemd's `TimeoutStopSec` bounds the whole stop.
 */
export async function waitForShutdownSignal(options: ShutdownSignalOptions): Promise<void> {
  const signal = await new Promise<NodeJS.Signals>((resolvePromise) => {
    process.once("SIGINT", () => resolvePromise("SIGINT"));
    process.once("SIGTERM", () => resolvePromise("SIGTERM"));
  });
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  options.logger.info("shutting down", { signal });
  try {
    await closeDaemonResources(options);
  } catch (error) {
    options.logger.warn("shutdown was not clean", { error: errorMessage(error) });
  }
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  let values: { help?: boolean; version?: boolean; port?: string; "ghosts-root"?: string; config?: string; "log-level"?: string };
  try {
    ({ values } = parseNodeArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        port: { type: "string", short: "p" },
        "ghosts-root": { type: "string" },
        config: { type: "string" },
        "log-level": { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  const overrides: DaemonConfigOverrides = {};
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new UsageError(`Invalid port: ${values.port}`);
    overrides.port = port;
  }
  if (values["ghosts-root"] !== undefined) overrides.ghostsRoot = values["ghosts-root"];
  if (values.config !== undefined) overrides.configPath = values.config;
  const logLevel = values["log-level"] ?? "info";
  if (!["info", "warn", "error"].includes(logLevel)) throw new UsageError(`Invalid log level: ${logLevel}`);
  return { overrides, logLevel: logLevel as LogLevel, help: values.help === true, version: values.version === true };
}

/**
 * Point every child — a harness turn, a hook, `ghostd hook-complete`, `ghost`
 * — at this daemon: a `--port`, `--config`, or `--ghosts-root` flag is
 * otherwise invisible to them, and they would address the default daemon.
 */
export function exportDaemonEnv(config: DaemonConfig, port: number, env: NodeJS.ProcessEnv = process.env): void {
  env.GHOSTD_PORT = String(port);
  env.GHOSTD_CONFIG = config.configPath;
  env.GHOSTS_ROOT = config.ghostsRoot;
  env.GHOSTD_HOOKS = config.hooksPath;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Subcommands own their narrower persistence lifecycle. Token commands touch
  // only XDG state.
  if (argv[0] === "api-token") return apiTokenCommand(argv.slice(1));
  if (argv[0] === "hook-complete") return hookCompleteCommand(argv.slice(1));

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
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

  const logger = createLogger(parsed.logLevel, stderrLogSink());
  let config: DaemonConfig;
  try {
    config = loadConfig(parsed.overrides);
  } catch (error) {
    logger.error("configuration is invalid", { error: errorMessage(error) });
    return 1;
  }

  let hooks: ConfiguredHookRunner;
  try {
    hooks = GhostHookRunner.fromConfig(config.hooksPath, { logger });
  } catch (error) {
    logger.error("hook configuration is invalid", {
      path: config.hooksPath,
      error: errorMessage(error),
    });
    return 1;
  }

  return await serveDaemon(config, logger, hooks);
}

async function serveDaemon(
  config: DaemonConfig,
  logger: ReturnType<typeof createLogger>,
  hooks: ConfiguredHookRunner,
): Promise<number> {
  const registry = new GhostRegistry(config.ghostsRoot);
  const ownerHome = homedir();
  const scheduleUnitDir = resolveScheduleUnitDirectory(ownerHome);
  // What is running: the source checkout behind this process, if it has one.
  const runningSource = resolveRunningSource(DAEMON_VERSION, fileURLToPath(import.meta.url));
  registry.ensureRoot();

  const remoteServe = new RemoteServe(config.port, config.remote);
  const host = new SessionHost({
    registry,
    ownerHome,
    scheduleUnitDir,
    conversationUrl: (ghost, id) => remoteServe.conversationUrl(ghost, id),
    logger,
    hooks,
    localModel: config.local ? new LocalModel(config.local, logger.child({ part: "local-model" })) : null,
  });
  const mcp = new McpCatalog({ registry });

  let listening: ListeningServer;
  try {
    listening = await startDaemonServer({
      registry,
      host,
      mcp,
      hooks,
      runningSource,
      logger,
      port: config.port,
      remote: new RemoteAccess(config.remote),
      remoteApps: config.remote.apps,
      remoteServe,
    });
  } catch (error) {
    logger.error("could not bind", {
      port: config.port,
      error: errorMessage(error),
    });
    await host.disposeAll();
    return 1;
  }
  exportDaemonEnv(config, listening.port);

  logger.info("listening", {
    url: `http://${DAEMON_HOST}:${listening.port}`,
    ghostsRoot: config.ghostsRoot,
    ghosts: registry.list().length,
    version: runningSource.version,
    commit: runningSource.commit,
    source: runningSource.root,
    config: config.configPath,
    hooks: config.hooksPath,
  });
  void host.resumeEventTurns().catch((error: unknown) => logger.warn("event reruns not started", { error: errorMessage(error) }));

  await waitForShutdownSignal({
    listening,
    host,
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
      process.stderr.write(`ghostd: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
