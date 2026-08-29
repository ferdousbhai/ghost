import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ArgsError } from "./args.js";
import { CliError, type DaemonClient } from "./client.js";
import type { CliRuntime } from "./types.js";

export interface GhostRow {
  name: string;
  dir: string;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  conversationId: string;
  runtime: "pi" | "claude-code";
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned: boolean;
  unread: boolean;
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
    if (error instanceof SyntaxError) throw new CliError(2, `${path} is not valid JSON`);
    throw new CliError(1, `cannot read ${path}: ${(error as Error).message}`);
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

export async function listGhosts(client: DaemonClient): Promise<GhostRow[]> {
  return (await client.request<GhostRow[]>("GET", "/api/ghosts")).body;
}

export async function resolveGhost(
  client: DaemonClient,
  runtime: CliRuntime,
  requested?: string,
): Promise<{ name: string; ghosts: GhostRow[] }> {
  const ghosts = await listGhosts(client);
  const name = requested?.trim()
    || runtime.env.GHOST?.trim()
    || readDefaultGhost(runtime)
    || (ghosts.length === 1 ? ghosts[0]?.name : undefined);
  if (name && ghosts.some((ghost) => ghost.name === name)) return { name, ghosts };
  if (name) throw new CliError(5, `ghost ${JSON.stringify(name)} was not found`);
  if (ghosts.length === 0) throw new ArgsError("No ghosts exist. Create one with `ghost new <name>`.");
  const names = ghosts.map((ghost) => ghost.name).join(", ");
  throw new ArgsError(`Choose a ghost with -g/--ghost. Available: ${names}`);
}

export async function listSessions(client: DaemonClient, ghost: string): Promise<SessionRow[]> {
  const response = await client.request<{ sessions: SessionRow[] }>(
    "GET",
    `/api/ghosts/${encodeURIComponent(ghost)}/sessions`,
  );
  return response.body.sessions;
}

export function resolveSessionPrefix(rows: readonly SessionRow[], requested: string): SessionRow {
  const exact = rows.filter((row) => row.id === requested || row.conversationId === requested);
  if (exact.length === 1) return exact[0] as SessionRow;
  const matches = rows.filter((row) => row.id.startsWith(requested) || row.conversationId.startsWith(requested));
  if (matches.length === 1) return matches[0] as SessionRow;
  if (matches.length === 0) throw new CliError(5, `session ${JSON.stringify(requested)} was not found`);
  throw new ArgsError(
    `Session prefix ${JSON.stringify(requested)} is ambiguous: ${matches.map((row) => row.id).join(", ")}`,
  );
}

export function latestSession(rows: readonly SessionRow[]): SessionRow | undefined {
  return rows.reduce<SessionRow | undefined>((latest, row) =>
    !latest || Date.parse(row.updatedAt) > Date.parse(latest.updatedAt) ? row : latest, undefined);
}

export async function resolveSession(
  client: DaemonClient,
  ghost: string,
  requested?: string,
): Promise<{ session: SessionRow; sessions: SessionRow[] }> {
  const sessions = await listSessions(client, ghost);
  if (requested) return { session: resolveSessionPrefix(sessions, requested), sessions };
  const session = latestSession(sessions);
  if (!session) throw new CliError(5, `ghost ${JSON.stringify(ghost)} has no sessions`);
  return { session, sessions };
}

export function sessionPath(ghost: string, publicId: string, suffix = ""): string {
  return `/api/ghosts/${encodeURIComponent(ghost)}/sessions/${encodeURIComponent(publicId)}${suffix}`;
}
