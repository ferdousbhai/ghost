/**
 * The owner's board: `board.md` in the documents directory, read-only here.
 *
 * Ghost keeps no task store. The board is an ordinary Markdown file every
 * harness and the owner edit with file tools — `##` headings are columns,
 * list items are cards, indented lines under a card are its notes — and this
 * module only parses it so the HUD, the tailnet viewer, and `ghost board` can
 * show it. Moving a card is moving its line; there is no API for that.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const BOARD_FILE_NAME = "board.md";
export const BOARD_MAX_BYTES = 256 * 1024;
export const BOARD_MAX_CARDS = 500;

export interface BoardCard {
  readonly text: string;
  /** `- [x]` is done, `- [ ]` is open, a plain `-` item has no box. */
  readonly done?: boolean;
  readonly notes: readonly string[];
}

export interface BoardColumn {
  readonly title: string;
  readonly cards: readonly BoardCard[];
}

export interface Board {
  readonly path: string;
  readonly exists: boolean;
  readonly modified: string | null;
  readonly title: string | null;
  readonly columns: readonly BoardColumn[];
  /** True when the file exceeded a bound and the tail was dropped. */
  readonly truncated: boolean;
}

const CARD = /^[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/u;

/** Parse board Markdown into columns and cards; text before the first `##` is the title. */
export function parseBoard(markdown: string): { title: string | null; columns: BoardColumn[]; truncated: boolean } {
  const columns: Array<{ title: string; cards: Array<{ text: string; done?: boolean; notes: string[] }> }> = [];
  let title: string | null = null;
  let cards = 0;
  let truncated = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\r$/u, "");
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      columns.push({ title: heading[1] ?? "", cards: [] });
      continue;
    }
    const top = /^#\s+(.+?)\s*$/u.exec(line);
    if (top && title === null && columns.length === 0) {
      title = top[1] ?? null;
      continue;
    }
    const column = columns.at(-1);
    if (!column) continue;
    const card = CARD.exec(line);
    if (card && !/^\s/u.test(line)) {
      if (cards >= BOARD_MAX_CARDS) {
        truncated = true;
        break;
      }
      cards += 1;
      const box = card[1];
      column.cards.push({
        text: (card[2] ?? "").trim(),
        ...(box === undefined ? {} : { done: box !== " " }),
        notes: [],
      });
      continue;
    }
    const last = column.cards.at(-1);
    if (last && /^\s+\S/u.test(line)) {
      last.notes.push(line.trim().replace(/^[-*+]\s+/u, ""));
    }
  }
  return { title, columns, truncated };
}

export async function readBoard(documentsDir: string): Promise<Board> {
  const path = join(documentsDir, BOARD_FILE_NAME);
  let modified: string | null = null;
  let size = 0;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { path, exists: false, modified: null, title: null, columns: [], truncated: false };
    modified = info.mtime.toISOString();
    size = info.size;
  } catch {
    return { path, exists: false, modified: null, title: null, columns: [], truncated: false };
  }
  let text = await readFile(path, "utf8");
  let truncated = false;
  if (size > BOARD_MAX_BYTES) {
    text = text.slice(0, BOARD_MAX_BYTES);
    truncated = true;
  }
  const parsed = parseBoard(text);
  return {
    path,
    exists: true,
    modified,
    title: parsed.title,
    columns: parsed.columns,
    truncated: truncated || parsed.truncated,
  };
}
