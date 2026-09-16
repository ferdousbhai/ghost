import { opendir, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import {
  buildRuleFromMarkdown,
  parseFrontmatter,
  type FileSlashCommand,
  type PromptTemplate,
  type Rule,
  type Skill,
  type SourceMeta,
} from "./declarative-types.js";
import {
  descriptorPath,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
} from "@ghost/extensions";
import { GhostError } from "./ghosts.js";

export const SCAN_MAX_ENTRIES = 512;
export const SCAN_MAX_BYTES = 1_048_576;
export const SCAN_MAX_FILE_BYTES = 262_144;
export const SCAN_MAX_DEPTH = 8;
export const SCAN_TIMEOUT_MS = 1_000;

export interface DeclarativeSnapshot {
  contextFiles: Array<{ path: string; content: string }>;
  skills: Skill[];
  rules: Rule[];
  promptTemplates: PromptTemplate[];
  slashCommands: FileSlashCommand[];
  warnings: string[];
  truncated: boolean;
}

interface ScanBudget {
  readonly started: number;
  readonly now: () => number;
  entries: number;
  bytes: number;
  denied: number;
  truncated: boolean;
  warnings: string[];
  traceOpen?: (path: string) => void;
}

interface MarkdownFile {
  relativePath: string;
  absolutePath: string;
  content: string;
}

const GHOST_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

function sourceFor(path: string, level: "user" | "native"): SourceMeta {
  return {
    provider: level === "native" ? "ghost-recommended" : "ghost-pinned",
    providerName: level === "native" ? "Ghost recommended" : "Ghost",
    path,
    level,
  };
}

function checkBudget(budget: ScanBudget): boolean {
  if (budget.entries >= SCAN_MAX_ENTRIES) {
    budget.denied += 1;
    budget.truncated = true;
    if (!budget.warnings.includes("Resource scan stopped at its entry limit.")) {
      budget.warnings.push("Resource scan stopped at its entry limit.");
    }
    return false;
  }
  if (!checkTimeBudget(budget)) return false;
  return true;
}

function checkTimeBudget(budget: ScanBudget): boolean {
  if (budget.now() - budget.started >= SCAN_TIMEOUT_MS) {
    budget.denied += 1;
    budget.truncated = true;
    if (!budget.warnings.includes("Resource scan stopped at its time limit.")) {
      budget.warnings.push("Resource scan stopped at its time limit.");
    }
    return false;
  }
  return true;
}

async function readUtf8AtMost(
  file: FileHandle,
  maxBytes: number,
): Promise<{ content: string; overflow: boolean; invalidUtf8: boolean; bytes: number }> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let bytes = 0;
  while (bytes < buffer.byteLength) {
    const result = await file.read(buffer, bytes, buffer.byteLength - bytes, bytes);
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
  }
  const overflow = bytes > maxBytes;
  const admitted = overflow ? maxBytes : bytes;
  if (overflow) return { content: "", overflow: true, invalidUtf8: false, bytes: admitted };
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, admitted)),
      overflow: false,
      invalidUtf8: false,
      bytes: admitted,
    };
  } catch {
    return { content: "", overflow: false, invalidUtf8: true, bytes: admitted };
  }
}

async function openPinnedRoot(
  root: string,
  traceOpen?: (path: string) => void,
): Promise<FileHandle> {
  traceOpen?.(root);
  return (await openPinnedRootDescriptor(root)).directory;
}

async function openPinnedRootDescriptor(
  path: string,
): Promise<{ root: string; directory: FileHandle }> {
  if (!isAbsolute(path)) {
    throw new GhostError("invalid_resource_root", "Resource roots must be absolute.", 400);
  }
  const root = resolve(path);
  let current: FileHandle | undefined;
  try {
    current = await openDirectoryNoFollow("/", "Resource root");
    for (const part of root.split("/").filter(Boolean)) {
      const next = await openDirectoryNoFollow(
        descriptorPath(current, part),
        "Resource root component",
      );
      await current.close();
      current = next;
    }
    return { root, directory: current };
  } catch (error) {
    await current?.close().catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GhostError("not_found", "That resource root does not exist.", 404);
    }
    if (error instanceof GhostError) throw error;
    throw new GhostError(
      "invalid_resource_root",
      "Resource roots cannot contain symbolic links or non-directory components.",
      400,
    );
  }
}

function segments(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\0"))) {
    throw new GhostError("invalid_resource_root", "A resource path is invalid.", 400);
  }
  return parts;
}

async function openRelativeDirectory(
  root: FileHandle,
  path: string,
  budget: ScanBudget,
): Promise<FileHandle | null> {
  let current: FileHandle | undefined;
  try {
    for (const part of segments(path)) {
      let next: FileHandle;
      try {
        budget.traceOpen?.(path);
        next = await openDirectoryNoFollow(
          descriptorPath(current ?? root, part),
          "Resource directory",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await current?.close();
          return null;
        }
        throw error;
      }
      await current?.close();
      current = next;
    }
    return current ?? null;
  } catch (error) {
    await current?.close().catch(() => {});
    throw error;
  }
}

async function readRelativeFile(
  root: FileHandle,
  rootPath: string,
  relativePath: string,
  budget: ScanBudget,
  countEntry = true,
): Promise<MarkdownFile | null> {
  if (!(countEntry ? checkBudget(budget) : checkTimeBudget(budget))) return null;
  const parts = segments(relativePath);
  const name = parts.pop() as string;
  const parentPath = parts.join("/");
  let openedParent: FileHandle | null;
  try {
    openedParent = parentPath ? await openRelativeDirectory(root, parentPath, budget) : null;
  } catch {
    budget.warnings.push(
      `${relativePath} was ignored because a symbolic link or non-directory parent was encountered.`,
    );
    return null;
  }
  const parent = openedParent ?? root;
  if (parentPath && !openedParent) return null;
  let file: FileHandle | undefined;
  try {
    try {
      budget.traceOpen?.(relativePath);
      const opened = await openRegularFileNoFollow(descriptorPath(parent, name), "Resource file");
      file = opened;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      budget.warnings.push(`${relativePath} was ignored because it is not a confined regular file.`);
      return null;
    }
    const remaining = Math.min(
      SCAN_MAX_FILE_BYTES,
      SCAN_MAX_BYTES - budget.bytes,
    );
    const bounded = await readUtf8AtMost(file, Math.max(0, remaining));
    if (bounded.overflow) {
      budget.truncated = true;
      budget.warnings.push(
        remaining < SCAN_MAX_FILE_BYTES
          ? `${relativePath} was ignored because the scan byte limit was reached.`
          : `${relativePath} was ignored because it exceeds the 256 KiB per-file limit.`,
      );
      return null;
    }
    if (bounded.invalidUtf8) {
      budget.warnings.push(`${relativePath} was ignored because it is not valid UTF-8.`);
      return null;
    }
    if (!checkTimeBudget(budget)) return null;
    // Re-check immediately before admission: stat is only a hint and an I/O
    // operation can outlive the cooperative scan deadline.
    if (countEntry && !checkBudget(budget)) return null;
    if (countEntry) budget.entries += 1;
    budget.bytes += bounded.bytes;
    return {
      relativePath,
      absolutePath: join(rootPath, ...relativePath.split("/")),
      content: bounded.content,
    };
  } finally {
    await file?.close().catch(() => {});
    await openedParent?.close().catch(() => {});
  }
}

async function boundedDirectoryEntries(
  directory: FileHandle,
  budget: ScanBudget,
): Promise<import("node:fs").Dirent[]> {
  const opened = await opendir(descriptorPath(directory));
  const entries: import("node:fs").Dirent[] = [];
  try {
    while (checkTimeBudget(budget)) {
      const entry = await opened.read();
      if (!entry) break;
      if (!checkTimeBudget(budget)) break;
      if (entry.name.startsWith(".")) continue;
      if (budget.entries >= SCAN_MAX_ENTRIES) {
        checkBudget(budget);
        break;
      }
      budget.entries += 1;
      entries.push(entry);
    }
  } finally {
    await opened.close().catch(() => {});
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  return entries;
}

async function scanMarkdownDirectory(
  root: FileHandle,
  rootPath: string,
  relativeDir: string,
  budget: ScanBudget,
): Promise<MarkdownFile[]> {
  let base: FileHandle | null;
  try {
    base = await openRelativeDirectory(root, relativeDir, budget);
  } catch {
    budget.warnings.push(`${relativeDir} was ignored because it is not a confined directory.`);
    return [];
  }
  if (!base) return [];
  const files: MarkdownFile[] = [];
  const visit = async (directory: FileHandle, prefix: string, depth: number): Promise<void> => {
    if (!checkBudget(budget)) return;
    if (depth > SCAN_MAX_DEPTH) {
      budget.truncated = true;
      budget.warnings.push(`${prefix} was truncated at the scan depth limit.`);
      return;
    }
    const entries = await boundedDirectoryEntries(directory, budget);
    for (const entry of entries) {
      const relativePath = posix.join(prefix, entry.name);
      const entryDepth = segments(relativePath).length;
      if (entryDepth > SCAN_MAX_DEPTH) {
        budget.truncated = true;
        budget.warnings.push(`${relativePath} was truncated at the scan depth limit.`);
        continue;
      }
      if (entry.isSymbolicLink()) {
        budget.warnings.push(`${relativePath} was ignored because symbolic links are not followed.`);
        continue;
      }
      if (entry.isDirectory()) {
        let child: FileHandle | undefined;
        try {
          const opened = await openDirectoryNoFollow(descriptorPath(directory, entry.name), "Resource directory");
          child = opened;
          await visit(opened, relativePath, depth + 1);
        } catch {
          budget.warnings.push(`${relativePath} was ignored because it changed during the scan.`);
        } finally {
          await child?.close().catch(() => {});
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const file = await readRelativeFile(root, rootPath, relativePath, budget, false);
      if (file) files.push(file);
    }
  };
  try {
    await visit(base, relativeDir, segments(relativeDir).length);
  } finally {
    await base.close();
  }
  return files;
}

function description(body: string, frontmatter: Record<string, unknown>): string {
  const configured = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (configured) return configured;
  const first = body.split("\n").find((line) => line.trim())?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}...` : first;
}

export async function loadDeclarativeSnapshot(
  rootPath: string,
  options: {
    level: "user" | "native";
    traceOpen?: (path: string) => void;
    /** Deterministic cooperative-clock seam used by boundary tests. */
    now?: () => number;
  },
): Promise<DeclarativeSnapshot> {
  const now = options.now ?? Date.now;
  const budget: ScanBudget = {
    started: now(),
    now,
    entries: 0,
    bytes: 0,
    denied: 0,
    truncated: false,
    warnings: [],
    ...(options.traceOpen ? { traceOpen: options.traceOpen } : {}),
  };
  const root = await openPinnedRoot(rootPath, options.traceOpen);
  try {
    const instructionFiles = GHOST_INSTRUCTION_FILES;
    const skillDirectories = ["skills"];
    const ruleDirectories = ["rules"];
    const promptDirectories = ["prompts"];
    const commandDirectories = ["commands"];

    const contextFiles: Array<{ path: string; content: string }> = [];
    for (const path of instructionFiles) {
      const file = await readRelativeFile(root, rootPath, path, budget);
      if (file) {
        contextFiles.push({ path: file.absolutePath, content: file.content });
        break;
      }
    }

    const scanDirectories = async (directories: readonly string[]): Promise<MarkdownFile[]> => {
      const files: MarkdownFile[] = [];
      for (const directory of directories) {
        files.push(...await scanMarkdownDirectory(root, rootPath, directory, budget));
      }
      return files;
    };
    const expectedSkillNames = new Map<string, string>();
    const skillFiles = (await scanDirectories(skillDirectories))
      .filter((file) => basename(file.relativePath).toLowerCase() === "skill.md");
    const ruleFiles = await scanDirectories(ruleDirectories);
    const promptFiles = await scanDirectories(promptDirectories);
    const commandFiles = await scanDirectories(commandDirectories);
    const skillEntries = new Map<string, Skill>();
    for (const file of skillFiles) {
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(file.content);
      } catch {
        budget.warnings.push(`${file.relativePath} was ignored because its skill metadata is invalid.`);
        continue;
      }
      const { frontmatter } = parsed;
      const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
      const detail = typeof frontmatter.description === "string"
        ? frontmatter.description.trim()
        : "";
      if (!name || !detail) {
        budget.warnings.push(`${file.relativePath} was ignored because its skill name or description is missing.`);
        continue;
      }
      const expectedName = expectedSkillNames.get(file.absolutePath);
      if (expectedName && name !== expectedName) {
        budget.warnings.push(`${file.relativePath} was ignored because its skill name is not ${expectedName}.`);
        continue;
      }
      skillEntries.set(name, {
        name,
        description: detail,
        filePath: file.absolutePath,
        baseDir: join(file.absolutePath, ".."),
        containRoot: join(file.absolutePath, ".."),
        source: options.level === "native" ? "ghost-recommended:native" : `ghost-pinned:${options.level}`,
        snapshotContent: file.content,
        hide: frontmatter.hide === true || frontmatter.disableModelInvocation === true,
        _source: sourceFor(file.absolutePath, options.level),
      });
    }
    const skills = [...skillEntries.values()];

    const ruleEntries = new Map<string, Rule>();
    for (const file of ruleFiles) {
      try {
        parseFrontmatter(file.content);
      } catch {
        budget.warnings.push(`${file.relativePath} was ignored because its rule metadata is invalid.`);
        continue;
      }
      const name = basename(file.relativePath, ".md");
      ruleEntries.set(name, buildRuleFromMarkdown(
        name,
        file.content,
        file.absolutePath,
        sourceFor(file.absolutePath, options.level),
      ));
    }
    const rules = [...ruleEntries.values()];
    const promptEntries = new Map<string, PromptTemplate>();
    for (const file of promptFiles) {
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(file.content);
      } catch {
        budget.warnings.push(`${file.relativePath} was ignored because its prompt metadata is invalid.`);
        continue;
      }
      const { frontmatter, body } = parsed;
      const source = `(${options.level}:ghost-pinned)`;
      const detail = description(body, frontmatter);
      const name = basename(file.relativePath, ".md");
      promptEntries.set(name, {
        name,
        description: detail ? `${detail} ${source}` : source,
        content: body,
        source,
      });
    }
    const promptTemplates = [...promptEntries.values()];
    const commandEntries = new Map<string, FileSlashCommand>();
    for (const file of commandFiles) {
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(file.content);
      } catch {
        budget.warnings.push(`${file.relativePath} was ignored because its command metadata is invalid.`);
        continue;
      }
      const { frontmatter, body } = parsed;
      const name = basename(file.relativePath, ".md");
      commandEntries.set(name, {
        name,
        description: description(body, frontmatter),
        content: body,
        source: `via Ghost ${options.level}`,
        _source: { providerName: "Ghost", level: options.level },
      });
    }
    const slashCommands = [...commandEntries.values()];

    return {
      contextFiles,
      skills,
      rules,
      promptTemplates,
      slashCommands,
      warnings: budget.warnings,
      truncated: budget.truncated,
    };
  } finally {
    await root.close();
  }
}
