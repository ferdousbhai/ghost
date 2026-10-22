import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { GhostError } from "./ghosts.js";
import { trashPath } from "./trash.js";

export const MAX_RESULT_BYTES = 100 * 1024 * 1024;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export interface SharedResult { id: string; name: string; bytes: number; createdAt: string }
function resultPath(conversation: string, id: string): string {
  if (!ID.test(id)) throw new GhostError("not_found", "No such shared result.", 404);
  return join(conversation, "results", id);
}
export async function publishResult(conversation: string, path: string): Promise<SharedResult> {
  if (!isAbsolute(path)) throw new GhostError("invalid_result", "A result source must be an absolute path.", 400);
  const source = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => { throw new GhostError("not_found", "Cannot open that result source.", 404); });
  let temporary: string | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new GhostError("invalid_result", "Only regular files can be shared.", 400);
    if (before.size > MAX_RESULT_BYTES) throw new GhostError("payload_too_large", "A result must be at most 100 MiB.", 413);
    const root = join(conversation, "results");
    await mkdir(root, { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(root, ".publish-"));
    const name = basename(path);
    if ([...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || name === "." || name === "..") throw new GhostError("invalid_result", "Use a result filename without control characters.", 400);
    const target = await open(join(temporary, name), "wx", 0o600);
    let createdAt: string;
    try {
      const buffer = Buffer.alloc(65536);
      let copied = 0;
      while (copied < before.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - copied), null);
        if (!bytesRead) break;
        await target.writeFile(buffer.subarray(0, bytesRead)); copied += bytesRead;
      }
      const after = await source.stat(), written = await target.stat();
      createdAt = written.mtime.toISOString();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || written.size !== before.size) {
        throw new GhostError("result_changed", "The source changed while sharing it. Try again.", 409);
      }
    } finally { await target.close(); }
    const id = randomUUID();
    await rename(temporary, join(root, id)); temporary = undefined;
    return { id, name, bytes: before.size, createdAt };
  } finally {
    await source.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
export async function openResult(conversation: string, id: string) {
  const directory = resultPath(conversation, id);
  if (!(await lstat(directory).catch(() => null))?.isDirectory()) throw new GhostError("not_found", "No such shared result.", 404);
  const files = await readdir(directory, { withFileTypes: true }).catch(() => { throw new GhostError("not_found", "No such shared result.", 404); });
  if (files.length !== 1 || !files[0]?.isFile()) throw new GhostError("not_found", "No such shared result.", 404);
  const name = files[0].name;
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new GhostError("not_found", "No such shared result.", 404); });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_RESULT_BYTES) throw new GhostError("not_found", "No such shared result.", 404);
    return { file, result: { id, name, bytes: stat.size, createdAt: stat.mtime.toISOString() } };
  } catch (error) { await file.close(); throw error; }
}
export async function listResults(conversation: string): Promise<SharedResult[]> {
  const dirs = await readdir(join(conversation, "results")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const results = [];
  for (const id of dirs.filter(id => ID.test(id))) {
    try { const { file, result } = await openResult(conversation, id); await file.close(); results.push(result); }
    catch (error) { if (!(error instanceof GhostError && error.status === 404)) throw error; }
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function revokeResult(conversation: string, id: string, env: NodeJS.ProcessEnv): Promise<void> {
  const { file } = await openResult(conversation, id); await file.close();
  await trashPath(resultPath(conversation, id), env);
}
