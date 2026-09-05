/** The durable working directory of one pi conversation, moved by `!cd`. */
import { isAbsolute, join, resolve } from "node:path";
import { readDaemonControlFile, writeDaemonControlFile } from "./control-file.js";
import { sessionFileNameFor } from "./session-files.js";

const MAX_BYTES = 16 * 1024;

export function conversationCwdPath(sessionDir: string, conversationId: string): string {
  const stem = sessionFileNameFor(conversationId).slice(0, -".jsonl".length);
  return join(sessionDir, `${stem}.pi.cwd.json`);
}

/** The recorded cwd, or undefined when the conversation never moved. */
export async function readConversationCwd(
  sessionDir: string,
  conversationId: string,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readDaemonControlFile(conversationCwdPath(sessionDir, conversationId), MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as { version?: unknown; cwd?: unknown };
  if (parsed.version !== 1 || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd)
    || parsed.cwd.includes("\0")) {
    throw new Error(`invalid conversation cwd record for ${conversationId}`);
  }
  return resolve(parsed.cwd);
}

export async function writeConversationCwd(
  sessionDir: string,
  conversationId: string,
  cwd: string,
  path = conversationCwdPath(sessionDir, conversationId),
): Promise<void> {
  await writeDaemonControlFile(path, `${JSON.stringify({ version: 1, cwd: resolve(cwd) })}\n`, MAX_BYTES);
}
