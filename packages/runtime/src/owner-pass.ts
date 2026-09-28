import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type OwnerPassKind = "direct" | "steer" | "followUp" | "custom" | "reanswer";
export const ASK_REANSWER_OWNER_MESSAGE_TYPE = "ghost-ask-reanswer-owner";

export interface PendingOwnerPass {
  readonly kind: OwnerPassKind;
  readonly ownerPrompt: string;
  readonly priorEntryIds: ReadonlySet<string>;
  ownerEntryId?: string;
}

export type PersistedOwnerPassResult<Pass extends PendingOwnerPass> =
  | { pass: Pass; assistantEntry: Extract<SessionEntry, { type: "message" }> }
  | "superseded"
  | null;

function entryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("");
}

function ownerEntry(entry: SessionEntry): { kind: OwnerPassKind; prompt: string } | null {
  if (entry.type === "message" && entry.message.role === "user") {
    if ((entry.message as { attribution?: string }).attribution === "agent") return null;
    return { kind: "direct", prompt: entryText(entry.message.content) };
  }
  if (entry.type !== "custom_message") return null;
  if (entry.customType === ASK_REANSWER_OWNER_MESSAGE_TYPE) {
    return { kind: "reanswer", prompt: entryText(entry.content) };
  }
  const details = entry.details as { attribution?: unknown } | undefined;
  if (details?.attribution === "user") return { kind: "custom", prompt: entryText(entry.content) };
  return null;
}

function passEntryMatches(pass: PendingOwnerPass, owner: { kind: OwnerPassKind; prompt: string }): boolean {
  if (pass.kind === "direct") return owner.kind === "direct" || owner.kind === "custom";
  // Pi queues steering and follow-up text as ordinary user messages.
  if (pass.kind === "steer" || pass.kind === "followUp") return owner.kind === "direct" && owner.prompt === pass.ownerPrompt;
  return owner.kind === pass.kind && owner.prompt === pass.ownerPrompt;
}

/** Identify the persisted assistant pass after Pi has saved the owner entry. */
export function persistedOwnerPassBoundary<Pass extends PendingOwnerPass>(
  branch: readonly SessionEntry[],
  pass: Pass,
  claimedOwnerEntries: Set<string>,
): PersistedOwnerPassResult<Pass> {
  let ownerIndex = pass.ownerEntryId ? branch.findIndex((entry) => entry.id === pass.ownerEntryId) : -1;
  if (ownerIndex < 0) {
    for (let index = 0; index < branch.length; index += 1) {
      const entry = branch[index];
      if (!entry || pass.priorEntryIds.has(entry.id) || claimedOwnerEntries.has(entry.id)) continue;
      const owner = ownerEntry(entry);
      if (owner && passEntryMatches(pass, owner)) {
        ownerIndex = index;
        pass.ownerEntryId = entry.id;
        claimedOwnerEntries.add(entry.id);
        break;
      }
    }
  }
  if (ownerIndex < 0) return null;
  let assistantEntry: Extract<SessionEntry, { type: "message" }> | undefined;
  for (let index = ownerIndex + 1; index < branch.length; index += 1) {
    const entry = branch[index];
    if (!entry) continue;
    if (ownerEntry(entry)) return assistantEntry ? { pass, assistantEntry } : "superseded";
    if (entry.type === "message" && entry.message.role === "assistant"
      && entry.message.stopReason !== "toolUse") assistantEntry = entry;
  }
  return assistantEntry ? { pass, assistantEntry } : null;
}
