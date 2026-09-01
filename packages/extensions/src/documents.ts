/** Descriptor-confined machine-wide Documents listing. */
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { GhostError } from "./errors.js";
import {
  descriptorPath,
  openConfinedDirectory,
} from "./linux-fs.js";

export const DOCUMENT_INDEX_MAX_ENTRIES = 50;
export const DOCUMENT_INDEX_BUDGET_CHARS = 4_000;

export type DocumentEntryKind = "directory" | "file";

export interface DocumentDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: DocumentEntryKind;
  readonly size?: number;
  readonly modifiedAt: string;
}

export interface SkippedDocumentEntry {
  readonly name: string;
  readonly path: string;
  readonly reason: string;
}

export interface DocumentDirectoryPage {
  readonly root: string;
  readonly path: string;
  /** Whether the canonical Documents root contains a real `.obsidian` directory. */
  readonly obsidianVault: boolean;
  readonly entries: readonly DocumentDirectoryEntry[];
  readonly total: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly truncated: boolean;
  readonly skipped: readonly SkippedDocumentEntry[];
}

export interface ListDocumentDirectoryOptions {
  readonly limit?: number;
}

export interface ResolveDocumentsDirectoryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

function expandHome(path: string, home: string): string {
  if (path === "~" || path === "$HOME") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path.startsWith("$HOME/")) return join(home, path.slice("$HOME/".length));
  return isAbsolute(path) ? path : join(home, path);
}

function userDocumentsDirectory(env: NodeJS.ProcessEnv, home: string): string | null {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const userDirs = configHome && isAbsolute(configHome)
    ? join(configHome, "user-dirs.dirs")
    : join(home, ".config", "user-dirs.dirs");
  let contents: string;
  try {
    contents = readFileSync(userDirs, "utf8");
  } catch {
    return null;
  }
  const match = /^\s*XDG_DOCUMENTS_DIR\s*=\s*"?([^"\n]+)"?\s*$/m.exec(contents);
  return match?.[1]?.trim() || null;
}

/** Resolve the freedesktop Documents directory without evaluating shell text. */
export function resolveDocumentsDirectory(
  options: ResolveDocumentsDirectoryOptions = {},
): string {
  const env = options.env ?? process.env;
  const home = resolve(options.home ?? homedir());
  const configured = env.XDG_DOCUMENTS_DIR?.trim()
    || userDocumentsDirectory(env, home);
  return resolve(expandHome(configured || "Documents", home));
}

function invalidPath(path: string, message: string): GhostError {
  return new GhostError("invalid_path", `${message}: ${JSON.stringify(path)}.`, { path });
}

export function normalizeDocumentsDirectoryPath(input: string): string {
  if (input.includes("\0") || input.includes("\\") || input.startsWith("/")) {
    throw invalidPath(input, "Documents paths must be confined relative paths");
  }
  if (input === "") return "";
  const segments = input.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw invalidPath(input, "Documents paths cannot contain empty, dot, or parent segments");
  }
  return segments.join("/");
}

/**
 * Newest first, name as the deterministic tie-break. Every caller of
 * `listDirectory` builds the prompt's shallow Documents index, which is cut off
 * at `DOCUMENT_INDEX_MAX_ENTRIES`; recency is what decides which entries earn
 * that budget, so it is the listing order rather than a per-call option. Each
 * line already names its kind, so directories are not grouped ahead of files.
 */
function compareEntries(left: DocumentDirectoryEntry, right: DocumentDirectoryEntry): number {
  if (left.modifiedAt !== right.modifiedAt) {
    return left.modifiedAt < right.modifiedAt ? 1 : -1;
  }
  const foldedLeft = left.name.toLocaleLowerCase("en-US");
  const foldedRight = right.name.toLocaleLowerCase("en-US");
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function hasObsidianMarker(directory: FileHandle): Promise<boolean> {
  try {
    return (await lstat(descriptorPath(directory, ".obsidian"))).isDirectory();
  } catch {
    // Vault awareness is an optional hint. Missing or unreadable markers leave
    // Documents usable as ordinary files instead of failing the whole index.
    return false;
  }
}

/** A descriptor-confined view of the owner's machine-wide Documents tree. */
export class MachineDocuments {
  readonly configuredRoot: string;
  private rootPromise: Promise<string> | undefined;

  constructor(root: string = resolveDocumentsDirectory()) {
    this.configuredRoot = resolve(root);
  }

  async ensure(): Promise<string> {
    await mkdir(this.configuredRoot, { recursive: true });
    return realpath(this.configuredRoot);
  }

  private async resolveRoot(): Promise<string> {
    this.rootPromise ??= (async () => {
      try {
        return await realpath(this.configuredRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.ensure();
        throw error;
      }
    })().catch((error) => {
      this.rootPromise = undefined;
      throw error;
    });
    return this.rootPromise;
  }

  private async openDirectory(path: string): Promise<{ root: string; directory: FileHandle }> {
    const root = await this.resolveRoot();
    const target = path === "" ? root : join(root, ...path.split("/"));
    return {
      root,
      directory: await openConfinedDirectory(root, target, {
        label: "Documents directory",
      }),
    };
  }

  private async detectObsidianVault(
    root: string,
    path: string,
    directory: FileHandle,
  ): Promise<boolean> {
    if (path === "") return hasObsidianMarker(directory);
    let rootDirectory: FileHandle | undefined;
    try {
      rootDirectory = await openConfinedDirectory(root, root, {
        label: "Documents directory",
      });
      return await hasObsidianMarker(rootDirectory);
    } catch {
      return false;
    } finally {
      await rootDirectory?.close();
    }
  }

  async listDirectory(
    inputPath = "",
    options: ListDocumentDirectoryOptions = {},
  ): Promise<DocumentDirectoryPage> {
    const path = normalizeDocumentsDirectoryPath(inputPath);
    const limit = options.limit ?? DOCUMENT_INDEX_MAX_ENTRIES;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new GhostError(
        "limit_exceeded",
        "Documents limit must be a positive safe integer.",
      );
    }

    const opened = await this.openDirectory(path);
    const entries: DocumentDirectoryEntry[] = [];
    const skipped: SkippedDocumentEntry[] = [];
    let obsidianVault = false;
    try {
      obsidianVault = await this.detectObsidianVault(
        opened.root,
        path,
        opened.directory,
      );
      for (const entry of await readdir(descriptorPath(opened.directory), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith(".")) continue;
        const childPath = path === "" ? entry.name : posix.join(path, entry.name);
        try {
          const stats = await lstat(descriptorPath(opened.directory, entry.name));
          const kind: DocumentEntryKind | null = stats.isDirectory()
            ? "directory"
            : stats.isFile() ? "file" : null;
          if (kind === null) {
            skipped.push({
              name: entry.name,
              path: childPath,
              reason: stats.isSymbolicLink()
                ? "Symbolic links are not followed."
                : "Only regular files and directories are listed.",
            });
            continue;
          }
          entries.push({
            name: entry.name,
            path: childPath,
            kind,
            ...(kind === "file" && Number.isSafeInteger(stats.size)
              ? { size: stats.size }
              : {}),
            modifiedAt: stats.mtime.toISOString(),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          skipped.push({ name: entry.name, path: childPath, reason: errorMessage(error) });
        }
      }
    } finally {
      await opened.directory.close();
    }
    entries.sort(compareEntries);
    skipped.sort((left, right) => left.path.localeCompare(right.path, "en"));
    const page = entries.slice(0, limit);
    const fileCount = entries.filter((entry) => entry.kind === "file").length;
    const directoryCount = entries.length - fileCount;
    return {
      root: opened.root,
      path,
      obsidianVault,
      entries: page,
      total: entries.length,
      fileCount,
      directoryCount,
      truncated: page.length < entries.length,
      skipped,
    };
  }
}

export function openMachineDocuments(root?: string): MachineDocuments {
  return new MachineDocuments(root);
}
