/** A ghost home's persona file, read whole and replaced by one rename. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CHARACTER_FILENAME,
  characterBodyTooLong,
  MAX_CHARACTER_BODY_LENGTH,
  type CharacterFile,
} from "./persona.js";
import { GhostError } from "./errors.js";
import { writePrivateTextAtomic } from "./private-file.js";

export { CHARACTER_FILENAME, MAX_CHARACTER_BODY_LENGTH };

export class GhostHome {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  get characterPath(): string {
    return join(this.dir, CHARACTER_FILENAME);
  }

  /**
   * `enforceLimit: false` is for the owner's editor: an oversize hand-edited
   * file must still load so it can be shortened, while every prompt-bound
   * reader keeps the default refusal.
   */
  async readCharacter(
    options?: { enforceLimit?: boolean },
  ): Promise<CharacterFile | null> {
    let body: string;
    try {
      body = await readFile(this.characterPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if ((options?.enforceLimit ?? true) && characterBodyTooLong(body)) {
      throw new GhostError(
        "limit_exceeded",
        `${CHARACTER_FILENAME} may be at most ${MAX_CHARACTER_BODY_LENGTH} characters; `
        + `it contains ${body.length}. Shorten the file before starting a session.`,
        400,
      );
    }
    return { body };
  }

  /**
   * The owner's persona edits land here so an oversize body is refused at
   * write time, not discovered when the next cold session fails to start.
   */
  async writeCharacter(input: { body: string }): Promise<void> {
    if (characterBodyTooLong(input.body)) {
      throw new GhostError(
        "limit_exceeded",
        `${CHARACTER_FILENAME} may be at most ${MAX_CHARACTER_BODY_LENGTH} characters; `
        + `that body is ${input.body.length}. Nothing was written.`,
        400,
      );
    }
    await writePrivateTextAtomic(this.characterPath, input.body);
  }
}

export function openGhostHome(dir: string): GhostHome {
  return new GhostHome(dir);
}
