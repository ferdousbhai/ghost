import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { readPrivateFileText, writePrivateJsonAtomic } from "../private-file.js";
import { dirname, join } from "node:path";
import type { Ghost } from "../ghosts.js";
import type { SessionSummary } from "../session-host.js";
import { ArgsError, flagString } from "./args.js";
import { CliError, EXIT_CODE, notFound, type DaemonClient } from "./client.js";
import type { CliContext, CliRuntime, CliStdin } from "./types.js";
import { errorMessage } from "../errors.js";
import { xdgBaseDir } from "../xdg-user-dirs.js";

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

interface CliConfigFile {
  ghost?: unknown;
}

export function cliConfigPath(runtime: Pick<CliRuntime, "env" | "home">): string {
  return join(xdgBaseDir(runtime.env, "XDG_CONFIG_HOME", runtime.home), "ghost", "cli.json");
}

export function readDefaultGhost(runtime: Pick<CliRuntime, "env" | "home">): string | undefined {
  const path = cliConfigPath(runtime);
  try {
    const text = readPrivateFileText(path);
    if (text === null) return undefined;
    const parsed = JSON.parse(text) as CliConfigFile;
    return typeof parsed.ghost === "string" && parsed.ghost.trim() ? parsed.ghost : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CliError(EXIT_CODE.usage, `${path} is not valid JSON`);
    throw new CliError(EXIT_CODE.failure, `cannot read ${path}: ${errorMessage(error)}`);
  }
}

export async function writeDefaultGhost(runtime: Pick<CliRuntime, "env" | "home">, ghost: string): Promise<string> {
  const path = cliConfigPath(runtime);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  await writePrivateJsonAtomic(path, { ghost });
  return path;
}

/** Forget the `ghost use` default; addressing falls through to the sole ghost. */
export function clearDefaultGhost(runtime: Pick<CliRuntime, "env" | "home">): string {
  const path = cliConfigPath(runtime);
  rmSync(path, { force: true });
  return path;
}

/**
 * Keep the `ghost use` default true after the ghost it names is renamed
 * (`next`) or trashed (null). A default naming another ghost, or a file that
 * cannot be read, is left alone: the change itself already happened.
 */
export async function followDefaultGhost(runtime: Pick<CliRuntime, "env" | "home">, previous: string, next: string | null): Promise<void> {
  let stored: string | undefined;
  try { stored = readDefaultGhost(runtime); } catch { return; }
  if (stored !== previous) return;
  if (next) await writeDefaultGhost(runtime, next);
  else clearDefaultGhost(runtime);
}

export function listGhosts(client: DaemonClient): Promise<Ghost[]> {
  return client.request<Ghost[]>("GET", "/api/ghosts");
}

/**
 * The ghost the owner named, without asking anyone which ghosts exist: `-g`,
 * then `$GHOST` (which a ghost's own shell carries), then the private
 * `ghost use` default. This half of the addressing order is identical for
 * daemon-backed and daemon-free verbs.
 */
export function preferredGhostName(
  runtime: Pick<CliRuntime, "env" | "home">,
  requested?: string,
): string | undefined {
  return requested?.trim() || runtime.env.GHOST?.trim() || readDefaultGhost(runtime);
}

/** The tail of the addressing order: the sole ghost, or make the owner choose. */
function soleGhostName(names: readonly string[]): string {
  const only = names[0];
  if (names.length === 1 && only) return only;
  if (names.length === 0) throw new ArgsError("No ghosts exist. Create one with `ghost new <name>`.");
  throw new ArgsError(`Choose a ghost with -g/--ghost. Available: ${names.join(", ")}`);
}

export async function resolveGhost(ctx: Pick<CliContext, "client" | "runtime" | "parsed">): Promise<string> {
  const name = preferredGhostName(ctx.runtime, flagString(ctx.parsed, "ghost"));
  if (name) return name;
  const ghosts = await listGhosts(ctx.client);
  return soleGhostName(ghosts.map((ghost) => ghost.name));
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
