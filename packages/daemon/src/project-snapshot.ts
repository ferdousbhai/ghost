/** Durable immutable Pi project snapshots owned by one conversation generation. */
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { readDaemonControlFile } from "./control-file.js";
import { projectMcpValidationErrors } from "./mcp-catalog.js";
import { GhostError } from "./ghosts.js";
import type {
  ProjectDeclarativeSnapshot,
  ProjectFilesystemIdentity,
} from "./project-resources.js";
import { sessionFileNameFor } from "./session-files.js";

export const PI_PROJECT_SNAPSHOT_VERSION = 1;
export const PI_PROJECT_SNAPSHOT_MAX_BYTES = 16 * 1_048_576;

const PROJECT_SNAPSHOT_FIELDS = new Set([
  "contextFiles",
  "skills",
  "rules",
  "promptTemplates",
  "slashCommands",
  "mcp",
  "mcpWarnings",
  "resources",
  "warnings",
  "truncated",
]);

interface StoredPiProjectSnapshot {
  version: typeof PI_PROJECT_SNAPSHOT_VERSION;
  runtime: "pi";
  conversationId: string;
  generation: number;
  root: string;
  identity: ProjectFilesystemIdentity;
  snapshot: ProjectDeclarativeSnapshot;
}

function snapshotStem(conversationId: string): string {
  return sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
}

function snapshotPrefix(conversationId: string): string {
  return `${snapshotStem(conversationId)}.pi.project-snapshot.`;
}

export function piProjectSnapshotPath(
  sessionDir: string,
  conversationId: string,
  generation: number,
): string {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError("project snapshot generation must be a non-negative safe integer");
  }
  return join(sessionDir, `${snapshotPrefix(conversationId)}${generation}.json`);
}

export async function piProjectSnapshotPaths(
  sessionDir: string,
  conversationId: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const prefix = snapshotPrefix(conversationId);
  return names
    .filter((name) => name.startsWith(prefix)
      && /^\d+\.json$/u.test(name.slice(prefix.length)))
    .map((name) => join(sessionDir, name));
}

function within(root: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 32) return false;
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
  const row = record(value);
  return row !== null && Object.values(row).every((item) => jsonValue(item, depth + 1));
}

function source(value: unknown, root: string): boolean {
  const row = record(value);
  return row?.provider === "ghost-pinned"
    && row.providerName === "Ghost"
    && row.level === "project"
    && typeof row.path === "string"
    && within(root, row.path);
}

function contextFile(value: unknown, root: string): boolean {
  const row = record(value);
  return typeof row?.path === "string" && within(root, row.path)
    && typeof row.content === "string";
}

function skill(value: unknown, root: string): boolean {
  const row = record(value);
  return typeof row?.name === "string" && row.name.trim().length > 0
    && typeof row.description === "string" && row.description.trim().length > 0
    && typeof row.filePath === "string" && within(root, row.filePath)
    && typeof row.baseDir === "string" && within(root, row.baseDir)
    && typeof row.containRoot === "string" && within(root, row.containRoot)
    && typeof row.source === "string"
    && typeof row.snapshotContent === "string"
    && (row.hide === undefined || typeof row.hide === "boolean")
    && source(row._source, root);
}

function optionalStrings(value: unknown): boolean {
  return value === undefined || strings(value);
}

function rule(value: unknown, root: string): boolean {
  const row = record(value);
  return typeof row?.name === "string" && row.name.length > 0
    && typeof row.path === "string" && within(root, row.path)
    && typeof row.content === "string"
    && (row.description === undefined || typeof row.description === "string")
    && (row.alwaysApply === undefined || typeof row.alwaysApply === "boolean")
    && optionalStrings(row.globs)
    && optionalStrings(row.condition)
    && optionalStrings(row.astCondition)
    && optionalStrings(row.scope)
    && (row.interruptMode === undefined
      || row.interruptMode === "never"
      || row.interruptMode === "prose-only"
      || row.interruptMode === "tool-only"
      || row.interruptMode === "always")
    && source(row._source, root);
}

function prompt(value: unknown): boolean {
  const row = record(value);
  return typeof row?.name === "string" && row.name.length > 0
    && typeof row.content === "string"
    && typeof row.source === "string"
    && (row.description === undefined || typeof row.description === "string");
}

function command(value: unknown): boolean {
  const row = record(value);
  return typeof row?.name === "string" && row.name.length > 0
    && typeof row.content === "string"
    && typeof row.source === "string"
    && (row.description === undefined || typeof row.description === "string");
}

function mcp(value: unknown, root: string): boolean {
  const row = record(value);
  if (!Array.isArray(row?.claimedNames)
    || !row.claimedNames.every((name) => typeof name === "string")
    || new Set(row.claimedNames).size !== row.claimedNames.length
    || !Array.isArray(row.servers) || !Array.isArray(row.skipped)
    || (row.disabled !== undefined && !Array.isArray(row.disabled))) return false;
  for (const disabledValue of row.disabled ?? []) {
    const disabled = record(disabledValue);
    const sourceRow = record(disabled?.source);
    const relativePath = sourceRow?.kind === "canonical"
      ? ".omp/mcp.json"
      : sourceRow?.kind === "legacy" ? ".omp/.mcp.json" : null;
    if (typeof disabled?.name !== "string"
      || !(row.claimedNames as string[]).includes(disabled.name)
      || !sourceRow || !relativePath
      || sourceRow.relativePath !== relativePath
      || sourceRow.absolutePath !== join(root, ...relativePath.split("/"))) {
      return false;
    }
  }
  for (const serverValue of row.servers) {
    const server = record(serverValue);
    const config = server?.config;
    const sourceRow = record(server?.source);
    const relativePath = sourceRow?.kind === "canonical"
      ? ".omp/mcp.json"
      : sourceRow?.kind === "legacy" ? ".omp/.mcp.json" : null;
    if (typeof server?.name !== "string"
      || !(row.claimedNames as string[]).includes(server.name)
      || !Object.hasOwn(server, "config")
      || !jsonValue(config) || !strings(server.errors)
      || (server.errors as string[]).length !== 0
      || !sourceRow || !relativePath
      || sourceRow.relativePath !== relativePath
      || sourceRow.absolutePath !== join(root, ...relativePath.split("/"))
      || projectMcpValidationErrors(server.name, config).length !== 0
      || record(config)?.enabled === false) {
      return false;
    }
  }
  return row.skipped.every((value) => {
    const skipped = record(value);
    if (!skipped) return false;
    const path = skipped?.path;
    return typeof path === "string"
      && (path === ".omp/mcp.json" || path.startsWith(".omp/mcp.json#mcpServers.")
        || path === ".omp/.mcp.json" || path.startsWith(".omp/.mcp.json#mcpServers."))
      && typeof skipped.reason === "string";
  });
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSnapshot(value: unknown, root: string): value is ProjectDeclarativeSnapshot {
  const snapshot = record(value);
  const resources = record(snapshot?.resources);
  if (!snapshot || !hasOnlyFields(snapshot, PROJECT_SNAPSHOT_FIELDS) || !resources
    || !Array.isArray(snapshot.contextFiles)
    || !snapshot.contextFiles.every((item) => contextFile(item, root))
    || !Array.isArray(snapshot.skills) || !snapshot.skills.every((item) => skill(item, root))
    || !Array.isArray(snapshot.rules) || !snapshot.rules.every((item) => rule(item, root))
    || !Array.isArray(snapshot.promptTemplates) || !snapshot.promptTemplates.every(prompt)
    || !Array.isArray(snapshot.slashCommands) || !snapshot.slashCommands.every(command)
    || !mcp(snapshot.mcp, root)
    || !strings(snapshot.mcpWarnings)
    || !strings(snapshot.warnings)
    || !(snapshot.mcpWarnings as string[]).every((warning) =>
      (snapshot.warnings as string[]).includes(warning))
    || typeof snapshot.truncated !== "boolean"
    || !count(resources.instructions) || resources.instructions !== snapshot.contextFiles.length
    || !count(resources.skills) || resources.skills !== snapshot.skills.length
    || !count(resources.rules) || resources.rules !== snapshot.rules.length
    || !count(resources.prompts) || resources.prompts !== snapshot.promptTemplates.length
    || !count(resources.commands) || resources.commands !== snapshot.slashCommands.length
    || !count(resources.agents)
    || !count(resources.mcpServers)
    || resources.mcpServers
      !== (snapshot.mcp as ProjectDeclarativeSnapshot["mcp"]).servers.length
    || !count(resources.ignoredExecutable)) {
    return false;
  }
  return true;
}

function invalid(path: string): GhostError {
  return new GhostError(
    "project_snapshot_invalid",
    `${path} does not match the immutable Pi project snapshot contract.`,
    500,
  );
}

export async function readPiProjectSnapshot(input: {
  sessionDir: string;
  conversationId: string;
  generation: number;
  root: string;
  identity: ProjectFilesystemIdentity;
}): Promise<ProjectDeclarativeSnapshot> {
  const path = piProjectSnapshotPath(input.sessionDir, input.conversationId, input.generation);
  try {
    const raw = await readDaemonControlFile(path, PI_PROJECT_SNAPSHOT_MAX_BYTES);
    const parsed = JSON.parse(raw) as Partial<StoredPiProjectSnapshot>;
    if (parsed.version !== PI_PROJECT_SNAPSHOT_VERSION
      || parsed.runtime !== "pi"
      || parsed.conversationId !== input.conversationId
      || parsed.generation !== input.generation
      || parsed.root !== input.root
      || parsed.identity?.dev !== input.identity.dev
      || parsed.identity?.ino !== input.identity.ino
      || !validSnapshot(parsed.snapshot, input.root)) {
      throw invalid(path);
    }
    return parsed.snapshot;
  } catch (error) {
    if (error instanceof GhostError && error.code === "project_snapshot_invalid") throw error;
    throw invalid(path);
  }
}

async function atomicJson(path: string, value: StoredPiProjectSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writePiProjectSnapshot(input: {
  sessionDir: string;
  conversationId: string;
  generation: number;
  root: string;
  identity: ProjectFilesystemIdentity;
  snapshot: ProjectDeclarativeSnapshot;
  destinationPath?: string;
}): Promise<string> {
  if (!validSnapshot(input.snapshot, input.root)) {
    throw new TypeError("refusing to persist an invalid Pi project snapshot");
  }
  const path = input.destinationPath
    ?? piProjectSnapshotPath(input.sessionDir, input.conversationId, input.generation);
  await atomicJson(path, {
    version: PI_PROJECT_SNAPSHOT_VERSION,
    runtime: "pi",
    conversationId: input.conversationId,
    generation: input.generation,
    root: input.root,
    identity: input.identity,
    snapshot: input.snapshot,
  });
  return path;
}

export async function removePiProjectSnapshotsExcept(
  sessionDir: string,
  conversationId: string,
  keep?: string,
): Promise<void> {
  await Promise.all((await piProjectSnapshotPaths(sessionDir, conversationId))
    .filter((path) => path !== keep)
    .map((path) => rm(path, { force: true })));
}
