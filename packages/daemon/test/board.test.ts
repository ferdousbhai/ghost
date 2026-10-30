import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BOARD_MAX_BYTES, BOARD_MAX_CARDS, parseBoard, readBoard } from "../src/board.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("board", () => {
  it("parses columns, cards, boxes, and notes", () => {
    const board = parseBoard([
      "# Projects",
      "",
      "Some intro text nobody cares about.",
      "## Now",
      "- [ ] Ship the browser guide",
      "  handed off from Claude at 40% weekly",
      "  - next: verify on a second machine",
      "- [x] Cut v0.1.1",
      "## Later",
      "* Board in the HUD",
      "",
      "## Done",
    ].join("\n"));
    expect(board.title).toBe("Projects");
    expect(board.truncated).toBe(false);
    expect(board.columns.map((column) => column.title)).toEqual(["Now", "Later", "Done"]);
    expect(board.columns[0]?.cards).toEqual([
      { text: "Ship the browser guide", done: false, notes: ["handed off from Claude at 40% weekly", "next: verify on a second machine"] },
      { text: "Cut v0.1.1", done: true, notes: [] },
    ]);
    expect(board.columns[1]?.cards).toEqual([{ text: "Board in the HUD", notes: [] }]);
    expect(board.columns[2]?.cards).toEqual([]);
  });

  it("caps the number of cards and says so", () => {
    const lines = ["## Backlog", ...Array.from({ length: BOARD_MAX_CARDS + 5 }, (_, i) => `- card ${i}`)];
    const board = parseBoard(lines.join("\n"));
    expect(board.columns[0]?.cards).toHaveLength(BOARD_MAX_CARDS);
    expect(board.truncated).toBe(true);
  });

  it("reads the file from the documents directory and reports absence plainly", async () => {
    dir = mkdtempSync(join(tmpdir(), "ghost-board-"));
    const missing = await readBoard(dir);
    expect(missing).toMatchObject({ exists: false, columns: [], path: join(dir, "board.md") });
    writeFileSync(join(dir, "board.md"), "## Now\n- one\n");
    const present = await readBoard(dir);
    expect(present.exists).toBe(true);
    expect(present.modified).toBeTypeOf("string");
    expect(present.columns[0]?.cards[0]?.text).toBe("one");
    writeFileSync(join(dir, "board.md"), `## Big\n${"- x\n".repeat(BOARD_MAX_BYTES / 4)}`);
    expect((await readBoard(dir)).truncated).toBe(true);
  });

  it("reads no further than the byte bound, whatever the characters", async () => {
    dir = mkdtempSync(join(tmpdir(), "ghost-board-"));
    // Half as many characters as bytes: a character-count cut would keep the tail.
    writeFileSync(join(dir, "board.md"), `## Head\n${"é".repeat(BOARD_MAX_BYTES / 2)}\n## Beyond\n- late\n`);
    const board = await readBoard(dir);
    expect(board.truncated).toBe(true);
    expect(board.columns.map((column) => column.title)).toEqual(["Head"]);
  });

  it("drops a character the bound splits rather than ending in U+FFFD", async () => {
    dir = mkdtempSync(join(tmpdir(), "ghost-board-"));
    // An odd 11-byte prefix puts the even byte bound inside an "é".
    writeFileSync(join(dir, "board.md"), `## Head\n- x${"é".repeat(BOARD_MAX_BYTES / 2)}\n`);
    const card = (await readBoard(dir)).columns[0]?.cards[0];
    expect(card).toBeDefined();
    expect(JSON.stringify(card)).not.toContain("�");
  });
});
