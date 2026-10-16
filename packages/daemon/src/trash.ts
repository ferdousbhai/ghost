/**
 * Recoverable deletion: `gio trash` moves a path into the freedesktop Trash
 * (the home trash, or its filesystem's `.Trash-$UID`) by rename, never by
 * copy-then-delete. Where it cannot, it refuses and nothing is removed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GhostError } from "./ghosts.js";

const exec = promisify(execFile);

export async function trashPath(path: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await exec("gio", ["trash", "--", path], { env });
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    const reason = stderr?.trim().split("\n").at(-1) || message;
    throw new GhostError("trash_failed", `Could not move ${path} to Trash; nothing was deleted. ${reason}`, 500);
  }
}
