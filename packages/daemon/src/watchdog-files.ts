/**
 * Adapted from oh-my-pi's WATCHDOG discovery
 * (`src/advisor/watchdog.ts`, MIT, @oh-my-pi/pi-coding-agent 18.0.3).
 * Copyright (c) 2025-2026 Stencil Labs, Inc.
 */

import { execFile } from "node:child_process";
import { open, readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ConfigCandidate {
  path: string;
  content: string;
  level: "user" | "project";
  depth: number;
}

export interface WatchdogDiscoveryOptions {
  /** Exact root returned by Ghost's validated project-binding store. */
  trustedProjectRoot?: string;
  warn?: (path: string, error: unknown) => void;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 3_000,
    });
    const root = resolve(stdout.trim());
    return stdout.trim() ? root : null;
  } catch {
    return null;
  }
}

async function readUtf8(path: string): Promise<string> {
  const bytes = await readFile(path);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readUtf8Bounded(path: string, maximumBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("configuration is not a regular file");
    if (metadata.size > maximumBytes) throw new Error("configuration exceeds its byte limit");
    const buffer = Buffer.alloc(metadata.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

async function projectSearchDirectories(
  resolvedCwd: string,
  trustedProjectRoot: string | undefined,
): Promise<string[]> {
  if (!trustedProjectRoot || !isWithin(trustedProjectRoot, resolvedCwd)) return [];
  const gitRoot = await resolveGitRoot(resolvedCwd);
  const boundary = gitRoot
    && isWithin(trustedProjectRoot, gitRoot)
    && isWithin(gitRoot, resolvedCwd)
    ? gitRoot
    : trustedProjectRoot;
  const directories: string[] = [];
  let current = resolvedCwd;
  while (true) {
    directories.push(current);
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current || !isWithin(boundary, parent)) break;
    current = parent;
  }
  return directories;
}

function sortConfigCandidates(items: ConfigCandidate[]): void {
  items.sort((left, right) => {
    if (left.level !== right.level) return left.level === "user" ? -1 : 1;
    return right.depth - left.depth;
  });
}

/**
 * Walk the WATCHDOG search path: ghost home first, then each directory from
 * the trusted project cwd up to its Git root (or trusted binding root), probing
 * both `<F>` and `.ghost/<F>`. Project candidates are impossible unless the
 * caller supplies an already validated project binding.
 */
export async function collectConfigCandidates(
  cwd: string,
  ghostHome: string,
  filenames: readonly string[],
  options: WatchdogDiscoveryOptions = {},
): Promise<ConfigCandidate[]> {
  const resolvedCwd = resolve(cwd);
  const resolvedGhostHome = resolve(ghostHome);
  const userPaths = new Set<string>();
  const candidates = new Set<string>();

  for (const filename of filenames) {
    const userPath = resolve(resolvedGhostHome, filename);
    candidates.add(userPath);
    userPaths.add(userPath);
  }

  const trustedRoot = options.trustedProjectRoot
    ? resolve(options.trustedProjectRoot)
    : undefined;
  for (const current of await projectSearchDirectories(resolvedCwd, trustedRoot)) {
    for (const filename of filenames) {
      candidates.add(resolve(current, ".ghost", filename));
      candidates.add(resolve(current, filename));
    }
  }

  const items: ConfigCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const content = await readUtf8(candidate);
      const parent = dirname(candidate);
      const baseName = basename(parent);
      const isUser = userPaths.has(candidate);
      const ownerDir = baseName === ".ghost" ? dirname(parent) : parent;
      const ownerBaseName = basename(ownerDir);
      if (isUser || !ownerBaseName.startsWith(".") || baseName === ".ghost") {
        const rel = relative(resolvedCwd, ownerDir);
        const depth = rel === "" ? 0 : rel.split(sep).filter(Boolean).length;
        items.push({
          path: candidate,
          content,
          level: isUser ? "user" : "project",
          depth,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.warn?.(candidate, error);
    }
  }

  sortConfigCandidates(items);
  return items;
}

const MAX_LINT_PACK_BYTES = 128 * 1024;
const MAX_LINT_PACKS = 64;

/**
 * Discover direct YAML lint packs in the ghost home and along the same trusted
 * project ancestor chain as WATCHDOG.md. Project packs exist only below the
 * native `.ghost/lint` directory; an untrusted cwd contributes nothing.
 */
export async function collectLintPackCandidates(
  cwd: string,
  ghostHome: string,
  options: WatchdogDiscoveryOptions = {},
): Promise<ConfigCandidate[]> {
  const resolvedCwd = resolve(cwd);
  const trustedRoot = options.trustedProjectRoot
    ? resolve(options.trustedProjectRoot)
    : undefined;
  const directories = [
    { path: resolve(ghostHome, "lint"), level: "user" as const, depth: 0 },
    ...(await projectSearchDirectories(resolvedCwd, trustedRoot)).toReversed().map((path) => {
      const rel = relative(resolvedCwd, path);
      return {
        path: resolve(path, ".ghost", "lint"),
        level: "project" as const,
        depth: rel === "" ? 0 : rel.split(sep).filter(Boolean).length,
      };
    }),
  ];
  const items: ConfigCandidate[] = [];
  for (const directory of directories) {
    let names: string[];
    try {
      names = (await readdir(directory.path, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.warn?.(directory.path, error);
      continue;
    }
    for (const name of names) {
      if (items.length >= MAX_LINT_PACKS) {
        sortConfigCandidates(items);
        return items;
      }
      const path = resolve(directory.path, name);
      try {
        items.push({
          path,
          content: await readUtf8Bounded(path, MAX_LINT_PACK_BYTES),
          level: directory.level,
          depth: directory.depth,
        });
      } catch (error) {
        options.warn?.(path, error);
      }
    }
  }
  sortConfigCandidates(items);
  return items;
}

export async function discoverWatchdogFiles(
  cwd: string,
  ghostHome: string,
  options: WatchdogDiscoveryOptions = {},
): Promise<string[]> {
  const items = await collectConfigCandidates(cwd, ghostHome, ["WATCHDOG.md"], options);
  return items.map((item) =>
    `Especially pay attention to:\n<attention>\n${item.content}\n</attention>`
  );
}
