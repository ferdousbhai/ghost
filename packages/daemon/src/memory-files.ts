import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  coerceMemorySlug,
  compareMemoryNewestFirst,
  MEMORY_DIRNAME,
  memoryFileName,
  openGhostHome,
  type MemoryWriteInput,
  type MemoryWriteResult,
} from "@ghost/extensions";
import { GhostError, translateExtensionError } from "./ghosts.js";
import {
  trashPath,
  type TrashPathOptions,
  type TrashPathResult,
} from "./trash.js";

export interface GhostMemoryEntry {
  path: string;
  slug: string;
  content: string;
  updated: string;
}

export interface GhostMemorySkipped {
  path: string;
  reason: string;
}

export interface GhostMemoryListing {
  memory: GhostMemoryEntry[];
  skipped: GhostMemorySkipped[];
}

export interface TrashedMemoryFile extends TrashPathResult {
  path: string;
}

function memoryPath(slug: string): string {
  return `${MEMORY_DIRNAME}/${memoryFileName(slug)}`;
}

/**
 * The owner's view of one ghost's memory: the plain files, listed from disk on
 * every request in the order the model's index uses. No second index is
 * stored beside them.
 */
export async function listGhostMemory(dir: string): Promise<GhostMemoryListing> {
  const listing = await openGhostHome(dir).listMemory();
  return {
    memory: [...listing.files]
      .sort(compareMemoryNewestFirst)
      .map(({ slug, content, updated }) => ({ path: memoryPath(slug), slug, content, updated })),
    skipped: [...listing.skipped].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/**
 * The owner's writes go through the validated, redacting, atomic home writer,
 * so a hand-typed fact obeys its limits and a rejection carries the writer's
 * own reason.
 */
export async function writeGhostMemory(
  dir: string,
  input: MemoryWriteInput,
): Promise<MemoryWriteResult> {
  try {
    return await openGhostHome(dir).writeMemory(input);
  } catch (error) {
    return translateExtensionError(error);
  }
}

/** The slug of a path the listing itself produced; anything else is refused. */
function memorySlugOfPath(relativePath: string): string {
  const [dirname, fileName, ...rest] = relativePath.split("/");
  if (dirname !== MEMORY_DIRNAME || fileName === undefined || rest.length > 0) {
    throw new GhostError(
      "invalid_memory_path",
      `Expected a Markdown file below "${MEMORY_DIRNAME}/".`,
      400,
    );
  }
  try {
    return coerceMemorySlug(fileName);
  } catch (error) {
    throw new GhostError("invalid_memory_path", (error as Error).message, 400);
  }
}

export function trashGhostMemoryFile(
  ghostDir: string,
  relativePath: string,
  options: TrashPathOptions = {},
): TrashedMemoryFile {
  const target = join(ghostDir, memoryPath(memorySlugOfPath(relativePath)));
  try {
    const entry = lstatSync(target);
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new GhostError(
        "invalid_memory_path",
        "Only an individual memory file can be moved to trash.",
        400,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GhostError(
        "not_found",
        `This ghost has no memory file ${JSON.stringify(relativePath)}.`,
        404,
      );
    }
    throw error;
  }

  return {
    path: relativePath,
    ...trashPath(target, { ...options, fallbackRoot: join(ghostDir, ".trash") }),
  };
}
