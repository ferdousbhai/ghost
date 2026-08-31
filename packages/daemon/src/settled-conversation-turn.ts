export type ConversationSourceRevision =
  | { kind: "pi-leaf"; value: string }
  | { kind: "claude-owner-turn"; value: number };

export type ConversationSourceIdentity =
  | { runtime: "pi"; createdAt: string }
  | { runtime: "claude-code"; createdAt: string; resumeId: string };

/** One owner turn after the native harness has durably settled it. */
export interface SettledConversationTurn {
  source: ConversationSourceIdentity;
  sourceRevision: ConversationSourceRevision;
  sourceOrdinal: number;
  cwd: string;
  ownerPrompt: string;
  assistantText: string;
  outcome: "completed" | "failed";
}

export function isConversationSourceRevision(
  value: unknown,
): value is ConversationSourceRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { kind?: unknown; value?: unknown };
  if (Object.keys(record).length !== 2) return false;
  if (record.kind === "pi-leaf") {
    return typeof record.value === "string"
      && record.value.length > 0
      && record.value.length <= 4_096;
  }
  return record.kind === "claude-owner-turn"
    && Number.isSafeInteger(record.value)
    && (record.value as number) >= 1;
}

export function sourceRevisionMatchesRuntime(
  runtime: "pi" | "claude-code",
  value: unknown,
): value is ConversationSourceRevision {
  if (!isConversationSourceRevision(value)) return false;
  return runtime === "pi" ? value.kind === "pi-leaf" : value.kind === "claude-owner-turn";
}

export function sameSourceRevision(
  left: ConversationSourceRevision,
  right: ConversationSourceRevision,
): boolean {
  return left.kind === right.kind && left.value === right.value;
}
