/** The ghost-home/v1 value types, shared by the reader/writer and the extensions. */
import type { GhostScope } from "./scope.js";

export const GHOST_HOME_FORMAT = "ghost-home/v1";

/** Frontmatter a doc carries. `public` absent or false means private. */
export interface DocFrontmatter {
  /** `public: true` is the only thing that publishes a doc. */
  readonly public: boolean;
  readonly title: string | undefined;
  readonly tags: readonly string[];
  readonly archived: boolean;
  /** The pre-sanitization app path, when the export had to rewrite it. */
  readonly appPath: string | undefined;
}

export interface DocMeta extends DocFrontmatter {
  /** Path relative to `docs/`, always ending in `.md`, always `/`-separated. */
  readonly path: string;
}

export interface DocFile {
  readonly meta: DocMeta;
  /** The doc body, exactly as stored. */
  readonly body: string;
}

export interface CharacterFile {
  readonly public: boolean;
  readonly title: string | undefined;
  readonly body: string;
}

export interface MemoryRecord {
  readonly slug: string;
  readonly description: string;
  readonly content: string;
  /** `updated:` from the file, `YYYY-MM-DD`. */
  readonly updated: string | undefined;
  readonly scope: GhostScope;
}

export interface DocCatalog {
  /** Budgeted catalog lines, a contiguous prefix of the path-sorted catalog. */
  readonly lines: readonly string[];
  readonly chars: number;
  readonly omitted: number;
  /** Docs visible in this scope. */
  readonly total: number;
  readonly publicCount: number;
}
