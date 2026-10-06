/**
 * Images the owner attaches to a conversation. They live in the conversation
 * directory, the harness's working directory, so a message names one by its
 * relative path and the harness opens it with its own file tools.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GhostError } from "./ghosts.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DIRNAME = "attachments";
const FILE = /^[a-z0-9]+-[0-9a-f]{8}\.(png|jpg|gif|webp)$/;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The image format from its leading bytes, so neither a header nor a file name is trusted. */
function sniff(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

/** Store an image in the conversation directory; returns the path a message names it by. */
export async function saveAttachment(conversationDir: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new GhostError("payload_too_large", "An attachment is at most 20 MiB.", 413);
  }
  const ext = sniff(bytes);
  if (!ext) throw new GhostError("unsupported_media_type", "An attachment must be a PNG, JPEG, GIF, or WebP image.", 415);
  const name = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.${ext}`;
  await mkdir(join(conversationDir, DIRNAME), { recursive: true });
  const file = await open(join(conversationDir, DIRNAME, name), "wx");
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return `${DIRNAME}/${name}`;
}

/** Read back an attachment by the file name `saveAttachment` gave it. */
export async function readAttachment(conversationDir: string, name: string): Promise<{ bytes: Buffer; type: string }> {
  const ext = FILE.exec(name)?.[1];
  if (!ext) throw new GhostError("not_found", "No such attachment.", 404);
  try {
    return { bytes: await readFile(join(conversationDir, DIRNAME, name)), type: TYPES[ext] ?? "application/octet-stream" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new GhostError("not_found", "No such attachment.", 404);
    throw error;
  }
}
