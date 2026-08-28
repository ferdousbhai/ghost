import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  descriptorPath,
  type MachineDocuments,
  openMachineDocuments,
  withDescriptorLock,
  type DocumentDirectoryPage,
  type DocumentTextContent,
  type ListDocumentDirectoryOptions,
} from "@ghost/extensions";
import { GhostError, translateExtensionError } from "./ghosts.js";
import { trashPath, type TrashPathResult } from "./trash.js";

export interface TrashedDocument extends TrashPathResult {
  readonly path: string;
}

function translate(error: unknown): never {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new GhostError(
      "not_found",
      "That Documents directory does not exist.",
      404,
    );
  }
  return translateExtensionError(error);
}

export class DocumentsService {
  readonly store: MachineDocuments;

  constructor(store: MachineDocuments = openMachineDocuments()) {
    this.store = store;
  }

  async list(
    path: string,
    options: ListDocumentDirectoryOptions = {},
  ): Promise<DocumentDirectoryPage> {
    try {
      return await this.store.listDirectory(path, options);
    } catch (error) {
      return translate(error);
    }
  }

  async content(path: string): Promise<DocumentTextContent> {
    try {
      return await this.store.readTextContent(path);
    } catch (error) {
      return translate(error);
    }
  }

  async trash(path: string): Promise<TrashedDocument> {
    let opened: Awaited<ReturnType<MachineDocuments["openFileParent"]>>;
    try {
      opened = await this.store.openFileParent(path);
    } catch (error) {
      return translate(error);
    }
    try {
      return await withDescriptorLock(opened.directory, async () => {
        const source = descriptorPath(opened.directory, opened.name);
        let stats: ReturnType<typeof lstatSync>;
        try {
          stats = lstatSync(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new GhostError(
              "not_found",
              `Documents has no file ${JSON.stringify(opened.relativePath)}.`,
              404,
            );
          }
          throw error;
        }
        if (!stats.isFile()) {
          throw new GhostError(
            "invalid_documents_path",
            "Only a regular Documents file can be moved to Trash.",
            400,
          );
        }
        const original = join(opened.root, ...opened.relativePath.split("/"));
        return {
          path: opened.relativePath,
          ...trashPath(source, {
            originalPath: original,
            fallbackRoot: join(opened.root, ".trash"),
          }),
        };
      });
    } finally {
      await opened.directory.close();
    }
  }
}
