/**
 * Ghost-owned MCP configuration plus confined bound-project inputs.
 *
 * OMP normally discovers MCP servers from several user-level and third-party
 * coding-agent locations. Ghost deliberately does not call that discovery
 * path here: the management API owns only visible `mcp.json` in the selected
 * ghost home. Explicitly trusted external projects hand their already-confined
 * `.omp/mcp.json` and `.omp/.mcp.json` bytes to the parser below.
 *
 * The list view is safe to send to a UI. It never returns header or environment
 * values, command arguments, OAuth client secrets, or URL query values.
 * Mutations use OMP's locked, atomic config writer and its native validation.
 */
import { isAbsolute, join, resolve } from "node:path";
import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
  addMCPServer,
  removeMCPServer,
  updateMCPServer,
  validateServerName,
} from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type {
  MCPAuthConfig,
  MCPConfigFile,
  MCPHttpServerConfig,
  MCPServerConfig,
  MCPSseServerConfig,
  MCPStdioServerConfig,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { GhostError, type GhostRegistry } from "./ghosts.js";
import {
  homeOperationsFor,
  type HomeOperationCoordinator,
} from "./home-operations.js";
import {
  descriptorPath,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
} from "@ghost/extensions";

export type McpConfigSource = "canonical" | "legacy";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpConfiguredKeysView {
  /** Names are useful for diagnostics; values are intentionally never returned. */
  keys: string[];
  configured: true;
}

export interface McpAuthView {
  type: MCPAuthConfig["type"];
  /** A stored credential reference exists. The reference itself is not returned. */
  configured: boolean;
}

export interface McpOAuthView {
  configured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
}

interface McpServerConfigViewBase {
  type: McpTransport;
  timeout?: number;
  requestIdFormat?: "string" | "number";
  auth?: McpAuthView;
  oauth?: McpOAuthView;
}

export interface McpStdioServerConfigView extends McpServerConfigViewBase {
  type: "stdio";
  command: string;
  cwd?: string;
  envPolicy?: "literal";
  /** Arguments can contain bearer tokens and are therefore summarized. */
  argumentCount: number;
  environment?: McpConfiguredKeysView;
}

export interface McpRemoteServerConfigView extends McpServerConfigViewBase {
  type: "http" | "sse";
  /** Userinfo/fragments are removed; query values are marked; malformed URLs fail closed. */
  url: string;
  headerPolicy?: "origin-locked";
  headers?: McpConfiguredKeysView;
}

export type McpServerConfigView = McpStdioServerConfigView | McpRemoteServerConfigView;

export interface McpServerView {
  name: string;
  enabled: boolean;
  source: McpConfigSource;
  /** Ghost-home-relative, never an ambient or absolute path. */
  path: "mcp.json" | ".omp/mcp.json" | ".omp/.mcp.json";
  config: McpServerConfigView;
}

export interface McpCatalogSkipped {
  path: string;
  reason: string;
}

export interface McpCatalogSnapshot {
  servers: McpServerView[];
  skipped: McpCatalogSkipped[];
}

/** Sanitized result of an isolated connection probe. */
export interface McpConnectionTest {
  name: string;
  ok: boolean;
  status: "connected" | "failed";
  toolCount: number;
  /** Deliberately generic: transport errors can echo secret-bearing config. */
  message: string;
}

export interface McpCatalogOptions {
  registry: GhostRegistry;
  /** Shared gate for path-bound mutations and whole-home moves. */
  homeOperations?: HomeOperationCoordinator;
  /** Test seam around OMP's locked atomic project-config writer. */
  writer?: Partial<McpCatalogWriter>;
}

export interface McpCatalogWriter {
  add(path: string, name: string, config: MCPServerConfig): Promise<unknown>;
  update(path: string, name: string, config: MCPServerConfig): Promise<unknown>;
  remove(path: string, name: string): Promise<unknown>;
}

const defaultWriter: McpCatalogWriter = {
  add: addMCPServer,
  update: updateMCPServer,
  remove: removeMCPServer,
};

export interface ProjectMcpConfigSource {
  kind: McpConfigSource;
  absolutePath: string;
  relativePath: McpServerView["path"];
}

export interface EffectiveProjectMcpServer {
  name: string;
  source: ProjectMcpConfigSource;
  config: unknown;
  errors: string[];
}

export interface EffectiveProjectMcpRead {
  /** Names claimed by source precedence, including disabled or invalid rows. */
  claimedNames: string[];
  /** Only valid, enabled rows admitted to a runtime snapshot. */
  servers: EffectiveProjectMcpServer[];
  skipped: McpCatalogSkipped[];
}

export interface EffectiveProjectMcpInput {
  source: ProjectMcpConfigSource;
  content?: string;
  error?: string;
}

interface ParsedProjectMcpInputs {
  effective: EffectiveProjectMcpRead;
  /** Management-only rows; never persisted in a declarative snapshot. */
  configured: EffectiveProjectMcpServer[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MCP_BASE_FIELDS = new Set([
  "enabled",
  "timeout",
  "requestIdFormat",
  "auth",
  "oauth",
]);
const MCP_STDIO_FIELDS = new Set([
  ...MCP_BASE_FIELDS,
  "type",
  "command",
  "args",
  "env",
  "envPolicy",
  "cwd",
]);
const MCP_REMOTE_FIELDS = new Set([
  ...MCP_BASE_FIELDS,
  "type",
  "url",
  "headers",
  "headerPolicy",
]);
const MCP_AUTH_FIELDS = new Set([
  "type",
  "credentialId",
  "tokenUrl",
  "clientId",
  "clientSecret",
  "resource",
]);
const MCP_OAUTH_FIELDS = new Set([
  "clientId",
  "clientSecret",
  "redirectUri",
  "callbackPort",
  "callbackPath",
  "prompt",
]);

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Validate Ghost's owned MCP boundary before OMP or an HTTP sanitizer sees a
 * value. Messages name fields but never interpolate their values.
 */
function ownedMcpValidationErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["MCP server configuration must be a JSON object."];
  const type = value.type === undefined ? "stdio" : value.type;
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    return ['MCP server "type" must be "stdio", "http", or "sse".'];
  }
  const allowed = type === "stdio" ? MCP_STDIO_FIELDS : MCP_REMOTE_FIELDS;
  if (!hasOnlyFields(value, allowed)) {
    return ["MCP server configuration contains unsupported fields."];
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return ['MCP server "enabled" must be a boolean.'];
  }
  if (value.timeout !== undefined
    && (typeof value.timeout !== "number"
      || !Number.isFinite(value.timeout)
      || value.timeout < 0)) {
    return ['MCP server "timeout" must be a finite non-negative number.'];
  }
  if (value.requestIdFormat !== undefined
    && value.requestIdFormat !== "string"
    && value.requestIdFormat !== "number") {
    return ['MCP server "requestIdFormat" must be "string" or "number".'];
  }
  if (value.auth !== undefined) {
    if (!isRecord(value.auth)
      || !hasOnlyFields(value.auth, MCP_AUTH_FIELDS)
      || (value.auth.type !== "oauth" && value.auth.type !== "apikey")
      || Object.entries(value.auth).some(([key, entry]) =>
        key !== "type" && typeof entry !== "string")) {
      return ["MCP server auth configuration is invalid."];
    }
  }
  if (value.oauth !== undefined) {
    if (!isRecord(value.oauth) || !hasOnlyFields(value.oauth, MCP_OAUTH_FIELDS)) {
      return ["MCP server OAuth configuration is invalid."];
    }
    for (const [key, entry] of Object.entries(value.oauth)) {
      if (key === "callbackPort") {
        if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1 || entry > 65_535) {
          return ["MCP server OAuth callbackPort is invalid."];
        }
      } else if (typeof entry !== "string") {
        return ["MCP server OAuth configuration is invalid."];
      }
    }
  }
  if (type === "stdio") {
    if (typeof value.command !== "string" || value.command.length === 0) {
      return ['MCP stdio "command" must be a non-empty string.'];
    }
    if (value.args !== undefined
      && (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string"))) {
      return ['MCP stdio "args" must be an array of strings.'];
    }
    if (value.env !== undefined && !isStringRecord(value.env)) {
      return ['MCP stdio "env" must contain only string values.'];
    }
    if (value.envPolicy !== undefined && value.envPolicy !== "literal") {
      return ['MCP stdio "envPolicy" must be "literal".'];
    }
    if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0)) {
      return ['MCP stdio "cwd" must be a non-empty string.'];
    }
  } else {
    if (typeof value.url !== "string" || value.url.length === 0) {
      return ['MCP remote "url" must be a non-empty string.'];
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return ['MCP remote "headers" must contain only string values.'];
    }
    if (value.headerPolicy !== undefined && value.headerPolicy !== "origin-locked") {
      return ['MCP remote "headerPolicy" must be "origin-locked".'];
    }
  }
  return [];
}

export function normalizeMcpStdioCwd(
  config: MCPServerConfig,
  sourceRoot: string,
): MCPServerConfig {
  const type = config.type ?? "stdio";
  if (type !== "stdio") return config;
  const stdio = config as MCPStdioServerConfig;
  const cwd = stdio.cwd;
  return {
    ...stdio,
    cwd: cwd === undefined ? sourceRoot : isAbsolute(cwd) ? resolve(cwd) : resolve(sourceRoot, cwd),
  };
}

/**
 * Apply OMP's ordinary environment interpolation without pre-expanding maps
 * whose transport policy makes their values opaque. MCPManager remains the
 * authority for those policies and receives the literal protected values.
 */
export function expandMcpServerConfig(config: MCPServerConfig): MCPServerConfig {
  const type = config.type ?? "stdio";
  const stdio = config as MCPStdioServerConfig;
  if (type === "stdio" && stdio.envPolicy === "literal") {
    const { env, ...ordinary } = stdio;
    return {
      ...expandEnvVarsDeep(ordinary),
      ...(env === undefined ? {} : { env: Object.fromEntries(Object.entries(env)) }),
    } as MCPServerConfig;
  }
  const remote = config as MCPHttpServerConfig | MCPSseServerConfig;
  if ((type === "http" || type === "sse")
    && remote.headerPolicy === "origin-locked") {
    const { headers, ...ordinary } = remote;
    return {
      ...expandEnvVarsDeep(ordinary),
      ...(headers === undefined
        ? {}
        : { headers: Object.fromEntries(Object.entries(headers)) }),
    } as MCPServerConfig;
  }
  return expandEnvVarsDeep(config);
}

function configuredKeys(value: unknown): McpConfiguredKeysView | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return keys.length > 0 ? { keys, configured: true } : undefined;
}

function sanitizeRemoteUrl(value: string): string {
  const lower = value.toLowerCase();
  if (value.includes("${")
    || (!lower.startsWith("http://") && !lower.startsWith("https://"))) {
    return "[configured]";
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      return "[configured]";
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of new Set(url.searchParams.keys())) {
      url.searchParams.delete(key);
      url.searchParams.append(key, "[configured]");
    }
    return url.toString();
  } catch {
    // A templated URL may not parse until OMP expands it. The opaque input can
    // carry credentials anywhere, so no part of it is safe to return.
    return "[configured]";
  }
}

function sanitizeAuth(auth: MCPServerConfig["auth"]): McpAuthView | undefined {
  if (!auth) return undefined;
  return { type: auth.type, configured: Boolean(auth.credentialId) };
}

function sanitizeOAuth(oauth: MCPServerConfig["oauth"]): McpOAuthView | undefined {
  if (!oauth) return undefined;
  return {
    configured: Object.keys(oauth).length > 0,
    clientIdConfigured: Boolean(oauth.clientId),
    clientSecretConfigured: Boolean(oauth.clientSecret),
  };
}

/** Redact every field that can reasonably carry a credential before HTTP sees it. */
export function sanitizeMcpServerConfig(config: MCPServerConfig): McpServerConfigView {
  const type = config.type ?? "stdio";
  const auth = sanitizeAuth(config.auth);
  const oauth = sanitizeOAuth(config.oauth);
  const shared = {
    ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
    ...(config.requestIdFormat === "string" || config.requestIdFormat === "number"
      ? { requestIdFormat: config.requestIdFormat }
      : {}),
    ...(auth ? { auth } : {}),
    ...(oauth ? { oauth } : {}),
  };
  if (type === "http" || type === "sse") {
    const remote = config as MCPHttpServerConfig | MCPSseServerConfig;
    const headers = configuredKeys(remote.headers);
    return {
      ...shared,
      type,
      url: sanitizeRemoteUrl(remote.url),
      ...(remote.headerPolicy === "origin-locked"
        ? { headerPolicy: remote.headerPolicy }
        : {}),
      ...(headers ? { headers } : {}),
    };
  }
  const stdio = config as MCPStdioServerConfig;
  const environment = configuredKeys(stdio.env);
  return {
    ...shared,
    type: "stdio",
    command: stdio.command,
    ...(typeof stdio.cwd === "string" ? { cwd: stdio.cwd } : {}),
    ...(stdio.envPolicy === "literal" ? { envPolicy: stdio.envPolicy } : {}),
    argumentCount: Array.isArray(stdio.args) ? stdio.args.length : 0,
    ...(environment ? { environment } : {}),
  };
}

function validationErrors(name: string, value: unknown): string[] {
  const nameError = validateServerName(name);
  if (nameError) return [nameError];
  const ownedErrors = ownedMcpValidationErrors(value);
  if (ownedErrors.length > 0) return ownedErrors;
  try {
    return validateServerConfig(name, value as unknown as MCPServerConfig);
  } catch {
    return ["MCP server configuration is invalid."];
  }
}

/** Revalidate one already-confined project row before loading a durable snapshot. */
export function projectMcpValidationErrors(name: string, value: unknown): string[] {
  return validationErrors(name, value);
}

function validateMutation(name: string, value: unknown): asserts value is MCPServerConfig {
  const errors = validationErrors(name, value);
  if (errors.length > 0) {
    throw new GhostError(
      "invalid_mcp_server",
      `Invalid MCP server ${JSON.stringify(name)}: ${errors.join("; ")}`,
      400,
    );
  }
}

function ghostMcpSource(home: string): ProjectMcpConfigSource {
  return {
    kind: "canonical",
    absolutePath: join(home, "mcp.json"),
    relativePath: "mcp.json",
  };
}

/**
 * Parse already-read MCP bytes without reopening their source paths.
 *
 * The caller owns descriptor confinement and byte limits. Keeping this parser
 * separate lets a trusted-project declarative scan hand the exact validated
 * rows to both runtimes while the visible Ghost MCP catalog retains its own
 * independently mutable source.
 */
function parseProjectMcpInputs(
  inputs: readonly EffectiveProjectMcpInput[],
): ParsedProjectMcpInputs {
  const claimed = new Set<string>();
  const claimedNames: string[] = [];
  const configured: EffectiveProjectMcpServer[] = [];
  const servers: EffectiveProjectMcpServer[] = [];
  const skipped: McpCatalogSkipped[] = [];

  for (const input of inputs) {
    if (input.error !== undefined) {
      skipped.push({ path: input.source.relativePath, reason: input.error });
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(input.content ?? "") as MCPConfigFile;
    } catch {
      skipped.push({
        path: input.source.relativePath,
        reason: "MCP config could not be read or parsed.",
      });
      continue;
    }
    if (!isRecord(document)) {
      skipped.push({ path: input.source.relativePath, reason: "MCP config must be a JSON object" });
      continue;
    }
    const rawServers = document.mcpServers;
    if (rawServers === undefined) continue;
    if (!isRecord(rawServers)) {
      skipped.push({ path: input.source.relativePath, reason: '"mcpServers" must be a JSON object' });
      continue;
    }
    for (const [name, config] of Object.entries(rawServers)) {
      if (claimed.has(name)) continue;
      claimed.add(name);
      claimedNames.push(name);
      const server = {
        name,
        source: input.source,
        config,
        errors: validationErrors(name, config),
      };
      configured.push(server);
      if (server.errors.length > 0) {
        skipped.push({
          path: `${input.source.relativePath}#mcpServers.${name}`,
          reason: server.errors.join("; "),
        });
        continue;
      }
      if ((config as MCPServerConfig).enabled === false) continue;
      servers.push(server);
    }
  }

  return {
    effective: { claimedNames, servers, skipped },
    configured,
  };
}

export function parseEffectiveProjectMcpInputs(
  inputs: readonly EffectiveProjectMcpInput[],
): EffectiveProjectMcpRead {
  return parseProjectMcpInputs(inputs).effective;
}

async function readMcpConfigAtMost(
  file: Awaited<ReturnType<typeof openRegularFileNoFollow>>,
  maxBytes = 1_048_576,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let bytes = 0;
  while (bytes < buffer.byteLength) {
    const result = await file.read(buffer, bytes, buffer.byteLength - bytes, bytes);
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
  }
  if (bytes > maxBytes) throw new Error("MCP config exceeds the 1 MiB limit");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } catch {
    throw new Error("MCP config is not valid UTF-8");
  }
}

/**
 * Resolve the visible ghost source. Trusted-project MCP bytes are admitted by
 * the project declarative scan and enter through parseEffectiveProjectMcpInputs.
 */
async function readProjectMcp(home: string): Promise<ParsedProjectMcpInputs> {
  const inputs: EffectiveProjectMcpInput[] = [];
  const source = ghostMcpSource(home);
  let root: Awaited<ReturnType<typeof openDirectoryNoFollow>> | undefined;
  let file: Awaited<ReturnType<typeof openRegularFileNoFollow>> | undefined;
  try {
    root = await openDirectoryNoFollow(home, "MCP root");
    file = await openRegularFileNoFollow(descriptorPath(root, "mcp.json"), "MCP config");
    inputs.push({ source, content: await readMcpConfigAtMost(file) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const reason = error instanceof Error && (
        error.message === "MCP config exceeds the 1 MiB limit"
        || error.message === "MCP config is not valid UTF-8"
      )
        ? error.message
        : "MCP config could not be read or parsed.";
      inputs.push({ source, error: reason });
    }
  } finally {
    await file?.close().catch(() => {});
    await root?.close().catch(() => {});
  }

  return parseProjectMcpInputs(inputs);
}

export async function readEffectiveProjectMcp(home: string): Promise<EffectiveProjectMcpRead> {
  return (await readProjectMcp(home)).effective;
}

function translateWriterError(error: unknown, name: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("already exists")) {
    throw new GhostError("mcp_server_exists", `MCP server ${JSON.stringify(name)} already exists.`, 409);
  }
  if (message.includes("not found")) {
    throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
  }
  if (message.includes("Invalid server config") || message.includes("Server name")) {
    throw new GhostError("invalid_mcp_server", message, 400);
  }
  throw error;
}

/**
 * CRUD and sanitized discovery for the MCP files owned by one ghost.
 *
 * No method calls OMP capability discovery or `getMCPConfigPath("user")`.
 * That negative guarantee is the sovereignty boundary of this class.
 */
export class McpCatalog {
  private readonly registry: GhostRegistry;
  private readonly homeOperations: HomeOperationCoordinator;
  private readonly writer: McpCatalogWriter;

  constructor(options: McpCatalogOptions) {
    this.registry = options.registry;
    this.homeOperations = options.homeOperations ?? homeOperationsFor(options.registry);
    this.writer = { ...defaultWriter, ...options.writer };
  }

  private withHomeLease<T>(ghostName: string, operation: () => Promise<T>): Promise<T> {
    return this.homeOperations.withLease(ghostName, operation);
  }

  private sources(
    ghostName: string,
  ): [ProjectMcpConfigSource] {
    return [ghostMcpSource(this.registry.get(ghostName).dir)];
  }

  private effective(ghostName: string): Promise<ParsedProjectMcpInputs> {
    return readProjectMcp(this.registry.get(ghostName).dir);
  }

  async list(ghostName: string): Promise<McpCatalogSnapshot> {
    const { effective, configured } = await this.effective(ghostName);
    const servers: McpServerView[] = [];
    const skipped = [...effective.skipped];
    for (const server of configured) {
      if (server.errors.length > 0) continue;
      const config = server.config as MCPServerConfig;
      servers.push({
        name: server.name,
        enabled: config.enabled !== false,
        source: server.source.kind,
        path: server.source.relativePath,
        config: sanitizeMcpServerConfig(config),
      });
    }
    servers.sort((left, right) => left.name.localeCompare(right.name));
    skipped.sort((left, right) => left.path.localeCompare(right.path));
    return { servers, skipped };
  }

  /** Add a new server to the visible ghost file. */
  async add(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    return this.withHomeLease(ghostName, async () => {
      const { effective } = await this.effective(ghostName);
      if (effective.claimedNames.includes(name)) {
        throw new GhostError("mcp_server_exists", `MCP server ${JSON.stringify(name)} already exists.`, 409);
      }
      const [canonical] = this.sources(ghostName);
      try {
        await this.writer.add(canonical.absolutePath, name, config);
      } catch (error) {
        translateWriterError(error, name);
      }
      return this.list(ghostName);
    });
  }

  /** Replace an effective server in the native file that currently owns it. */
  async update(ghostName: string, name: string, config: unknown): Promise<McpCatalogSnapshot> {
    validateMutation(name, config);
    return this.withHomeLease(ghostName, async () => {
      const server = (await this.effective(ghostName)).configured
        .find((candidate) => candidate.name === name);
      if (!server) {
        throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
      }
      try {
        await this.writer.update(server.source.absolutePath, name, config);
      } catch (error) {
        translateWriterError(error, name);
      }
      return this.list(ghostName);
    });
  }

  /** Toggle an effective, valid server without moving it between native files. */
  async setEnabled(ghostName: string, name: string, enabled: boolean): Promise<McpCatalogSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new GhostError("invalid_request", '"enabled" must be a boolean.', 400);
    }
    return this.withHomeLease(ghostName, async () => {
      const server = (await this.effective(ghostName)).configured
        .find((candidate) => candidate.name === name);
      if (!server) {
        throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
      }
      validateMutation(name, server.config);
      try {
        await this.writer.update(
          server.source.absolutePath,
          name,
          { ...(server.config as MCPServerConfig), enabled },
        );
      } catch (error) {
        translateWriterError(error, name);
      }
      return this.list(ghostName);
    });
  }

  /** Remove only the JSON member; OMP deliberately leaves the config file. */
  async remove(ghostName: string, name: string): Promise<McpCatalogSnapshot> {
    return this.withHomeLease(ghostName, async () => {
      const server = (await this.effective(ghostName)).configured
        .find((candidate) => candidate.name === name);
      if (!server) {
        throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
      }
      try {
        await this.writer.remove(server.source.absolutePath, name);
      } catch (error) {
        translateWriterError(error, name);
      }
      return this.list(ghostName);
    });
  }

  /**
   * Probe one ghost-owned server in an isolated manager. GET never calls
   * this; it is an explicit POST action and never opens an AgentSession.
   */
  async test(ghostName: string, name: string): Promise<McpConnectionTest> {
    return this.withHomeLease(ghostName, async () => {
      const server = (await this.effective(ghostName)).configured
        .find((candidate) => candidate.name === name);
      if (!server) {
        throw new GhostError("mcp_server_not_found", `No MCP server named ${JSON.stringify(name)}.`, 404);
      }
      validateMutation(name, server.config);
      const home = this.registry.get(ghostName).dir;
      const manager = new MCPManager(home, null, { redactErrors: true });
      const source: SourceMeta = {
        provider: "native",
        providerName: "OMP",
        path: server.source.absolutePath,
        level: "user",
      };
      try {
        const expanded = expandMcpServerConfig(server.config as MCPServerConfig);
        const result = await manager.connectServers(
          { [name]: normalizeMcpStdioCwd(expanded, home) },
          { [name]: source },
        );
        const connected = result.connectedServers.includes(name)
          || manager.getConnectionStatus(name) === "connected";
        return {
          name,
          ok: connected,
          status: connected ? "connected" : "failed",
          toolCount: manager.getTools().filter((tool) => tool.mcpServerName === name).length,
          message: connected ? "Connection succeeded." : "Connection failed; check the server configuration.",
        };
      } catch {
        return {
          name,
          ok: false,
          status: "failed",
          toolCount: 0,
          message: "Connection failed; check the server configuration.",
        };
      } finally {
        await manager.disconnectAll().catch(() => {});
      }
    });
  }
}
