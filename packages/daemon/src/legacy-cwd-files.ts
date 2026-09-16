/**
 * The cwd sidecars Ghost wrote before the state moved into pi's session file
 * (see [`session-cwds.ts`](session-cwds.ts)). Read-only, and deliberately so:
 * nothing writes these any more.
 *
 * They survive for two reasons, both temporary. A home written by an older
 * build still has them, and `open` migrates one when it finds it; and a fork
 * interrupted by an older build left a v3 marker naming two staged sidecars,
 * which recovery still has to finish or roll back. Delete this module, and the
 * v3 arm of `recoverForkTransactionsOnce`, once no home in the wild predates
 * the move.
 */
import { isAbsolute, join, resolve } from "node:path";
import { readDaemonControlFile } from "./control-file.js";
import { sessionFileNameFor } from "./session-files.js";

const CONVERSATION_CWD_MAX_BYTES = 16 * 1024;
export const TOOL_CWDS_MAX_BYTES = 16 * 1_048_576;

function stem(sessionDir: string, conversationId: string, suffix: string): string {
  const base = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
  return join(sessionDir, `${base}${suffix}`);
}

export function conversationCwdPath(sessionDir: string, conversationId: string): string {
  return stem(sessionDir, conversationId, ".pi.cwd.json");
}

export function toolCwdsPath(sessionDir: string, conversationId: string): string {
  return stem(sessionDir, conversationId, ".pi.tool-cwds.json");
}

function usableCwd(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && isAbsolute(value) && !value.includes("\0")
    ? resolve(value)
    : undefined;
}

/**
 * A migration reads these, so a malformed one yields nothing rather than
 * throwing: a bad sidecar must not keep its conversation from opening.
 */
export async function readLegacyConversationCwd(
  sessionDir: string,
  conversationId: string,
): Promise<string | undefined> {
  try {
    const raw = await readDaemonControlFile(
      conversationCwdPath(sessionDir, conversationId),
      CONVERSATION_CWD_MAX_BYTES,
    );
    const parsed = JSON.parse(raw) as { version?: unknown; cwd?: unknown };
    return parsed.version === 1 ? usableCwd(parsed.cwd) : undefined;
  } catch {
    return undefined;
  }
}

export async function readLegacyToolCwds(
  sessionDir: string,
  conversationId: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let parsed: { version?: unknown; cwds?: unknown };
  try {
    parsed = JSON.parse(await readDaemonControlFile(
      toolCwdsPath(sessionDir, conversationId),
      TOOL_CWDS_MAX_BYTES,
    )) as typeof parsed;
  } catch {
    return result;
  }
  // v2 stored pairs; v1 stored an object keyed by tool call id.
  const entries: Array<[unknown, unknown]> = Array.isArray(parsed.cwds)
    ? parsed.cwds.filter((entry): entry is [unknown, unknown] => Array.isArray(entry) && entry.length === 2)
    : parsed.cwds && typeof parsed.cwds === "object"
      ? Object.entries(parsed.cwds as Record<string, unknown>)
      : [];
  for (const [toolCallId, cwd] of entries) {
    const usable = usableCwd(cwd);
    if (typeof toolCallId !== "string" || toolCallId === "" || usable === undefined) continue;
    result.delete(toolCallId);
    result.set(toolCallId, usable);
  }
  return result;
}
