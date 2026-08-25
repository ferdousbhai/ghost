/** The ghost-home/v2 value types, shared by the reader/writer and extensions. */

export const GHOST_HOME_FORMAT = "ghost-home/v2";

export interface DocMeta {
  /** Path relative to `docs/`, always ending in `.md`, always `/`-separated. */
  readonly path: string;
  /** Text of the required first `# Title` heading. */
  readonly title: string;
  /** Trailing tag slugs, excluding the reserved `archived` status tag. */
  readonly tags: readonly string[];
  readonly archived: boolean;
}

export interface DocFile {
  readonly meta: DocMeta;
  /** Complete canonical Markdown, exactly as stored, including title and tags. */
  readonly body: string;
}

export interface CharacterFile {
  readonly title: string | undefined;
  readonly body: string;
}

export interface MemoryRecord {
  readonly slug: string;
  readonly description: string;
  readonly content: string;
  /** `updated:` from the file, `YYYY-MM-DD`. */
  readonly updated: string | undefined;
}

export interface DocCatalog {
  /** Budgeted catalog lines, a contiguous prefix of the path-sorted catalog. */
  readonly lines: readonly string[];
  readonly chars: number;
  readonly omitted: number;
  readonly total: number;
}
