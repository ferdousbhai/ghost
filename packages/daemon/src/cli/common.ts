import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Ghost } from "../ghosts.js";
import type { SessionSummary } from "../session-host.js";
import { ArgsError, flagString, type ParsedCliArgs } from "./args.js";
import { CliError, EXIT_CODE, notFound, type DaemonClient } from "./client.js";
import type { CliContext, CliRuntime, CliStdin } from "./types.js";

export async function stdinText(stdin: CliStdin): Promise<string> {
  if (typeof stdin === "string") return stdin;
  return (await Array.fromAsync(stdin, String)).join("");
}

export function stdinIsTty(stdin: CliStdin): boolean {
  return typeof stdin !== "string" && stdin.isTTY === true;
}

interface CliConfigFile {
  ghost?: unknown;
}

export function cliConfigPath(runtime: Pick<CliRuntime, "env" | "home">): string {
  const configured = runtime.env.XDG_CONFIG_HOME?.trim();
  const base = configured && isAbsolute(configured) ? configured : join(runtime.home, ".config");
  return join(base, "ghost", "cli.json");
}

export function readDefaultGhost(runtime: Pick<CliRuntime, "env" | "home">): string | undefined {
  const path = cliConfigPath(runtime);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CliConfigFile;
    return typeof parsed.ghost === "string" && parsed.ghost.trim() ? parsed.ghost : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new CliError(EXIT_CODE.usage, `${path} is not valid JSON`);
    throw new CliError(EXIT_CODE.failure, `cannot read ${path}: ${(error as Error).message}`);
  }
}

export function writeDefaultGhost(runtime: Pick<CliRuntime, "env" | "home">, ghost: string): string {
  const path = cliConfigPath(runtime);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ghost }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return path;
}

export async function listGhosts(client: DaemonClient): Promise<Ghost[]> {
  return (await client.request<Ghost[]>("GET", "/api/ghosts")).body;
}

/**
 * The ghost the owner named, without asking anyone which ghosts exist: `-g`,
 * then `$GHOST`, then the private `ghost use` default. This half of the
 * addressing order is identical for daemon-backed and daemon-free verbs.
 */
export function preferredGhostName(
  runtime: Pick<CliRuntime, "env" | "home">,
  requested?: string,
): string | undefined {
  return requested?.trim() || runtime.env.GHOST?.trim() || readDefaultGhost(runtime);
}

/** The tail of the addressing order: the sole ghost, or make the owner choose. */
export function soleGhostName(names: readonly string[]): string {
  const only = names[0];
  if (names.length === 1 && only) return only;
  if (names.length === 0) throw new ArgsError("No ghosts exist. Create one with `ghost new <name>`.");
  throw new ArgsError(`Choose a ghost with -g/--ghost. Available: ${names.join(", ")}`);
}

export async function resolveGhost(
  client: DaemonClient,
  runtime: CliRuntime,
  requested?: string,
): Promise<{ name: string }> {
  const name = preferredGhostName(runtime, requested);
  if (name) return { name };
  const ghosts = await listGhosts(client);
  return { name: soleGhostName(ghosts.map((ghost) => ghost.name)) };
}

export async function listSessions(client: DaemonClient, ghost: string): Promise<SessionSummary[]> {
  const response = await client.request<{ sessions: SessionSummary[] }>(
    "GET",
    `/api/ghosts/${encodeURIComponent(ghost)}/sessions`,
  );
  return response.body.sessions;
}

export function resolveSessionPrefix(rows: readonly SessionSummary[], requested: string): SessionSummary {
  const exact = rows.filter((row) => row.id === requested || row.conversationId === requested);
  if (exact.length === 1) return exact[0] as SessionSummary;
  const matches = rows.filter((row) => row.id.startsWith(requested) || row.conversationId.startsWith(requested));
  if (matches.length === 1) return matches[0] as SessionSummary;
  if (matches.length === 0) throw notFound(`session ${JSON.stringify(requested)}`);
  throw new ArgsError(
    `Session prefix ${JSON.stringify(requested)} is ambiguous: ${matches.map((row) => row.id).join(", ")}`,
  );
}

export function latestSession(rows: readonly SessionSummary[]): SessionSummary | undefined {
  return rows.reduce<SessionSummary | undefined>((latest, row) =>
    !latest || Date.parse(row.updatedAt) > Date.parse(latest.updatedAt) ? row : latest, undefined);
}

export async function resolveSession(
  client: DaemonClient,
  ghost: string,
  requested?: string,
): Promise<{ session: SessionSummary; sessions: SessionSummary[] }> {
  const sessions = await listSessions(client, ghost);
  if (requested) return { session: resolveSessionPrefix(sessions, requested), sessions };
  const session = latestSession(sessions);
  if (!session) throw notFound(`a session for ghost ${JSON.stringify(ghost)}`);
  return { session, sessions };
}

export async function resolveTarget(
  client: DaemonClient,
  ctx: Pick<CliContext, "runtime">,
  parsed: ParsedCliArgs,
): Promise<{ name: string; session: SessionSummary; path: string }> {
  const { name } = await resolveGhost(client, ctx.runtime, flagString(parsed, "ghost"));
  const { session } = await resolveSession(client, name, flagString(parsed, "session"));
  return { name, session, path: sessionPath(name, session.id) };
}

export function sessionPath(ghost: string, publicId: string, suffix = ""): string {
  return `/api/ghosts/${encodeURIComponent(ghost)}/sessions/${encodeURIComponent(publicId)}${suffix}`;
}
