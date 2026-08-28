import { lstatSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { GhostError } from "./ghosts.js";
import {
  trashPath,
  type TrashPathOptions,
  type TrashPathResult,
} from "./trash.js";

export type TrashableContextSection = "memory";

export interface TrashedContextFile extends TrashPathResult {
  path: string;
}

function validateContextPath(
  ghostDir: string,
  section: TrashableContextSection,
  relativePath: string,
): string {
  const expectedPrefix = `${section}/`;
  const parts = relativePath.split("/");
  if (
    isAbsolute(relativePath)
    || relativePath.includes("\0")
    || !relativePath.startsWith(expectedPrefix)
    || parts.some((part) => part === "" || part === "." || part === "..")
    || !relativePath.endsWith(".md")
  ) {
    throw new GhostError(
      "invalid_context_path",
      `Expected a Markdown file below ${JSON.stringify(`${section}/`)}.`,
      400,
    );
  }

  const home = resolve(ghostDir);
  const target = resolve(home, relativePath);
  const root = resolve(home, section);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new GhostError(
      "invalid_context_path",
      `Expected a Markdown file below ${JSON.stringify(`${section}/`)}.`,
      400,
    );
  }
  return target;
}

export function trashGhostContextFile(
  ghostDir: string,
  section: TrashableContextSection,
  relativePath: string,
  options: TrashPathOptions = {},
): TrashedContextFile {
  const target = validateContextPath(ghostDir, section, relativePath);
  try {
    const entry = lstatSync(target);
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new GhostError(
        "invalid_context_path",
        "Only an individual context file can be moved to trash.",
        400,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GhostError(
        "not_found",
        `This ghost has no context file ${JSON.stringify(relativePath)}.`,
        404,
      );
    }
    throw error;
  }

  return {
    path: relativePath,
    ...trashPath(target, {
      ...options,
      fallbackRoot: options.fallbackRoot ?? resolve(ghostDir, ".trash"),
    }),
  };
}
