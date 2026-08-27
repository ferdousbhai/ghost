/** Descriptor-confined machine-wide Documents listing and bounded text reads. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { GhostError } from "./errors.js";
import {
  descriptorPath,
  openConfinedDirectory,
  openRegularFileNoFollow,
} from "./linux-fs.js";

export const DOCUMENT_INDEX_MAX_ENTRIES = 100;
export const DOCUMENT_INDEX_BUDGET_CHARS = 4_000;
export const DOCUMENT_LIST_DEFAULT_LIMIT = 100;
export const DOCUMENT_LIST_MAX_LIMIT = 250;
export const DOCUMENT_QUERY_MAX_CHARS = 200;
export const DOCUMENT_INLINE_MAX_BYTES = 1_048_576;

export type DocumentEntryKind = "directory" | "file";

export interface DocumentDirectoryEntry {
  readonly name: string;
  /** Path relative to the machine's Documents root. */
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
  /** Absolute, canonical local Documents root. */
  readonly root: string;
  /** Normalized Documents-relative directory; empty means the root. */
  readonly path: string;
  /** Normalized current-directory name query. */
  readonly query: string;
  readonly entries: readonly DocumentDirectoryEntry[];
  /** Counts cover the filtered direct children before pagination, never descendants. */
  readonly total: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly skipped: readonly SkippedDocumentEntry[];
}

export interface DocumentTextContent {
  /** Absolute, canonical local Documents root. */
  readonly root: string;
  /** Normalized Documents-relative regular-file path. */
  readonly path: string;
  /** Exact byte length of `content` under strict UTF-8 decoding. */
  readonly size: number;
  readonly modifiedAt: string;
  readonly content: string;
}

export interface ListDocumentDirectoryOptions {
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

interface DocumentsCursor {
  readonly version: 1;
  readonly path: string;
  readonly query: string;
  readonly offset: number;
  readonly digest: string;
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

/** Normalize a directory below Documents. Empty names the root. */
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

/** Normalize one file path below Documents. */
export function normalizeDocumentsFilePath(input: string): string {
  const normalized = normalizeDocumentsDirectoryPath(input);
  if (normalized === "") throw invalidPath(input, "A Documents file path is required");
  return normalized;
}

function normalizeQuery(input: string | undefined): string {
  const query = input?.trim() ?? "";
  if (query.length > DOCUMENT_QUERY_MAX_CHARS) {
    throw new GhostError(
      "limit_exceeded",
      `A Documents query may be at most ${DOCUMENT_QUERY_MAX_CHARS} characters.`,
      { limit: DOCUMENT_QUERY_MAX_CHARS },
    );
  }
  return query;
}

function compareEntries(left: DocumentDirectoryEntry, right: DocumentDirectoryEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  const foldedLeft = left.name.toLocaleLowerCase("en-US");
  const foldedRight = right.name.toLocaleLowerCase("en-US");
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function entryDigest(entries: readonly DocumentDirectoryEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.name);
    hash.update("\0");
  }
  return hash.digest("base64url");
}

function encodeCursor(cursor: DocumentsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): DocumentsCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new GhostError("invalid_cursor", "The Documents cursor is malformed.");
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (value as { version?: unknown }).version !== 1
    || typeof (value as { path?: unknown }).path !== "string"
    || typeof (value as { query?: unknown }).query !== "string"
    || !Number.isSafeInteger((value as { offset?: unknown }).offset)
    || (value as { offset: number }).offset < 0
    || typeof (value as { digest?: unknown }).digest !== "string"
  ) {
    throw new GhostError("invalid_cursor", "The Documents cursor is malformed.");
  }
  return value as DocumentsCursor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  async canonicalRoot(): Promise<string> {
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
    const root = await this.canonicalRoot();
    const target = path === "" ? root : join(root, ...path.split("/"));
    return {
      root,
      directory: await openConfinedDirectory(root, target, {
        label: "Documents directory",
      }),
    };
  }

  async listDirectory(
    inputPath = "",
    options: ListDocumentDirectoryOptions = {},
  ): Promise<DocumentDirectoryPage> {
    const path = normalizeDocumentsDirectoryPath(inputPath);
    const query = normalizeQuery(options.query);
    const limit = options.limit ?? DOCUMENT_LIST_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > DOCUMENT_LIST_MAX_LIMIT) {
      throw new GhostError(
        "limit_exceeded",
        `Documents limit must be an integer from 1 to ${DOCUMENT_LIST_MAX_LIMIT}.`,
        { limit: DOCUMENT_LIST_MAX_LIMIT },
      );
    }
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (cursor && (cursor.path !== path || cursor.query !== query)) {
      throw new GhostError(
        "invalid_cursor",
        "The Documents cursor belongs to a different path or query.",
      );
    }

    const opened = await this.openDirectory(path);
    const entries: DocumentDirectoryEntry[] = [];
    const skipped: SkippedDocumentEntry[] = [];
    const foldedQuery = query.toLocaleLowerCase("en-US");
    try {
      for (const entry of await readdir(descriptorPath(opened.directory), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith(".")) continue;
        const childPath = path === "" ? entry.name : posix.join(path, entry.name);
        if (
          foldedQuery !== ""
          && !entry.name.toLocaleLowerCase("en-US").includes(foldedQuery)
        ) continue;
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
    const digest = entryDigest(entries);
    if (cursor && cursor.digest !== digest) {
      throw new GhostError(
        "cursor_stale",
        "The Documents directory changed while it was being paged. Restart from its first page.",
      );
    }
    const offset = cursor?.offset ?? 0;
    if (offset > entries.length) {
      throw new GhostError("invalid_cursor", "The Documents cursor offset is invalid.");
    }
    const page = entries.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < entries.length
      ? encodeCursor({ version: 1, path, query, offset: nextOffset, digest })
      : null;
    const fileCount = entries.filter((entry) => entry.kind === "file").length;
    const directoryCount = entries.length - fileCount;
    return {
      root: opened.root,
      path,
      query,
      entries: page,
      total: entries.length,
      fileCount,
      directoryCount,
      nextCursor,
      truncated: page.length < entries.length,
      skipped,
    };
  }

  /** Open a pinned parent directory for a file mutation. */
  async openFileParent(path: string): Promise<{
    root: string;
    relativePath: string;
    name: string;
    directory: FileHandle;
  }> {
    const relativePath = normalizeDocumentsFilePath(path);
    const parts = relativePath.split("/");
    const name = parts.pop() as string;
    const parent = parts.join("/");
    const opened = await this.openDirectory(parent);
    return { ...opened, relativePath, name };
  }

  /**
   * Read one small text file through a descriptor pinned beneath Documents.
   * The final pathname is checked again after the bounded read so a local
   * replace cannot make the returned bytes describe a different live entry.
   */
  async readTextContent(path: string): Promise<DocumentTextContent> {
    const opened = await this.openFileParent(path);
    let file: FileHandle | undefined;
    try {
      try {
        file = await openRegularFileNoFollow(
          descriptorPath(opened.directory, opened.name),
          "Documents file",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new GhostError(
            "not_found",
            `Documents has no file ${JSON.stringify(opened.relativePath)}.`,
            { path: opened.relativePath },
          );
        }
        throw error;
      }

      const before = await file.stat({ bigint: true });
      if (!before.isFile()) {
        throw invalidPath(opened.relativePath, "Documents content must be a regular file");
      }
      if (before.size > BigInt(DOCUMENT_INLINE_MAX_BYTES)) {
        throw new GhostError(
          "document_too_large",
          `Documents inline content is limited to ${DOCUMENT_INLINE_MAX_BYTES} bytes.`,
          { path: opened.relativePath, limit: DOCUMENT_INLINE_MAX_BYTES },
        );
      }

      const bytes = Buffer.allocUnsafe(DOCUMENT_INLINE_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (length > DOCUMENT_INLINE_MAX_BYTES
          || after.size > BigInt(DOCUMENT_INLINE_MAX_BYTES)) {
        throw new GhostError(
          "document_too_large",
          `Documents inline content is limited to ${DOCUMENT_INLINE_MAX_BYTES} bytes.`,
          { path: opened.relativePath, limit: DOCUMENT_INLINE_MAX_BYTES },
        );
      }
      if (!after.isFile()
          || before.dev !== after.dev
          || before.ino !== after.ino
          || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs
          || before.ctimeNs !== after.ctimeNs
          || after.size !== BigInt(length)) {
        throw new GhostError(
          "conflict",
          "The Documents file changed while it was being read. Reload it.",
          { path: opened.relativePath },
        );
      }

      const live = await lstat(
        descriptorPath(opened.directory, opened.name),
        { bigint: true },
      ).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new GhostError(
            "conflict",
            "The Documents file changed while it was being read. Reload it.",
            { path: opened.relativePath },
          );
        }
        throw error;
      });
      if (!live.isFile()
          || live.dev !== after.dev
          || live.ino !== after.ino
          || live.size !== after.size
          || live.mtimeNs !== after.mtimeNs
          || live.ctimeNs !== after.ctimeNs) {
        throw new GhostError(
          "conflict",
          "The Documents file changed while it was being read. Reload it.",
          { path: opened.relativePath },
        );
      }

      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      } catch {
        throw new GhostError(
          "invalid_document_content",
          "This Documents file is not valid UTF-8 text.",
          { path: opened.relativePath },
        );
      }
      if (content.includes("\0")) {
        throw new GhostError(
          "invalid_document_content",
          "This Documents file contains NUL bytes and cannot be shown as text.",
          { path: opened.relativePath },
        );
      }
      return {
        root: opened.root,
        path: opened.relativePath,
        size: length,
        modifiedAt: new Date(Number(after.mtimeMs)).toISOString(),
        content,
      };
    } finally {
      await file?.close().catch(() => undefined);
      await opened.directory.close();
    }
  }
}

export function openMachineDocuments(root?: string): MachineDocuments {
  return new MachineDocuments(root);
}
