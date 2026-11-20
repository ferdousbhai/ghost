import { readFileSync } from "node:fs";
import type { Ghost } from "../ghosts.js";
import type { SessionSummary } from "../session-host.js";
import { ArgsError, flagString } from "./args.js";
import { notFound, type DaemonClient } from "./client.js";
import type { CliContext, CliStdin } from "./types.js";
import { errorMessage } from "../errors.js";

export async function stdinText(stdin: CliStdin): Promise<string> {
  if (typeof stdin === "string") return stdin;
  return (await Array.fromAsync(stdin, String)).join("");
}

/** A file named on the command line, read before ghostd is asked: one that cannot be read is a usage error. */
export function readArgumentFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new ArgsError(errorMessage(error));
  }
}

export function readArgumentJson(path: string): unknown {
  const text = readArgumentFile(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new ArgsError(`${path} is not valid JSON`);
  }
}

export function stdinIsTty(stdin: CliStdin): boolean {
  return typeof stdin !== "string" && stdin.isTTY === true;
}

export function listGhosts(client: DaemonClient): Promise<Ghost[]> {
  return client.request<Ghost[]>("GET", "/api/ghosts");
}

/**
 * The ghost a verb addresses: `$GHOST`, which a ghost's own shell carries,
 * else the machine's one ghost, the first home ghostd lists.
 */
export async function resolveGhost(ctx: Pick<CliContext, "client" | "runtime">): Promise<string> {
  const named = ctx.runtime.env.GHOST?.trim();
  if (named) return named;
  const [ghost] = await listGhosts(ctx.client);
  if (!ghost) throw notFound("a ghost home (ghostd makes one when it starts; restart ghostd.service)");
  return ghost.name;
}

export async function listSessions(client: DaemonClient, ghost: string): Promise<SessionSummary[]> {
  return (await client.request<{ sessions: SessionSummary[] }>("GET", ghostPath(ghost, "/sessions"))).sessions;
}

export function resolveSessionPrefix(rows: readonly SessionSummary[], requested: string): SessionSummary {
  const exact = rows.filter((row) => row.id === requested);
  if (exact.length === 1) return exact[0] as SessionSummary;
  const matches = rows.filter((row) => row.id.startsWith(requested));
  if (matches.length === 1) return matches[0] as SessionSummary;
  if (matches.length === 0) throw notFound(`session ${JSON.stringify(requested)}`);
  throw new ArgsError(
    `Session prefix ${JSON.stringify(requested)} is ambiguous: ${matches.map((row) => row.id).join(", ")}`,
  );
}

/**
 * `requested` as an id or unique prefix of a listed conversation, else as
 * given: one no message has landed in yet is not listed, and a turn or switch
 * may still address it.
 */
export async function conversationId(client: DaemonClient, name: string, requested: string): Promise<string> {
  const sessions = await listSessions(client, name);
  return sessions.some((row) => row.id.startsWith(requested)) ? resolveSessionPrefix(sessions, requested).id : requested;
}

export function latestSession(rows: readonly SessionSummary[]): SessionSummary | undefined {
  return rows.reduce<SessionSummary | undefined>((latest, row) =>
    !latest || Date.parse(row.updatedAt) > Date.parse(latest.updatedAt) ? row : latest, undefined);
}

/** `-s`, then `$GHOST_SESSION` (set in a ghost's own shell); undefined when neither names one. */
export function preferredSessionId(ctx: Pick<CliContext, "runtime" | "parsed">): string | undefined {
  return flagString(ctx.parsed, "session")?.trim() || ctx.runtime.env.GHOST_SESSION?.trim() || undefined;
}

export async function resolveTarget(
  ctx: Pick<CliContext, "client" | "runtime" | "parsed">,
): Promise<{ name: string; session: SessionSummary; path: string }> {
  const name = await resolveGhost(ctx);
  const session = await resolveSession(ctx.client, name, preferredSessionId(ctx));
  return { name, session, path: sessionPath(name, session.id) };
}

/** `requested` (an id or unique prefix) among the ghost's sessions, else its latest. */
export async function resolveSession(client: DaemonClient, name: string, requested: string | undefined): Promise<SessionSummary> {
  const sessions = await listSessions(client, name);
  const session = requested ? resolveSessionPrefix(sessions, requested) : latestSession(sessions);
  if (!session) throw notFound(`a session for ghost ${JSON.stringify(name)}`);
  return session;
}

export function ghostPath(ghost: string, suffix: string): string {
  return `/api/ghosts/${encodeURIComponent(ghost)}${suffix}`;
}

export function sessionPath(ghost: string, publicId: string, suffix = ""): string {
  return ghostPath(ghost, `/sessions/${encodeURIComponent(publicId)}${suffix}`);
}
