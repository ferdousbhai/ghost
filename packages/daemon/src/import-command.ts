import { importGhostArchive, GhostError } from "@ghost/extensions";
import { createServer, type Server } from "node:net";
import { loadConfig, type DaemonConfigOverrides } from "./config.js";
import { acquireHomeReservation, HomeReservationBusyError, type HomeReservation } from "./home-reservation.js";
import { migrateHostedConversations } from "./hosted-conversation-import.js";

const USAGE = `ghostd import — import a ghost from a "Download my ghost" archive

Usage:
  ghostd import <archive.zip | dir> [--name <name>] [--overwrite] [options]

Options:
      --name <name>        Ghost directory name (default: from the archive).
      --overwrite          Import into an existing, non-empty ghost home.
      --port <port>        Effective daemon port for the legacy liveness check
                           during --overwrite (default: config).
      --host <host>        Effective daemon loopback host for that check
                           (default: config; 127.0.0.1, ::1, or localhost).
      --ghosts-root <dir>  Directory holding one sub-directory per ghost.
      --config <file>      Config file (default ~/.config/ghost/config.json).
  -h, --help               Show this message.
`;

interface ImportArgs {
  source?: string;
  name?: string;
  overwrite: boolean;
  overrides: DaemonConfigOverrides;
  help: boolean;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseImportArgs(argv: string[]): ImportArgs {
  const overrides: DaemonConfigOverrides = {};
  const args: ImportArgs = { overrides, overwrite: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--overwrite":
        args.overwrite = true;
        break;
      case "--port": {
        index += 1;
        const raw = requireValue(argv, index, arg);
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error(`Invalid port: ${raw}`);
        }
        overrides.port = port;
        break;
      }
      case "--host":
        index += 1;
        overrides.host = requireValue(argv, index, arg);
        break;
      case "--name":
        index += 1;
        args.name = requireValue(argv, index, arg);
        break;
      case "--ghosts-root":
        index += 1;
        overrides.ghostsRoot = requireValue(argv, index, arg);
        break;
      case "--config":
        index += 1;
        overrides.configPath = requireValue(argv, index, arg);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        if (args.source !== undefined) throw new Error(`Unexpected argument: ${arg}`);
        args.source = arg;
        break;
    }
  }
  return args;
}

interface LegacyPortReservation {
  close(): Promise<void>;
}

function daemonEndpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function stopDaemonGuidance(host: string, port: number): string {
  const endpoint = daemonEndpoint(host, port);
  const manual =
    port === 0
      ? "stop the manually started ghostd using this ghosts root"
      : `stop the manually started ghostd on ${endpoint}`;
  return `Stop it with \`systemctl --user stop ghostd.service\` (or ${manual}), retry the import, then restart ghostd.`;
}

/**
 * Reserve the daemon's effective listener for compatibility with an older
 * daemon that predates the shared home reservation.
 *
 * The root-keyed flock is the actual check/use gate. Port 0 has no stable
 * listener to reserve, but remains safe because both current processes take the
 * home reservation before touching the root.
 */
async function acquireLegacyPortReservation(host: string, port: number): Promise<LegacyPortReservation | undefined> {
  if (port === 0) return undefined;

  const hosts = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
  const servers: Server[] = [];
  try {
    for (const address of hosts) {
      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen({ host: address, port, exclusive: true }, () => {
          server.off("error", onError);
          resolve();
        });
      });
      servers.push(server);
    }
  } catch (error) {
    for (const server of [...servers].reverse()) await closeServer(server);
    const endpoint = daemonEndpoint(host, port);
    const detail =
      (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `ghostd is running or ${endpoint} is already in use. ${stopDaemonGuidance(host, port)}`
        : `could not reserve ${endpoint} to prove ghostd is stopped: ${(error as Error).message}. ${stopDaemonGuidance(host, port)}`;
    throw new Error(`refusing --overwrite: ${detail}`);
  }

  return {
    async close(): Promise<void> {
      for (const server of [...servers].reverse()) await closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * `ghostd import <archive>`. Returns a process exit code; the daemon is never
 * started. Every import reserves the whole ghosts root and requires the daemon
 * stopped; an overwrite additionally probes the legacy daemon listener.
 */
export interface ImportCommandRuntime {
  afterOverwriteReservationAcquired?: () => Promise<void>;
  afterArchivePublished?: () => Promise<void>;
  /** Test observer called after the legacy listener closes but before the home unlocks. */
  afterLegacyPortReservationReleased?: () => Promise<void>;
}

export async function importCommand(
  argv: readonly string[] = [],
  io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
  runtime: ImportCommandRuntime = {},
): Promise<number> {
  const write = io.stdout ?? ((text) => process.stdout.write(text));
  const fail = io.stderr ?? ((text) => process.stderr.write(text));

  let args: ImportArgs;
  try {
    args = parseImportArgs([...argv]);
  } catch (error) {
    fail(`import: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    write(USAGE);
    return 0;
  }
  if (!args.source) {
    fail(`import: an archive path is required.\n\n${USAGE}`);
    return 2;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(args.overrides);
  } catch (error) {
    fail(`import: ${(error as Error).message}\n`);
    return 1;
  }

  let homeReservation: HomeReservation | undefined;
  let portReservation: LegacyPortReservation | undefined;
  try {
    try {
      homeReservation = await acquireHomeReservation(config.ghostsRoot);
    } catch (error) {
      const detail =
        error instanceof HomeReservationBusyError
          ? "ghostd is running or starting, or another import/login is active"
          : `could not reserve the ghost home: ${(error as Error).message}`;
      const operation = args.overwrite ? "--overwrite" : "import";
      throw new Error(`refusing ${operation}: ${detail}. ${stopDaemonGuidance(config.host, config.port)}`);
    }
    if (args.overwrite) {
      portReservation = await acquireLegacyPortReservation(config.host, config.port);
      await runtime.afterOverwriteReservationAcquired?.();
    }
    const ghostsRoot = homeReservation?.ghostsRoot ?? config.ghostsRoot;
    const result = await importGhostArchive(args.source, ghostsRoot, {
      overwrite: args.overwrite,
      ...(args.name === undefined ? {} : { name: args.name }),
    });
    await runtime.afterArchivePublished?.();
    const conversations = await migrateHostedConversations(result.dir);
    write(
      `Imported "${result.ghostName}" into ${result.dir}\n`
      + `  ${result.filesWritten} file${result.filesWritten === 1 ? "" : "s"} written`
      + `${result.ignored.length > 0 ? `, ${result.ignored.length} ignored` : ""}.\n`
      + `  ${conversations.imported} hosted conversation`
      + `${conversations.imported === 1 ? "" : "s"} activated as native sessions`
      + `${conversations.existing > 0 ? `, ${conversations.existing} already native` : ""}`
      + `${conversations.failures.length > 0
        ? `, ${conversations.failures.length} could not be activated`
        : ""}.\n`
      + `\nStart the daemon (ghostd) and summon it with Super+Ctrl+G.\n`,
    );
    for (const failure of conversations.failures) {
      fail(`import: kept ${failure.source} unchanged: ${failure.error}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof GhostError && error.code === "conflict") {
      fail(`import: ${error.message}\n`);
      return 1;
    }
    fail(`import: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    try {
      await portReservation?.close();
      if (portReservation !== undefined) {
        await runtime.afterLegacyPortReservationReleased?.();
      }
    } finally {
      await homeReservation?.close();
    }
  }
}
