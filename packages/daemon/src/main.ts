#!/usr/bin/env bun
/**
 * `ghostd` — the Ghost daemon.
 *
 *   ghostd                    serve on the configured port (default 7717)
 *   ghostd --port 7788        serve on an explicit port
 *   ghostd --ghosts-root DIR  serve ghosts from DIR instead of ~/Ghosts
 *   ghostd --offline          forbid OMP's catalogue network calls (see README)
 *   ghostd --version | --help
 *
 * The very first thing this does — before OMP is touched, before a session
 * exists — is scrub inherited provider credentials out of the process
 * environment. See env-scrub.ts for why.
 */
import { pathToFileURL } from "node:url";
import { apiTokenCommand } from "./api-token.js";
import { LoginManager } from "./auth.js";
import { importCommand } from "./import-command.js";
import { loginCommand } from "./login-command.js";
import { loadConfig, type DaemonConfig, type DaemonConfigOverrides } from "./config.js";
import { scrubProviderEnv } from "./env-scrub.js";
import { ensureGhostHomeLayout } from "./extensions.js";
import { GhostRegistry } from "./ghosts.js";
import { GhostHookRunner } from "./hooks.js";
import { acquireHomeReservation, HomeReservationBusyError, type HomeReservation } from "./home-reservation.js";
import { HomeOperationCoordinator } from "./home-operations.js";
import { migrateHostedConversations } from "./hosted-conversation-import.js";
import { createLogger, type LogLevel } from "./log.js";
import { McpCatalog } from "./mcp-catalog.js";
import { ModelCatalog } from "./model-catalog.js";
import { createRelayHub } from "./relay.js";
import { relayTokenCommand } from "./relay-token.js";
import { startDaemonServer, type ListeningServer } from "./server.js";
import { SessionHost } from "./session-host.js";

const USAGE = `ghostd — your ghost, on your machine

Usage:
  ghostd [options]
  ghostd import <archive> [--name <name>] [--overwrite] [options]
  ghostd login [<ghost>] [--provider <id>] [--api-key] [options]
  ghostd relay-token [--rotate] [--quiet]
  ghostd api-token [--rotate] [--quiet]

Subcommands:
  import                   Import a ghost from a "Download my ghost" archive
                           (zip or directory) into ~/Ghosts/<name>.
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

Options:
  -p, --port <port>        TCP port to bind on 127.0.0.1 (default 7717)
      --ghosts-root <dir>  Directory holding one sub-directory per ghost
      --config <file>      Config file (default ~/.config/ghost/config.json)
      --offline            Forbid OMP's catalogue network calls (refresh off)
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
  /** Test observer called after the root reservation and before home access. */
  afterHomeReservationAcquired?: () => Promise<void>;
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

async function readVersion(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const text = await readFile(join(here, "..", "package.json"), "utf8");
  return (JSON.parse(text) as { version?: string }).version ?? "0.0.0";
}

export async function main(argv: string[] = process.argv.slice(2), runtime: MainRuntime = {}): Promise<number> {
  // Subcommands own their narrower persistence lifecycle. Token commands touch
  // only XDG state; login and import take the home reservation themselves.
  if (argv[0] === "relay-token") return relayTokenCommand(argv.slice(1));
  if (argv[0] === "api-token") return apiTokenCommand(argv.slice(1));
  if (argv[0] === "login") return loginCommand(argv.slice(1));
  if (argv[0] === "import") return importCommand(argv.slice(1));

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
    process.stdout.write(`${await readVersion()}\n`);
    return 0;
  }

  const logger = createLogger(parsed.logLevel);
  let config: DaemonConfig;
  try {
    config = loadConfig(parsed.overrides);
  } catch (error) {
    logger.error("configuration is invalid", { error: (error as Error).message });
    return 1;
  }

  // Before OMP, before any session. Idempotent, but this is the call that
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
        ? "another ghostd is running or an import/login is in progress"
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
): Promise<number> {
  const registry = new GhostRegistry(config.ghostsRoot);
  registry.ensureRoot();
  try {
    await Promise.all(registry.list().map(async (ghost) => {
      await ensureGhostHomeLayout(ghost.dir);
      const conversations = await migrateHostedConversations(ghost.dir);
      if (conversations.imported > 0) {
        logger.info("activated hosted conversations as native sessions", {
          ghost: ghost.name,
          imported: conversations.imported,
          existing: conversations.existing,
        });
      }
      for (const failure of conversations.failures) {
        logger.warn("could not activate hosted conversation; source left unchanged", {
          ghost: ghost.name,
          source: failure.source,
          error: failure.error,
        });
      }
    }));
  } catch (error) {
    logger.error("could not migrate a ghost home layout", {
      error: (error as Error).message,
    });
    return 1;
  }

  // One relay hub, shared: the server exposes /relay over it and the session
  // host uses it as the browser backend's transport, so a ghost drives the
  // very browser the extension is connected to. `undefined` when GHOSTD_RELAY
  // is off, which also disables the relay browser mode (sessions fall back to
  // the per-ghost profile).
  const relay = createRelayHub({ logger });
  const homeOperations = new HomeOperationCoordinator(registry);
  const host = new SessionHost({
    registry,
    logger,
    offline: config.offline,
    browserMode: config.browserMode,
    compaction: config.compaction,
    askTimeoutSeconds: config.askTimeoutSeconds,
    hooks,
    ...(relay ? { relayTransport: relay } : {}),
  });
  const login = new LoginManager({ registry, logger, offline: config.offline });
  const catalog = new ModelCatalog({
    registry,
    homeOperations,
    logger,
    offline: config.offline,
    // A model switch must reach any conversation that is already open, not just
    // the next freshly built session: rebind the live cached sessions.
    onModelRoutingChanged: (name) => host.rebindModel(name),
  });
  const mcp = new McpCatalog({ registry, homeOperations });

  let listening: ListeningServer;
  try {
    listening = await startDaemonServer({
      registry,
      host,
      homeOperations,
      login,
      catalog,
      mcp,
      logger,
      port: config.port,
      address: config.host,
      relay: relay ?? null,
    });
  } catch (error) {
    logger.error("could not bind", {
      host: config.host,
      port: config.port,
      error: (error as Error).message,
    });
    return 1;
  }

  logger.info("listening", {
    url: `http://${config.host}:${listening.port}`,
    ghostsRoot: config.ghostsRoot,
    ghosts: registry.list().length,
    offline: config.offline,
    config: config.configPath,
    hooks: hooksPath,
    // Never the token; `ghostd relay-token` is the only way to see it.
    relay: listening.relay ? `ws://${config.host}:${listening.port}/relay` : "off",
  });

  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("shutting down", { signal });
      void (async () => {
        try {
          login.dispose();
          await listening.close();
          await host.disposeAll();
        } catch (error) {
          logger.warn("shutdown was not clean", { error: (error as Error).message });
        } finally {
          resolvePromise();
        }
      })();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });

  logger.info("stopped");
  return 0;
}

export function isDirectInvocation(moduleUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && moduleUrl === pathToFileURL(entryPath).href;
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
