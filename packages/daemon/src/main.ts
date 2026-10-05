#!/usr/bin/env bun
import { apiToken, relayToken } from "./token-store.js";
import { isDirectInvocation } from "./direct-invocation.js";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteAccess } from "./tailscale-identity.js";
import {
  loadConfig,
  type DaemonConfig,
  type DaemonConfigOverrides,
} from "./config.js";
import { closeAllBrowserSessions, openGhostHome } from "@ghost/extensions";
import { GhostRegistry } from "./ghosts.js";
import { GhostHookRunner } from "./hooks.js";
import { hookCompleteCommand } from "./hook-complete.js";
import { createLogger, stderrLogSink, type Logger, type LogLevel } from "./log.js";
import { McpCatalog } from "./mcp-catalog.js";
import { createRelayHub } from "./relay.js";
import { resolveRunningSource } from "./running-source.js";
import { DAEMON_VERSION } from "./version.js";
import { remoteCommand } from "./remote-command.js";
import { RemoteServe } from "./remote-serve.js";
import { startDaemonServer, type ListeningServer } from "./server.js";
import { UpdateChecker } from "./update-check.js";
import { SessionHost } from "./session-host.js";
import {
  resolveScheduleUnitDirectory,
} from "./schedules.js";
import { errorMessage } from "@ghost/extensions";

const USAGE = `ghostd — your ghost, on your machine

Usage:
  ghostd [options]
  ghostd relay-token [--rotate] [--quiet]
  ghostd api-token [--rotate] [--quiet]
  ghostd remote [on|off|status]
  ghostd hook-smol-complete

Subcommands:
  relay-token              Print the browser-relay pairing token (minting one on
                           first run) to paste into the Chromium extension.
                           --rotate mints a new one and invalidates the old.
  api-token                Print the bearer token local API clients present
                           (minting one on first run). The shell reads the file
                           itself; this is for curl, scripts, and diagnosing a
                           401. --rotate mints a new one and invalidates the old.
  remote                   Show or change the daemon's tailnet exposure through
                           Tailscale Serve. Defaults to status.
  hook-smol-complete       Command-hook bridge. Reads ghost_home and prompt as
                           JSON on stdin and writes one completion from the
                           ghost's preferred harness as JSON on stdout.

Options:
  -p, --port <port>        TCP port to bind on 127.0.0.1 (default 7717)
      --ghosts-root <dir>  Directory holding one sub-directory per ghost
      --config <file>      Config file (default ~/.config/ghost/config.json)
      --offline            Skip the daily release check
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

export interface ShutdownSignalOptions {
  listening: Pick<ListeningServer, "server" | "relay" | "close">;
  host: Pick<SessionHost, "beginShutdown" | "disposeAll">;
  browsers: { closeAll(): Promise<void> };
  logger: Pick<Logger, "info" | "warn">;
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
  options.listening.server.close();
  options.listening.server.closeIdleConnections();
  options.host.beginShutdown();
  try {
    await closeDaemonResources(options);
  } catch (error) {
    options.logger.warn("shutdown was not clean", { error: errorMessage(error) });
  }
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Subcommands own their narrower persistence lifecycle. Token commands touch
  // only XDG state, and remote touches config and Tailscale Serve.
  if (argv[0] === "relay-token") return relayToken.command(argv.slice(1));
  if (argv[0] === "api-token") return apiToken.command(argv.slice(1));
  if (argv[0] === "remote") return remoteCommand(argv.slice(1));
  if (argv[0] === "hook-smol-complete") return hookCompleteCommand(argv.slice(1));

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

  let hooks: GhostHookRunner;
  const hooksPath = config.hooksPath;
  try {
    hooks = GhostHookRunner.fromConfig(hooksPath, { logger });
  } catch (error) {
    logger.error("hook configuration is invalid", {
      path: hooksPath,
      error: errorMessage(error),
    });
    return 1;
  }

  return await serveDaemon(config, logger, hooks, hooksPath);
}

async function serveDaemon(
  config: DaemonConfig,
  logger: ReturnType<typeof createLogger>,
  hooks: GhostHookRunner,
  hooksPath: string,
): Promise<number> {
  const registry = new GhostRegistry(config.ghostsRoot);
  const ownerHome = homedir();
  const scheduleUnitDir = resolveScheduleUnitDirectory(ownerHome);
  // What is running: the source checkout behind this process, if it has one.
  const runningSource = resolveRunningSource(
    DAEMON_VERSION,
    dirname(fileURLToPath(import.meta.url)),
  );
  const updates = config.offline
    ? null
    : new UpdateChecker({ version: runningSource.version, sourceRoot: runningSource.root, logger });
  updates?.start();
  registry.ensureRoot();
  try {
    await Promise.all(registry.list().map((ghost) => openGhostHome(ghost.dir).ensure()));
  } catch (error) {
    logger.error("could not ensure a ghost home layout", {
      error: errorMessage(error),
    });
    return 1;
  }

  // One relay hub, shared: the server exposes /relay over it and the session
  // host uses it as the browser backend's transport, so a ghost drives the
  // very browser the extension is connected to. `undefined` when GHOSTD_RELAY
  // is off — there is no second browser to fall back to, so `ghost_browser`
  // then reports that none is reachable.
  const relay = createRelayHub({ logger });
  const host = new SessionHost({
    registry,
    ownerHome,
    scheduleUnitDir,
    runningSource,
    logger,
    hooks,
    extensionOptions: {
      ...(relay ? { relayTransport: relay } : {}),
    },
  });
  const mcp = new McpCatalog({ registry });
  const remoteServe = new RemoteServe(config.port, { ...config.remote, configPath: config.configPath });

  let listening: ListeningServer;
  try {
    listening = await startDaemonServer({
      registry,
      host,
      mcp,
      hooks,
      runningSource,
      update: () => updates?.current ?? null,
      logger,
      port: config.port,
      address: config.host,
      ...(relay ? { relay } : {}),
      remote: new RemoteAccess(config.remote),
      remoteServe,
    });
  } catch (error) {
    logger.error("could not bind", {
      host: config.host,
      port: config.port,
      error: errorMessage(error),
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
      process.stderr.write(`ghostd: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
