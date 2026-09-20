/**
 * The working directory of each tool call, stored where pi already stores
 * per-session extension state. The shell needs them to render a tool trace
 * after a restart. They used to be Ghost-owned control files beside the
 * transcript, each with its own versioning, validation and atomic replace.
 *
 * pi's session file already has a slot for exactly this: `appendCustomEntry`
 * persists extension state across reloads, and a plain custom entry is ignored
 * by `buildSessionContext`, so none of it reaches the model or costs a token.
 * Keeping the state there means a fork copies it by copying the transcript,
 * and a conversation is one file again.
 *
 * Retired `ghost.conversation-cwd` entries from before the owner-home pin
 * are skipped where they appear; per-tool cwds are display-only.
 */
import { isAbsolute, resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** One tool call's working directory. The newest entry for an id wins. */
export const TOOL_CWD_ENTRY = "ghost.tool-cwd";

function usableCwd(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && isAbsolute(value) && !value.includes("\0")
    ? resolve(value)
    : undefined;
}

/** Only the entry list is needed, so a read-only manager satisfies this too. */
type EntryReader = Pick<SessionManager, "getEntries">;

/**
 * Rebuild the per-tool cwds from a session's entries. A malformed entry is
 * skipped rather than thrown: a cwd is a display detail, and refusing to open
 * a conversation over one bad record would lose the conversation with it.
 */
export function readSessionCwds(manager: EntryReader): Map<string, string> {
  const toolCwds = new Map<string, string>();
  for (const entry of manager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== TOOL_CWD_ENTRY) continue;
    const data = (entry as { data?: unknown }).data as Record<string, unknown> | undefined;
    if (!data) continue;
    const toolCallId = data.toolCallId;
    const toolCwd = usableCwd(data.cwd);
    if (typeof toolCallId !== "string" || toolCallId === "" || toolCwd === undefined) continue;
    // Re-insert so the map keeps first-seen order for a re-recorded call.
    toolCwds.delete(toolCallId);
    toolCwds.set(toolCallId, toolCwd);
  }
  return toolCwds;
}

export function recordToolCwd(manager: SessionManager, toolCallId: string, cwd: string): void {
  manager.appendCustomEntry(TOOL_CWD_ENTRY, { toolCallId, cwd: resolve(cwd) });
}
