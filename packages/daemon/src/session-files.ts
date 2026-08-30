import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  isValidConversationId,
  MAX_CONVERSATION_ID_SCALARS,
  requireRawConversationId,
} from "./conversation-identity.js";
import { GhostError } from "./ghosts.js";
import { visitLeadingEntries } from "./session-transcript.js";

const HASHED_SESSION_PREFIX = "ghost~";
const HASHED_SESSION_PATTERN = /^ghost~[0-9a-f]{64}\.jsonl$/u;
const CONVERSATION_ID_ENTRY = "ghost_conversation_identity";
const CLAUDE_SESSION_PREFIX = "claude-";
const CLAUDE_SESSION_SUFFIX = ".json";
/** How many leading entries may separate the header from the identity marker. */
const IDENTITY_SCAN_LIMIT = 64;

function conversationIdFitsFileName(conversationId: string): boolean {
  return conversationId.length > 0
    && conversationId.length <= MAX_CONVERSATION_ID_SCALARS
    && /^[A-Za-z0-9._-]+$/u.test(conversationId);
}

export function sessionFileNameFor(conversationId: string): string {
  requireRawConversationId(conversationId);
  if (conversationIdFitsFileName(conversationId)) return `${conversationId}.jsonl`;
  const digest = createHash("sha256").update(JSON.stringify(conversationId)).digest("hex");
  // `~` is outside the direct-filename alphabet above. Therefore the generated
  // stem can never itself be treated as an alias for this transcript.
  return `${HASHED_SESSION_PREFIX}${digest}.jsonl`;
}

export function claudeSessionMetadataPath(
  sessionDir: string,
  conversationId: string,
): string {
  requireRawConversationId(conversationId);
  const digest = createHash("sha256").update(conversationId).digest("hex");
  return join(sessionDir, `${CLAUDE_SESSION_PREFIX}${digest}${CLAUDE_SESSION_SUFFIX}`);
}

export function bindConversationId(
  manager: SessionManager,
  conversationId: string,
): void {
  requireRawConversationId(conversationId);
  if (conversationIdFitsFileName(conversationId)) return;
  manager.appendCustomEntry(CONVERSATION_ID_ENTRY, {
    version: 1,
    conversationId,
  });
}

function conversationIdFromCustomEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
  };
  if (record.type !== "custom" || !record.data || typeof record.data !== "object") {
    return null;
  }
  const data = record.data as {
    version?: unknown;
    conversationId?: unknown;
  };
  if (record.customType === CONVERSATION_ID_ENTRY
    && data.version === 1
    && typeof data.conversationId === "string"
    && isValidConversationId(data.conversationId)) {
    return data.conversationId;
  }
  return null;
}

export async function conversationIdFromSessionFile(
  sessionFile: string,
): Promise<string | null> {
  const fileName = basename(sessionFile);
  if (!HASHED_SESSION_PATTERN.test(fileName)) {
    const conversationId = fileName.endsWith(".jsonl")
      ? fileName.slice(0, -".jsonl".length)
      : fileName;
    return isValidConversationId(conversationId) ? conversationId : null;
  }

  let conversationId: string | null = null;
  let scanned = 0;
  await visitLeadingEntries(sessionFile, (entry) => {
    conversationId = conversationIdFromCustomEntry(entry);
    scanned += 1;
    return conversationId === null && scanned < IDENTITY_SCAN_LIMIT;
  });
  if (conversationId === null || sessionFileNameFor(conversationId) !== fileName) return null;
  return conversationId;
}

/**
 * Verify that a direct file action resolved the one physical transcript bound
 * to the requested raw id. A malformed, missing, or transplanted hashed
 * identity is an integrity conflict, never a relabelled conversation.
 */
export async function requireSessionFileConversationId(
  sessionFile: string,
  requestedConversationId: string,
): Promise<string> {
  requireRawConversationId(requestedConversationId);
  const storedConversationId = await conversationIdFromSessionFile(sessionFile);
  if (storedConversationId === requestedConversationId) return storedConversationId;
  throw new GhostError(
    "session_identity_mismatch",
    "The stored conversation identity does not match the requested resume id.",
    409,
  );
}
