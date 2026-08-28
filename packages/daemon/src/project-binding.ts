import { randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConversationRuntime } from "./conversation-identity.js";
import { readDaemonControlFile } from "./control-file.js";
import {
  descriptorPath,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
} from "@ghost/extensions";
import { GhostError } from "./ghosts.js";
import {
  loadProjectDeclarativeSnapshot,
  pinnedProjectIdentity,
  type ProjectFilesystemIdentity,
} from "./project-resources.js";
import {
  readPiProjectSnapshot,
  removePiProjectSnapshotsExcept,
  writePiProjectSnapshot,
} from "./project-snapshot.js";
import { sessionFileNameFor } from "./session-files.js";

export const PROJECT_BINDING_VERSION = 1;
export const PROJECT_TRUST_VERSION = 1;
export const PROJECT_TRUST_TOKEN_TTL_MS = 5 * 60_000;
export const PROJECT_TRUST_MAX_BYTES = 1_048_576;
export const PROJECT_TRUST_MAX_ROOTS = 8_192;
export const PROJECT_TRUST_ROOT_MAX_BYTES = 16 * 1024;
export const PROJECT_BINDING_MAX_BYTES = 1_048_576;
const PROJECT_BINDING_PATH_MAX_BYTES = PROJECT_TRUST_ROOT_MAX_BYTES;
const PROJECT_BINDING_ERROR_CODE_MAX_BYTES = 128;
const PROJECT_BINDING_ERROR_MESSAGE_MAX_BYTES = 8 * 1024;
const PROJECT_BINDING_IDENTITY_MAX_DIGITS = 64;
const PROJECT_TRUST_TIMESTAMP_MAX_BYTES = 32;

export interface ProjectResourceSummary {
  instructions: number;
  skills: number;
  rules: number;
  prompts: number;
  commands: number;
  agents: number;
  mcpServers: number;
  ignoredExecutable: number;
}

export const EMPTY_PROJECT_RESOURCES: ProjectResourceSummary = Object.freeze({
  instructions: 0,
  skills: 0,
  rules: 0,
  prompts: 0,
  commands: 0,
  agents: 0,
  mcpServers: 0,
  ignoredExecutable: 0,
});

export type ProjectBindingReason =
  | "default"
  | "legacy"
  | "bound"
  | "reloaded"
  | "unbound"
  | "resumed";

export interface ProjectBindingState {
  id: string;
  conversationId: string;
  runtime: ConversationRuntime;
  root: string | null;
  cwd: string;
  relativeCwd: string | null;
  name: string | null;
  generation: number;
  status: "unbound" | "ready" | "degraded";
  error: { code: string; message: string } | null;
  mcpStatus: "off" | "ready" | "degraded";
  resources: ProjectResourceSummary;
  canRebind: boolean;
  lastRefreshAt: string | null;
  reason: ProjectBindingReason;
}

interface StoredProjectBinding {
  version: typeof PROJECT_BINDING_VERSION;
  runtime: ConversationRuntime;
  conversationId: string;
  root: string | null;
  cwd: string;
  generation: number;
  status: "unbound" | "ready" | "degraded";
  error: { code: string; message: string } | null;
  mcpStatus: "off" | "ready" | "degraded";
  resources: ProjectResourceSummary;
  lastRefreshAt: string | null;
  reason: ProjectBindingReason;
  identity: { dev: string; ino: string } | null;
}

interface TrustFile {
  version: typeof PROJECT_TRUST_VERSION;
  roots: Array<{ root: string; dev: string; ino: string; trustedAt: string }>;
}

interface PreviewToken {
  key: string;
  incarnation: number;
  root: string;
  dev: string;
  ino: string;
  expiresAtMs: number;
}

export interface ProjectPreview {
  root: string;
  name: string;
  trustToken: string;
  expiresAt: string;
  resources: ProjectResourceSummary;
  warnings: string[];
}

export interface ProjectBindingStoreOptions {
  ownerHome?: string;
  trustPath?: string;
  now?: () => number;
  trustTokenTtlMs?: number;
}

function defaultTrustPath(ownerHome: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : join(ownerHome, ".local", "state");
  return join(stateHome, "ghost", "project-trust.json");
}

function bindingStem(conversationId: string): string {
  return sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
}

export function projectBindingPath(
  sessionDir: string,
  runtime: ConversationRuntime,
  conversationId: string,
): string {
  return join(sessionDir, `${bindingStem(conversationId)}.${runtime}.project.json`);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function projectRelative(root: string | null, cwd: string): string | null {
  if (!root || !isWithin(root, cwd)) return null;
  const rel = relative(root, cwd);
  return rel === "" ? "." : rel;
}

function projectName(root: string): string {
  return basename(root) || root;
}

async function identityFor(path: string): Promise<{ root: string; dev: string; ino: string }> {
  if (!isAbsolute(path)) {
    throw new GhostError("invalid_request", "Project paths must be absolute.", 400);
  }
  return pinnedProjectIdentity(path);
}

function completeResources(value: Partial<ProjectResourceSummary> | null | undefined): ProjectResourceSummary {
  const count = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  return {
    instructions: count(value?.instructions),
    skills: count(value?.skills),
    rules: count(value?.rules),
    prompts: count(value?.prompts),
    commands: count(value?.commands),
    agents: count(value?.agents),
    mcpServers: count(value?.mcpServers),
    ignoredExecutable: count(value?.ignoredExecutable),
  };
}

export async function summarizeProject(
  root: string,
  expectedIdentity?: ProjectFilesystemIdentity,
): Promise<ProjectResourceSummary> {
  return (await loadProjectDeclarativeSnapshot(root, {
    level: "project",
    expectedIdentity,
    includeContents: false,
  })).resources;
}

async function atomicBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(bytes);
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

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function invalidTrust(path: string): GhostError {
  return new GhostError(
    "project_trust_invalid",
    `${path} does not match the secure project trust ledger contract.`,
    500,
  );
}

function trustRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function canonicalAbsolutePath(value: unknown): value is string {
  return boundedString(value, PROJECT_BINDING_PATH_MAX_BYTES)
    && isAbsolute(value)
    && resolve(value) === value;
}

function canonicalIdentityPart(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= PROJECT_BINDING_IDENTITY_MAX_DIGITS
    && /^\d+$/u.test(value)
    && BigInt(value).toString() === value;
}

function validTrustFile(value: unknown): value is TrustFile {
  const ledger = trustRecord(value);
  if (!ledger
    || !exactFields(ledger, ["version", "roots"])
    || ledger.version !== PROJECT_TRUST_VERSION
    || !Array.isArray(ledger.roots)
    || ledger.roots.length > PROJECT_TRUST_MAX_ROOTS) {
    return false;
  }
  const roots = new Set<string>();
  for (const candidate of ledger.roots) {
    const row = trustRecord(candidate);
    if (!row
      || !exactFields(row, ["root", "dev", "ino", "trustedAt"])
      || !boundedString(row.root, PROJECT_TRUST_ROOT_MAX_BYTES)
      || !isAbsolute(row.root)
      || resolve(row.root) !== row.root
      || roots.has(row.root)
      || !canonicalIdentityPart(row.dev)
      || !canonicalIdentityPart(row.ino)
      || !boundedString(row.trustedAt, PROJECT_TRUST_TIMESTAMP_MAX_BYTES)
      || !exactIsoTimestamp(row.trustedAt)) {
      return false;
    }
    roots.add(row.root);
  }
  return true;
}

function serializeTrustFile(path: string, value: unknown): Uint8Array {
  if (!validTrustFile(value)) throw invalidTrust(path);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > PROJECT_TRUST_MAX_BYTES) throw invalidTrust(path);
  return bytes;
}

const trustWrites = new Map<string, Promise<void>>();

function serializeTrustWrite(path: string, action: () => Promise<void>): Promise<void> {
  const previous = trustWrites.get(path) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  const tail = result.then(() => {}, () => {});
  trustWrites.set(path, tail);
  void tail.finally(() => {
    if (trustWrites.get(path) === tail) trustWrites.delete(path);
  });
  return result;
}

async function openPinnedTrustFile(
  path: string,
): Promise<{
  parent: Awaited<ReturnType<typeof openDirectoryNoFollow>>;
  file: Awaited<ReturnType<typeof openRegularFileNoFollow>>;
  entryPath: string;
}> {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  const name = parts.pop();
  if (!name) throw invalidTrust(path);
  let parent = await openDirectoryNoFollow("/", "Project trust ledger root");
  try {
    for (const part of parts) {
      const next = await openDirectoryNoFollow(
        descriptorPath(parent, part),
        "Project trust ledger directory",
      );
      await parent.close();
      parent = next;
    }
    const entryPath = descriptorPath(parent, name);
    const file = await openRegularFileNoFollow(entryPath, "Project trust ledger");
    return { parent, file, entryPath };
  } catch (error) {
    await parent.close().catch(() => {});
    throw error;
  }
}

async function readProjectTrustFile(path: string): Promise<TrustFile> {
  let opened: Awaited<ReturnType<typeof openPinnedTrustFile>>;
  try {
    opened = await openPinnedTrustFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw invalidTrust(path);
  }
  try {
    const before = await opened.file.stat({ bigint: true });
    if (!before.isFile()
      || before.nlink !== 1n
      || (Number(before.mode) & 0o777) !== 0o600
      || before.size > BigInt(PROJECT_TRUST_MAX_BYTES)) {
      throw invalidTrust(path);
    }
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const result = await opened.file.read(
        bytes,
        length,
        bytes.byteLength - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await opened.file.stat({ bigint: true });
    const live = await lstat(opened.entryPath, { bigint: true });
    if (!after.isFile()
      || after.nlink !== 1n
      || (Number(after.mode) & 0o777) !== 0o600
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || after.size !== BigInt(length)
      || after.size > BigInt(PROJECT_TRUST_MAX_BYTES)
      || !live.isFile()
      || live.nlink !== 1n
      || (Number(live.mode) & 0o777) !== 0o600
      || live.dev !== after.dev
      || live.ino !== after.ino
      || live.size !== after.size
      || live.mtimeNs !== after.mtimeNs
      || live.ctimeNs !== after.ctimeNs) {
      throw invalidTrust(path);
    }
    const raw = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, length));
    const value: unknown = JSON.parse(raw);
    if (!validTrustFile(value)) throw invalidTrust(path);
    return value;
  } catch (error) {
    if (error instanceof GhostError && error.code === "project_trust_invalid") throw error;
    throw invalidTrust(path);
  } finally {
    await opened.file.close().catch(() => {});
    await opened.parent.close().catch(() => {});
  }
}

const STORED_BINDING_FIELDS = [
  "version",
  "runtime",
  "conversationId",
  "root",
  "cwd",
  "generation",
  "status",
  "error",
  "mcpStatus",
  "resources",
  "lastRefreshAt",
  "reason",
  "identity",
] as const;
const STORED_RESOURCE_FIELDS = [
  "instructions",
  "skills",
  "rules",
  "prompts",
  "commands",
  "agents",
  "mcpServers",
  "ignoredExecutable",
] as const;
const STORED_BINDING_STATUSES = new Set(["unbound", "ready", "degraded"]);
const STORED_MCP_STATUSES = new Set(["off", "ready", "degraded"]);
const STORED_BINDING_REASONS = new Set<ProjectBindingReason>([
  "default",
  "legacy",
  "bound",
  "reloaded",
  "unbound",
  "resumed",
]);

function storedResources(value: unknown): value is ProjectResourceSummary {
  const resources = trustRecord(value);
  return !!resources
    && exactFields(resources, STORED_RESOURCE_FIELDS)
    && STORED_RESOURCE_FIELDS.every((field) =>
      typeof resources[field] === "number"
      && Number.isSafeInteger(resources[field])
      && (resources[field] as number) >= 0);
}

function storedError(value: unknown): value is StoredProjectBinding["error"] {
  if (value === null) return true;
  const error = trustRecord(value);
  return !!error
    && exactFields(error, ["code", "message"])
    && boundedString(error.code, PROJECT_BINDING_ERROR_CODE_MAX_BYTES)
    && boundedString(error.message, PROJECT_BINDING_ERROR_MESSAGE_MAX_BYTES);
}

function storedIdentity(value: unknown): value is NonNullable<StoredProjectBinding["identity"]> {
  const identity = trustRecord(value);
  return !!identity
    && exactFields(identity, ["dev", "ino"])
    && canonicalIdentityPart(identity.dev)
    && canonicalIdentityPart(identity.ino);
}

function invalidBinding(path: string): GhostError {
  return new GhostError(
    "project_binding_invalid",
    `${path} is not valid project binding metadata.`,
    500,
  );
}

function parseStoredBinding(
  value: unknown,
  runtime: ConversationRuntime,
  conversationId: string,
  path: string,
): StoredProjectBinding {
  const row = trustRecord(value);
  const root = row?.root;
  const identity = row?.identity;
  if (!row
    || !exactFields(row, STORED_BINDING_FIELDS)
    || row.version !== PROJECT_BINDING_VERSION
    || row.runtime !== runtime
    || row.conversationId !== conversationId
    || (root !== null && !canonicalAbsolutePath(root))
    || !canonicalAbsolutePath(row.cwd)
    || (typeof row.generation !== "number"
      || !Number.isSafeInteger(row.generation)
      || row.generation < 0)
    || typeof row.status !== "string" || !STORED_BINDING_STATUSES.has(row.status)
    || !storedError(row.error)
    || typeof row.mcpStatus !== "string" || !STORED_MCP_STATUSES.has(row.mcpStatus)
    || !storedResources(row.resources)
    || (row.lastRefreshAt !== null && !exactIsoTimestamp(row.lastRefreshAt))
    || typeof row.reason !== "string"
    || !STORED_BINDING_REASONS.has(row.reason as ProjectBindingReason)
    || (root === null ? identity !== null : !storedIdentity(identity))
    || (root !== null && !isWithin(root as string, row.cwd as string))
    || (root === null && (row.status !== "unbound"
      || row.error !== null
      || row.mcpStatus !== "off"
      || STORED_RESOURCE_FIELDS.some((field) =>
        (row.resources as unknown as ProjectResourceSummary)[field] !== 0)))) {
    throw invalidBinding(path);
  }
  return row as unknown as StoredProjectBinding;
}

export class ProjectBindingStore {
  readonly ownerHome: string;
  readonly trustPath: string;
  private readonly now: () => number;
  private readonly trustTokenTtlMs: number;
  private readonly previews = new Map<string, PreviewToken>();
  private readonly incarnations = new Map<string, number>();
  private readonly bindingWrites = new Map<string, Promise<void>>();

  constructor(options: ProjectBindingStoreOptions = {}) {
    this.ownerHome = resolve(options.ownerHome ?? homedir());
    if (!isAbsolute(this.ownerHome)) throw new TypeError("ownerHome must be absolute");
    this.trustPath = resolve(options.trustPath ?? defaultTrustPath(this.ownerHome));
    this.now = options.now ?? Date.now;
    this.trustTokenTtlMs = options.trustTokenTtlMs ?? PROJECT_TRUST_TOKEN_TTL_MS;
  }

  private key(scope: string, runtime: ConversationRuntime, conversationId: string): string {
    return JSON.stringify([scope, runtime, conversationId]);
  }

  hasPreview(scope: string, runtime: ConversationRuntime, conversationId: string): boolean {
    const key = this.key(scope, runtime, conversationId);
    return [...this.previews.values()].some((preview) => preview.key === key);
  }

  revoke(scope: string, runtime: ConversationRuntime, conversationId: string): void {
    const key = this.key(scope, runtime, conversationId);
    this.incarnations.set(key, (this.incarnations.get(key) ?? 0) + 1);
    for (const [token, preview] of this.previews) {
      if (preview.key === key) this.previews.delete(token);
    }
  }

  /** Revoke all receipts minted under a ghost identity before rename/delete. */
  revokeScope(scope: string): void {
    const keys = new Set<string>();
    for (const preview of this.previews.values()) {
      if ((JSON.parse(preview.key) as [string])[0] === scope) keys.add(preview.key);
    }
    for (const key of this.incarnations.keys()) {
      if ((JSON.parse(key) as [string])[0] === scope) keys.add(key);
    }
    for (const key of keys) {
      this.incarnations.set(key, (this.incarnations.get(key) ?? 0) + 1);
      for (const [token, preview] of this.previews) {
        if (preview.key === key) this.previews.delete(token);
      }
    }
  }

  private serializeBinding<T>(path: string, action: () => Promise<T>): Promise<T> {
    const previous = this.bindingWrites.get(path) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    const tail = result.then(() => {}, () => {});
    this.bindingWrites.set(path, tail);
    void tail.finally(() => {
      if (this.bindingWrites.get(path) === tail) this.bindingWrites.delete(path);
    });
    return result;
  }

  async read(
    sessionDir: string,
    id: string,
    runtime: ConversationRuntime,
    conversationId: string,
    options: {
      legacyCwd?: string | (() => Promise<string | undefined>);
      canRebind?: boolean;
    } = {},
  ): Promise<ProjectBindingState> {
    const path = projectBindingPath(sessionDir, runtime, conversationId);
    let stored: StoredProjectBinding | null = null;
    try {
      const parsed: unknown = JSON.parse(await readDaemonControlFile(
        path,
        PROJECT_BINDING_MAX_BYTES,
      ));
      stored = parseStoredBinding(parsed, runtime, conversationId, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof GhostError && error.code === "project_binding_invalid") throw error;
        throw invalidBinding(path);
      }
    }
    if (stored) {
      let cwd: string;
      try {
        cwd = await realpath(stored.cwd);
        if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
        if (cwd !== stored.cwd) throw invalidBinding(path);
      } catch (error) {
        if (error instanceof GhostError && error.code === "project_binding_invalid") throw error;
        throw new GhostError(
          "invalid_project_path",
          "The conversation's saved working directory is no longer available.",
          400,
        );
      }
      if (stored.root) {
        const expected = stored.identity;
        if (!expected) throw invalidBinding(path);
        const storedIdentityWasTrusted = (await this.readTrust()).roots.some((row) =>
          row.root === stored.root
          && row.dev === expected.dev
          && row.ino === expected.ino);
        if (!storedIdentityWasTrusted) {
          throw invalidBinding(path);
        }
        const current = await this.assertTrusted(stored.root);
        if (current.root !== stored.root
          || current.dev !== expected.dev || current.ino !== expected.ino) {
          throw invalidBinding(path);
        }
        if (!isWithin(current.root, cwd)) throw invalidBinding(path);
      }
    }
    const legacyCwd = stored
      ? undefined
      : typeof options.legacyCwd === "function"
        ? await options.legacyCwd()
        : options.legacyCwd;
    const cwd = stored?.cwd ?? resolve(legacyCwd ?? this.ownerHome);
    const root = stored?.root ?? null;
    return {
      id,
      conversationId,
      runtime,
      root,
      cwd,
      relativeCwd: projectRelative(root, cwd),
      name: root ? projectName(root) : null,
      generation: stored?.generation ?? 0,
      status: stored?.status ?? "unbound",
      error: stored?.error ?? null,
      mcpStatus: stored?.mcpStatus ?? "off",
      resources: stored?.resources ?? { ...EMPTY_PROJECT_RESOURCES },
      canRebind: options.canRebind ?? true,
      lastRefreshAt: stored?.lastRefreshAt ?? null,
      reason: stored?.reason ?? (legacyCwd ? "legacy" : "default"),
    };
  }

  async preview(
    runtime: ConversationRuntime,
    conversationId: string,
    path: string,
    scope = "",
  ): Promise<ProjectPreview> {
    const now = this.now();
    for (const [token, preview] of this.previews) {
      if (preview.expiresAtMs <= now) this.previews.delete(token);
    }
    const key = this.key(scope, runtime, conversationId);
    const incarnation = this.incarnations.get(key) ?? 0;
    const identity = await identityFor(path);
    const snapshot = await loadProjectDeclarativeSnapshot(identity.root, {
      level: "project",
      expectedIdentity: identity,
      includeContents: false,
    });
    const resources = snapshot.resources;
    if ((this.incarnations.get(key) ?? 0) !== incarnation) {
      throw new GhostError("trust_token_revoked", "The conversation changed while its project was previewed.", 409);
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAtMs = now + this.trustTokenTtlMs;
    this.previews.set(token, {
      key,
      incarnation,
      ...identity,
      expiresAtMs,
    });
    const warnings = [
      ...snapshot.warnings,
      ...(resources.ignoredExecutable > 0
        ? [`${resources.ignoredExecutable} executable project resource(s) will remain disabled until isolated workers are available.`]
        : []),
      ...(snapshot.truncated ? ["This preview is truncated; only the displayed counts were admitted."] : []),
    ];
    return {
      root: identity.root,
      name: projectName(identity.root),
      trustToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      resources,
      warnings,
    };
  }

  private async readTrust(): Promise<TrustFile> {
    try {
      return await readProjectTrustFile(this.trustPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: PROJECT_TRUST_VERSION, roots: [] };
      }
      throw error;
    }
  }

  private trust(identity: { root: string; dev: string; ino: string }): Promise<void> {
    return serializeTrustWrite(this.trustPath, async () => {
      const current = await this.readTrust();
      const roots = current.roots.filter((row) => row.root !== identity.root);
      roots.push({ ...identity, trustedAt: new Date(this.now()).toISOString() });
      const candidate = { version: PROJECT_TRUST_VERSION, roots };
      const bytes = serializeTrustFile(this.trustPath, candidate);
      await atomicBytes(this.trustPath, bytes);
    });
  }

  async assertTrusted(root: string): Promise<{ root: string; dev: string; ino: string }> {
    const identity = await identityFor(root);
    const trusted = (await this.readTrust()).roots.some((row) =>
      row.root === identity.root && row.dev === identity.dev && row.ino === identity.ino);
    if (!trusted) {
      throw new GhostError("project_not_trusted", "Preview and confirm this project again before loading it.", 403);
    }
    return identity;
  }

  async write(input: {
    sessionDir: string;
    runtime: ConversationRuntime;
    conversationId: string;
    current: ProjectBindingState;
    root: string | null;
    cwd?: string;
    trustToken?: string;
    reason: ProjectBindingReason;
    resources?: ProjectResourceSummary;
    status?: "unbound" | "ready" | "degraded";
    error?: { code: string; message: string } | null;
    mcpStatus?: "off" | "ready" | "degraded";
    scope?: string;
  }): Promise<void> {
    if (input.cwd !== undefined && !isAbsolute(input.cwd)) {
      throw new GhostError("invalid_request", "A project working directory must be absolute.", 400);
    }
    if (input.root !== null && !isAbsolute(input.root)) {
      throw new GhostError("invalid_request", "A project root must be absolute.", 400);
    }
    let identity: { root: string; dev: string; ino: string } | null = null;
    let root: string | null = null;
    if (input.root !== null) {
      identity = await identityFor(input.root);
      const preview = input.trustToken ? this.previews.get(input.trustToken) : undefined;
      if (input.reason === "reloaded" && !preview) {
        identity = await this.assertTrusted(identity.root);
      } else {
        if (!input.trustToken || !preview) {
          throw new GhostError(
            "trust_token_invalid",
            "Preview this project again before confirming it.",
            403,
          );
        }
        this.previews.delete(input.trustToken);
        if (preview.expiresAtMs < this.now()) {
          throw new GhostError("trust_token_expired", "The project preview expired; preview it again.", 403);
        }
        if (preview.key !== this.key(input.scope ?? "", input.runtime, input.conversationId)
          || preview.incarnation !== (this.incarnations.get(preview.key) ?? 0)
          || preview.root !== identity.root || preview.dev !== identity.dev || preview.ino !== identity.ino) {
          throw new GhostError("trust_token_invalid", "That preview does not authorize this project.", 403);
        }
        await this.trust(identity);
      }
      root = identity.root;
    }
    let requestedCwd: string;
    try {
      requestedCwd = await realpath(resolve(input.cwd ?? (root ?? input.current.cwd)));
      if (!(await stat(requestedCwd)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new GhostError("invalid_project_path", "The requested working directory is not a directory.", 400);
    }
    if (root && !isWithin(root, requestedCwd)) {
      throw new GhostError("cwd_outside_project", "A bound conversation's cwd must remain inside its project root.", 400);
    }
    const generation = input.current.generation + 1;
    const scannedProject = root
      ? await loadProjectDeclarativeSnapshot(root, {
          level: "project",
          expectedIdentity: identity ?? undefined,
          includeContents: input.runtime === "pi",
        })
      : null;
    const projectSnapshot = input.runtime === "pi" ? scannedProject : null;
    const resources = scannedProject?.resources ?? input.resources ?? (root
      ? await summarizeProject(root, identity ?? undefined)
      : { ...EMPTY_PROJECT_RESOURCES });
    const mcpDegraded = (scannedProject?.mcpWarnings.length ?? 0) > 0;
    let snapshotPath: string | undefined;
    if (projectSnapshot && identity && root) {
      snapshotPath = await writePiProjectSnapshot({
        sessionDir: input.sessionDir,
        conversationId: input.conversationId,
        generation,
        root,
        identity,
        snapshot: projectSnapshot,
      });
    }
    const now = new Date(this.now()).toISOString();
    const stored: StoredProjectBinding = {
      version: PROJECT_BINDING_VERSION,
      runtime: input.runtime,
      conversationId: input.conversationId,
      root,
      cwd: requestedCwd,
      generation,
      status: input.status ?? (root ? mcpDegraded ? "degraded" : "ready" : "unbound"),
      error: input.error ?? (mcpDegraded
        ? {
            code: "project_mcp_degraded",
            message: "One or more project MCP resources could not be admitted.",
          }
        : null),
      mcpStatus: input.mcpStatus ?? (mcpDegraded
        ? "degraded"
        : root && resources.mcpServers > 0 ? "ready" : "off"),
      resources: completeResources(resources),
      lastRefreshAt: now,
      reason: input.reason,
      identity: identity ? { dev: identity.dev, ino: identity.ino } : null,
    };
    const bindingPath = projectBindingPath(
      input.sessionDir,
      input.runtime,
      input.conversationId,
    );
    try {
      await atomicJson(
        bindingPath,
        parseStoredBinding(stored, input.runtime, input.conversationId, bindingPath),
      );
    } catch (error) {
      if (snapshotPath) await rm(snapshotPath, { force: true }).catch(() => {});
      throw error;
    }
    if (input.runtime === "pi") {
      await removePiProjectSnapshotsExcept(
        input.sessionDir,
        input.conversationId,
        snapshotPath,
      ).catch(() => {});
    }
  }

  async remove(sessionDir: string, runtime: ConversationRuntime, conversationId: string): Promise<void> {
    await rm(projectBindingPath(sessionDir, runtime, conversationId), { force: true });
    if (runtime === "pi") {
      await removePiProjectSnapshotsExcept(sessionDir, conversationId).catch(() => {});
    }
  }

  async updateRuntimeStatus(
    sessionDir: string,
    runtime: ConversationRuntime,
    conversationId: string,
    current: ProjectBindingState,
    input: {
      status: "ready" | "degraded";
      error: { code: string; message: string } | null;
      mcpStatus: "off" | "ready" | "degraded";
    },
  ): Promise<boolean> {
    if (!current.root) return false;
    const identity = await this.assertTrusted(current.root);
    const path = projectBindingPath(sessionDir, runtime, conversationId);
    return this.serializeBinding(path, async () => {
      let disk: unknown;
      try {
        disk = JSON.parse(await readDaemonControlFile(path, PROJECT_BINDING_MAX_BYTES));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw invalidBinding(path);
      }
      const parsed = parseStoredBinding(disk, runtime, conversationId, path);
      if (parsed.root !== current.root
        || parsed.cwd !== current.cwd
        || parsed.generation !== current.generation
        || parsed.identity?.dev !== identity.dev
        || parsed.identity?.ino !== identity.ino) {
        return false;
      }
      const stored: StoredProjectBinding = {
        ...parsed,
        status: input.status,
        error: input.error,
        mcpStatus: input.mcpStatus,
        identity: { dev: identity.dev, ino: identity.ino },
      };
      await atomicJson(path, parseStoredBinding(stored, runtime, conversationId, path));
      return true;
    });
  }

  async clone(
    sessionDir: string,
    runtime: ConversationRuntime,
    conversationId: string,
    source: ProjectBindingState,
    destinationPath = projectBindingPath(sessionDir, runtime, conversationId),
    snapshotDestinationPath?: string,
  ): Promise<void> {
    const identity = source.root ? await this.assertTrusted(source.root) : null;
    let destinationSnapshot: string | undefined;
    if (runtime === "pi" && source.root && identity) {
      const snapshot = await readPiProjectSnapshot({
        sessionDir,
        conversationId: source.conversationId,
        generation: source.generation,
        root: source.root,
        identity,
      });
      destinationSnapshot = await writePiProjectSnapshot({
        sessionDir,
        conversationId,
        generation: source.generation,
        root: source.root,
        identity,
        snapshot,
        ...(snapshotDestinationPath ? { destinationPath: snapshotDestinationPath } : {}),
      });
    }
    const stored: StoredProjectBinding = {
      version: PROJECT_BINDING_VERSION,
      runtime,
      conversationId,
      root: source.root,
      cwd: source.cwd,
      generation: source.generation,
      status: source.status,
      error: source.error,
      mcpStatus: source.mcpStatus,
      resources: completeResources(source.resources),
      lastRefreshAt: source.lastRefreshAt,
      reason: "resumed",
      identity: identity ? { dev: identity.dev, ino: identity.ino } : null,
    };
    try {
      await atomicJson(
        destinationPath,
        parseStoredBinding(stored, runtime, conversationId, destinationPath),
      );
    } catch (error) {
      if (destinationSnapshot) await rm(destinationSnapshot, { force: true }).catch(() => {});
      throw error;
    }
  }

  async resolveOperationalCwd(current: ProjectBindingState, cwd: string): Promise<string> {
    if (!isAbsolute(cwd)) {
      throw new GhostError("invalid_project_path", "A working directory must be absolute.", 400);
    }
    let resolvedCwd: string;
    let info: import("node:fs").Stats;
    try {
      resolvedCwd = await realpath(cwd);
      info = await stat(resolvedCwd);
    } catch {
      throw new GhostError("invalid_project_path", "The requested working directory does not exist.", 400);
    }
    if (!info.isDirectory()) {
      throw new GhostError("invalid_project_path", "The requested working directory is not a directory.", 400);
    }
    if (current.root) {
      const identity = await this.assertTrusted(current.root);
      if (!isWithin(identity.root, resolvedCwd)) {
        throw new GhostError(
          "cwd_outside_project",
          "Leaving a bound project requires an explicit project rebind.",
          409,
        );
      }
    }
    return resolvedCwd;
  }

  async writeOperationalCwd(
    sessionDir: string,
    runtime: ConversationRuntime,
    conversationId: string,
    current: ProjectBindingState,
    cwd: string,
  ): Promise<void> {
    const resolvedCwd = await this.resolveOperationalCwd(current, cwd);
    const identity = current.root ? await this.assertTrusted(current.root) : null;
    const generation = current.generation + 1;
    let snapshotPath: string | undefined;
    if (runtime === "pi" && current.root && identity) {
      const snapshot = await readPiProjectSnapshot({
        sessionDir,
        conversationId,
        generation: current.generation,
        root: current.root,
        identity,
      });
      snapshotPath = await writePiProjectSnapshot({
        sessionDir,
        conversationId,
        generation,
        root: current.root,
        identity,
        snapshot,
      });
    }
    const stored: StoredProjectBinding = {
      version: PROJECT_BINDING_VERSION,
      runtime,
      conversationId,
      root: current.root,
      cwd: resolvedCwd,
      generation,
      status: current.status,
      error: current.error,
      mcpStatus: current.mcpStatus,
      resources: completeResources(current.resources),
      lastRefreshAt: current.lastRefreshAt,
      reason: "resumed",
      identity: identity ? { dev: identity.dev, ino: identity.ino } : null,
    };
    const bindingPath = projectBindingPath(sessionDir, runtime, conversationId);
    try {
      await atomicJson(
        bindingPath,
        parseStoredBinding(stored, runtime, conversationId, bindingPath),
      );
    } catch (error) {
      if (snapshotPath) await rm(snapshotPath, { force: true }).catch(() => {});
      throw error;
    }
    if (runtime === "pi") {
      await removePiProjectSnapshotsExcept(sessionDir, conversationId, snapshotPath).catch(() => {});
    }
  }
}
