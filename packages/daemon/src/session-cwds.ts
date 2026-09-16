/**
 * Working directories a conversation remembers, stored where pi already stores
 * per-session extension state.
 *
 * Two of these exist: the conversation's own cwd, moved by `!cd`, and one cwd
 * per tool call, which the shell needs to render a tool trace after a restart.
 * Both used to be Ghost-owned control files beside the transcript, each with
 * its own versioning, validation and atomic replace — and because a fork had to
 * publish all three files or none, they are what the fork/delete two-phase
 * commit existed to keep consistent.
 *
 * pi's session file already has a slot for exactly this: `appendCustomEntry`
 * persists extension state across reloads, and a plain custom entry is ignored
 * by `buildSessionContext`, so none of it reaches the model or costs a token.
 * Keeping the state there means a fork copies it by copying the transcript, and
 * a conversation is one file again.
 */
import { isAbsolute, resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { readDaemonControlFile } from "./control-file.js";

/** The conversation's own working directory. The newest entry wins. */
export const CONVERSATION_CWD_ENTRY = "ghost.conversation-cwd";
/** One tool call's working directory. The newest entry for an id wins. */
export const TOOL_CWD_ENTRY = "ghost.tool-cwd";
/** Shared prefix of both, so a raw scan can skip a line without parsing it. */
const CWD_ENTRY_MARKER = "ghost.";

export interface SessionCwds {
  /** Undefined when the conversation never moved. */
  readonly cwd: string | undefined;
  readonly toolCwds: Map<string, string>;
}

function usableCwd(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && isAbsolute(value) && !value.includes("\0")
    ? resolve(value)
    : undefined;
}

/**
 * Rebuild both from a session's entries. A malformed entry is skipped rather
 * than thrown: a cwd is a display and rehydration detail, and refusing to open
 * a conversation over one bad record would lose the conversation with it.
 */
/** Only the entry list is needed, so a read-only manager satisfies this too. */
type EntryReader = Pick<SessionManager, "getEntries">;

export function readSessionCwds(manager: EntryReader): SessionCwds {
  let cwd: string | undefined;
  const toolCwds = new Map<string, string>();
  for (const entry of manager.getEntries()) {
    if (entry.type !== "custom") continue;
    const data = (entry as { data?: unknown }).data as Record<string, unknown> | undefined;
    if (!data) continue;
    if (entry.customType === CONVERSATION_CWD_ENTRY) {
      cwd = usableCwd(data.cwd) ?? cwd;
      continue;
    }
    if (entry.customType !== TOOL_CWD_ENTRY) continue;
    const toolCallId = data.toolCallId;
    const toolCwd = usableCwd(data.cwd);
    if (typeof toolCallId !== "string" || toolCallId === "" || toolCwd === undefined) continue;
    // Re-insert so the map keeps first-seen order for a re-recorded call.
    toolCwds.delete(toolCallId);
    toolCwds.set(toolCallId, toolCwd);
  }
  return { cwd, toolCwds };
}

/**
 * The same rebuild, straight off the transcript, for the callers that need a
 * cwd before there is a session to ask — `open` needs one to construct the
 * runtime that would own the manager. pi reads the whole file on open too, so
 * a scan here costs no more than the open it precedes.
 *
 * It goes through the control-file reader rather than `readFile`, because this
 * path runs before anything has validated the transcript: a symlink, a fifo,
 * or an oversized file must be refused, not followed or blocked on.
 */
export async function readSessionCwdsFromFile(
  path: string,
  maxBytes: number,
): Promise<SessionCwds> {
  let raw: string;
  try {
    raw = await readDaemonControlFile(path, maxBytes);
  } catch {
    // An unreadable or hostile transcript yields no cwds; the caller falls back
    // to the session header and then the ghost's default.
    return { cwd: undefined, toolCwds: new Map() };
  }
  let cwd: string | undefined;
  const toolCwds = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line === "" || !line.includes(CWD_ENTRY_MARKER)) continue;
    let entry: { type?: unknown; customType?: unknown; data?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "custom" || !entry.data) continue;
    if (entry.customType === CONVERSATION_CWD_ENTRY) {
      cwd = usableCwd(entry.data.cwd) ?? cwd;
      continue;
    }
    if (entry.customType !== TOOL_CWD_ENTRY) continue;
    const toolCallId = entry.data.toolCallId;
    const toolCwd = usableCwd(entry.data.cwd);
    if (typeof toolCallId !== "string" || toolCallId === "" || toolCwd === undefined) continue;
    toolCwds.delete(toolCallId);
    toolCwds.set(toolCallId, toolCwd);
  }
  return { cwd, toolCwds };
}

export function recordConversationCwd(manager: SessionManager, cwd: string): void {
  manager.appendCustomEntry(CONVERSATION_CWD_ENTRY, { cwd: resolve(cwd) });
}

export function recordToolCwd(manager: SessionManager, toolCallId: string, cwd: string): void {
  manager.appendCustomEntry(TOOL_CWD_ENTRY, { toolCallId, cwd: resolve(cwd) });
}
