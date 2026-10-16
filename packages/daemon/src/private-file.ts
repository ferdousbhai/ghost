/**
 * Reads and atomic writes for the small files ghostd keeps in a ghost home
 * and its own state: capped at 1 MiB and decoded strictly on read, written
 * private (0600) through a temporary file and one rename.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

export const MAX_PRIVATE_FILE_BYTES = 1_048_576;

/** The file's text, or null when it does not exist; past 1 MiB or invalid UTF-8 throws, naming the file. */
export function readPrivateFileText(path: string): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (size > MAX_PRIVATE_FILE_BYTES) throw new Error(`${path} exceeds the 1 MiB limit.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${path} is not valid UTF-8.`);
    throw error;
  }
}

/**
 * Replace `path` with `value` as pretty JSON, private (0600), through a
 * per-writer temporary file and one rename, so a reader never sees a torn
 * file and two concurrent writers never share a temporary name.
 */
export async function writePrivateJsonAtomic(path: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new TypeError(`${path} cannot be represented as JSON.`);
  const rendered = `${json}\n`;
  if (Buffer.byteLength(rendered, "utf8") > MAX_PRIVATE_FILE_BYTES) {
    throw new RangeError(`${path} would exceed the 1 MiB private-file limit.`);
  }
  await writePrivateTextAtomic(path, rendered);
}

/** Replace `path` with `text`, private (0600), through a temporary file and one rename. */
export async function writePrivateTextAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
