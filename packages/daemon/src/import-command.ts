/**
 * `ghostd import` — turn a `ghost-home/v1` archive into a ghost.
 *
 * The archive is the zip the hosted app's "Download my ghost" produces (or an
 * already-extracted directory): character file, every document public and private,
 * memory, per-visitor memory, and conversations, all as plain files. Importing
 * preserves file bytes while translating the hosted archive's legacy `notes/`
 * directory to canonical `docs/`, so the migration path off the platform is a
 * single command.
 *
 * The heavy lifting is `importGhostArchive` in `@ghost/extensions`, which
 * validates the manifest, guards against zip-slip, and never overwrites a
 * non-empty ghost home unless asked. This file is only the terminal wrapper:
 * argument parsing, ghostsRoot resolution (honouring the same config/env/flags
 * as the daemon), and a readable summary.
 */
import { importGhostArchive, GhostError } from "@ghost/extensions";
import { loadConfig, type DaemonConfigOverrides } from "./config.js";

const USAGE = `ghostd import — import a ghost from a "Download my ghost" archive

Usage:
  ghostd import <archive.zip | dir> [--name <name>] [--overwrite] [options]

Options:
      --name <name>        Ghost directory name (default: from the archive).
      --overwrite          Import into an existing, non-empty ghost home.
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

/**
 * `ghostd import <archive>`. Returns a process exit code; the daemon is never
 * started, so this works while another daemon is already serving.
 */
export async function importCommand(
  argv: readonly string[] = [],
  io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
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

  let ghostsRoot: string;
  try {
    ghostsRoot = loadConfig(args.overrides).ghostsRoot;
  } catch (error) {
    fail(`import: ${(error as Error).message}\n`);
    return 1;
  }

  try {
    const result = await importGhostArchive(args.source, ghostsRoot, {
      overwrite: args.overwrite,
      ...(args.name === undefined ? {} : { name: args.name }),
    });
    write(
      `Imported "${result.ghostName}" into ${result.dir}\n`
      + `  ${result.filesWritten} file${result.filesWritten === 1 ? "" : "s"} written`
      + `${result.ignored.length > 0 ? `, ${result.ignored.length} ignored` : ""}.\n`
      + `\nStart the daemon (ghostd) and summon it with Super+G.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof GhostError && error.code === "conflict") {
      fail(`import: ${error.message}\n`);
      return 1;
    }
    fail(`import: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
