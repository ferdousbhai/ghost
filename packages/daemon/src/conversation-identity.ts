import { GhostError } from "./ghosts.js";

export type ConversationRuntime = "pi" | "claude-code";

export interface ConversationIdentity {
  id: string;
  conversationId: string;
  runtime: ConversationRuntime;
}

const RUNTIME_PREFIXES: Readonly<Record<ConversationRuntime, string>> = {
  pi: "pi:",
  "claude-code": "claude-code:",
};

export const MAX_CONVERSATION_ID_SCALARS = 200;

/**
 * One accepted runtime-owned resume id. JavaScript strings can contain lone
 * UTF-16 surrogates, so counting code points with spread/for-of is not enough:
 * reject those non-scalar values explicitly instead of normalizing them.
 */
export function isValidConversationId(conversationId: string): boolean {
  let scalars = 0;
  for (let index = 0; index < conversationId.length; index += 1) {
    const unit = conversationId.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = conversationId.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
    scalars += 1;
    if (scalars > MAX_CONVERSATION_ID_SCALARS) return false;
  }
  return scalars > 0;
}

export function requireRawConversationId(conversationId: string): string {
  if (isValidConversationId(conversationId)) return conversationId;
  throw new GhostError(
    "invalid_conversation_id",
    `Conversation ids must contain 1-${MAX_CONVERSATION_ID_SCALARS} Unicode scalar values.`,
    400,
  );
}

/** Build the stable public identity for one runtime-owned conversation. */
export function conversationIdentity<Runtime extends ConversationRuntime>(
  runtime: Runtime,
  conversationId: string,
): ConversationIdentity & { runtime: Runtime } {
  requireRawConversationId(conversationId);
  return {
    id: `${RUNTIME_PREFIXES[runtime]}${conversationId}`,
    conversationId,
    runtime,
  };
}

export function parseConversationIdentity(id: string): ConversationIdentity | null {
  for (const runtime of ["pi", "claude-code"] as const) {
    const prefix = RUNTIME_PREFIXES[runtime];
    if (!id.startsWith(prefix)) continue;
    const conversationId = id.slice(prefix.length);
    return isValidConversationId(conversationId) ? { id, conversationId, runtime } : null;
  }
  return null;
}

export function requireConversationIdentity(id: string): ConversationIdentity {
  const parsed = parseConversationIdentity(id);
  if (parsed) return parsed;
  throw new GhostError(
    "invalid_conversation_id",
    "Use the runtime-qualified conversation id returned by GET .../sessions.",
    400,
  );
}

/**
 * How a shell command started by a ghost names its own conversation: the
 * variables the `ghost` CLI reads in place of `-g` and `-s`. Both runtimes
 * put them in their bash environment.
 */
export function conversationEnvironment(
  ghostName: string,
  conversationId: string,
  runtime: ConversationRuntime,
): { GHOST: string; GHOST_SESSION: string } {
  return { GHOST: ghostName, GHOST_SESSION: conversationIdentity(runtime, conversationId).id };
}
