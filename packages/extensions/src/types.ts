/** The ghost-home/v2 value types, shared by the reader/writer and extensions. */

export const GHOST_HOME_FORMAT = "ghost-home/v2";

export interface CharacterFile {
  readonly title: string | undefined;
  readonly body: string;
}

export interface MemoryRecord {
  readonly slug: string;
  /** Compact index preview derived from `content`. */
  readonly description: string;
  readonly content: string;
  /** Filesystem modification date, `YYYY-MM-DD`. */
  readonly updated: string;
}

export interface DocumentsIndex {
  /** Absolute local root used by native filesystem tools and trusted clients. */
  readonly root: string;
  /** Budgeted top-level entry lines. No descendant or file content is included. */
  readonly lines: readonly string[];
  readonly chars: number;
  readonly omitted: number;
  readonly total: number;
}
