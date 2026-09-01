
export const GHOST_HOME_FORMAT = "ghost-home/v2";

export interface CharacterFile {
  readonly title: string | undefined;
  readonly body: string;
}

export interface MemoryRecord {
  readonly slug: string;
  readonly content: string;
  readonly updated: string;
}
