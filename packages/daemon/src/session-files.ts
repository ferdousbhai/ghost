import { createHash } from "node:crypto";
import { sep } from "node:path";

/** Map a client conversation id onto its collision-safe transcript filename. */
export function sessionFileNameFor(sessionKey: string): string {
  const safe = sessionKey.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  const needsHash = safe !== sessionKey;
  if (!needsHash && safe.length > 0) return `${safe}.jsonl`;
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
  return `${safe || "session"}-${digest}.jsonl`;
}

/** Recover a filename-safe conversation id from a native transcript path. */
export function conversationIdFromSessionFile(sessionFile: string): string {
  const base = sessionFile.slice(sessionFile.lastIndexOf(sep) + 1);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}
