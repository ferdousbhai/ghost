#!/usr/bin/env node
/**
 * `ghostd` — the Ghost daemon.
 *
 *   ghostd                    serve on the configured port (default 7717)
 *   ghostd --port 7788        serve on an explicit port
 *   ghostd --ghosts-root DIR  serve ghosts from DIR instead of ~/Ghosts
 *   ghostd --offline          forbid pi's own network calls (see README)
 *   ghostd --version | --help
 *
 * The very first thing this does — before pi is touched, before a session
 * exists — is scrub inherited provider credentials out of the process
 * environment. See env-scrub.ts for why.
 */
import { loadConfig, type DaemonConfigOverrides } from "./config.js";
import { scrubProviderEnv } from "./env-scrub.js";
import { GhostRegistry } from "./ghosts.js";
import { createLogger, type LogLevel } from "./log.js";
import { startDaemonServer } from "./server.js";
import { SessionHost } from "./session-host.js";

const USAGE = `ghostd — your ghost, on your machine

Usage:
  ghostd [options]

Options:
  -p, --port <port>        TCP port to bind on 127.0.0.1 (default 7717)
      --ghosts-root <dir>  Directory holding one sub-directory per ghost
      --config <file>      Config file (default ~/.config/ghost/config.json)
      --offline            Forbid pi's own network calls (catalog refresh off)
      --log-level <level>  debug | info | warn | error (default info)
  -h, --help               Show this message
  -v, --version            Show the version

Environment:
  GHOSTD_PORT, GHOSTD_HOST, GHOSTS_ROOT, GHOSTD_OFFLINE, GHOSTD_CONFIG,
  XDG_CONFIG_HOME
`;

export interface ParsedArgs {
  overrides: DaemonConfigOverrides;
  logLevel: LogLevel;
  help: boolean;
  version: boolean;
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
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
  let config;
  try {
    config = loadConfig(parsed.overrides);
  } catch (error) {
    logger.error("configuration is invalid", { error: (error as Error).message });
    return 1;
  }

  // Before pi, before any session. Idempotent, but this is the call that
  // matters: everything downstream inherits this environment.
  const { removed } = scrubProviderEnv(process.env, { offline: config.offline });
  if (removed.length > 0) {
    logger.warn("removed inherited provider credentials from the environment", { removed });
  }

  const registry = new GhostRegistry(config.ghostsRoot);
  registry.ensureRoot();
  const host = new SessionHost({ registry, logger, offline: config.offline });

  let listening;
  try {
    listening = await startDaemonServer({
      registry,
      host,
      logger,
      port: config.port,
      address: config.host,
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
  });

  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("shutting down", { signal });
      void (async () => {
        try {
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

// Only run when executed, so tests can import parseArgs/main.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === `file://${process.argv[1]}`;
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
