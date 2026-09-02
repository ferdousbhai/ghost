/**
 * Adapted from oh-my-pi's WATCHDOG discovery
 * (`src/advisor/watchdog.ts`, MIT, @oh-my-pi/pi-coding-agent 18.0.3).
 * Copyright (c) 2025-2026 Stencil Labs, Inc.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  if (trustedRoot && isWithin(trustedRoot, resolvedCwd)) {
    const gitRoot = await resolveGitRoot(resolvedCwd);
    const boundary = gitRoot
      && isWithin(trustedRoot, gitRoot)
      && isWithin(gitRoot, resolvedCwd)
      ? gitRoot
      : trustedRoot;
    let current = resolvedCwd;
    while (true) {
      for (const filename of filenames) {
        candidates.add(resolve(current, ".ghost", filename));
        candidates.add(resolve(current, filename));
      }
      if (current === boundary) break;
      const parent = dirname(current);
      if (parent === current || !isWithin(boundary, parent)) break;
      current = parent;
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

  items.sort((left, right) => {
    if (left.level !== right.level) return left.level === "user" ? -1 : 1;
    return right.depth - left.depth;
  });
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
