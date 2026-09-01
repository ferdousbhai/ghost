import type { Dirent } from "node:fs";
import { readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  descriptorPath,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
} from "@ghost/extensions";

export interface GhostHookExtensionLoad {
  factories: ExtensionFactory[];
  errors: Array<{ path: string; error: string }>;
}

export interface GhostHookExtensionLoadOptions {
  afterOpen?: (path: string) => void | Promise<void>;
}

let hookImportSequence = 0;

function hookFactory(value: unknown): ExtensionFactory | null {
  const candidate = typeof value === "function"
    ? value
    : value && typeof value === "object"
      ? (value as { default?: unknown }).default
      : undefined;
  return typeof candidate === "function" ? candidate as ExtensionFactory : null;
}

async function close(file: FileHandle | undefined): Promise<void> {
  await file?.close().catch(() => undefined);
}

/** Load only descriptor-pinned regular JS/TS hook entries from the visible home. */
export async function loadGhostHookExtensions(
  homeDir: string,
  options: GhostHookExtensionLoadOptions = {},
): Promise<GhostHookExtensionLoad> {
  const result: GhostHookExtensionLoad = { factories: [], errors: [] };
  let root: FileHandle | undefined;
  let hooks: FileHandle | undefined;
  try {
    root = await openDirectoryNoFollow(homeDir, "Ghost home");
    try {
      hooks = await openDirectoryNoFollow(descriptorPath(root, "hooks"), "Ghost hooks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      result.errors.push({ path: join(homeDir, "hooks"), error: "Hook directory was rejected." });
      return result;
    }
    for (const kind of ["pre", "post"] as const) {
      const logicalDirectory = join(homeDir, "hooks", kind);
      let directory: FileHandle | undefined;
      try {
        try {
          directory = await openDirectoryNoFollow(
            descriptorPath(hooks, kind),
            `Ghost ${kind} hooks`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          result.errors.push({ path: logicalDirectory, error: "Hook directory was rejected." });
          continue;
        }
        let entries: Dirent[];
        try {
          entries = await readdir(descriptorPath(directory), { withFileTypes: true });
        } catch {
          result.errors.push({ path: logicalDirectory, error: "Hook directory could not be read." });
          continue;
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (entry.name.startsWith(".")) continue;
          if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
          const logicalPath = join(logicalDirectory, entry.name);
          if (!entry.isFile()) {
            result.errors.push({ path: logicalPath, error: "Hook entry is not a regular file." });
            continue;
          }
          let file: FileHandle | undefined;
          try {
            file = await openRegularFileNoFollow(
              descriptorPath(directory, entry.name),
              "Ghost hook entry",
            );
            const openedFile = file;
            const before = await openedFile.stat({ bigint: true });
            if (!before.isFile()) throw new Error("Hook entry is not a regular file.");
            await options.afterOpen?.(logicalPath);
            hookImportSequence += 1;
            const importTag = hookImportSequence;
            const imported: unknown = await import(`${descriptorPath(openedFile)}?ghost-hook=${importTag}`);
            const after = await openedFile.stat({ bigint: true });
            if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
              throw new Error("Hook entry changed filesystem identity while loading.");
            }
            const factory = hookFactory(imported);
            if (!factory) throw new Error("Hook entry does not export a factory function.");
            result.factories.push(factory);
          } catch (error) {
            result.errors.push({
              path: logicalPath,
              error: error instanceof Error ? error.message : "Hook entry could not be loaded.",
            });
          } finally {
            await close(file);
          }
        }
      } finally {
        await close(directory);
      }
    }
    return result;
  } finally {
    await close(hooks);
    await close(root);
  }
}
