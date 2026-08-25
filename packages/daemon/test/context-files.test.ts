import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trashGhostContextFile } from "../src/context-files.js";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { ghost: string; trash: string; xdg: string } {
  const root = mkdtempSync(join(tmpdir(), "ghost-context-files-"));
  roots.push(root);
  const ghost = join(root, "ghost");
  const xdg = join(root, "xdg");
  const trash = join(xdg, "Trash");
  mkdirSync(join(ghost, "docs", "nested"), { recursive: true });
  mkdirSync(join(ghost, "memory"), { recursive: true });
  return { ghost, trash, xdg };
}

describe("trashGhostContextFile", () => {
  it("moves a nested document into the freedesktop trash", () => {
    const { ghost, trash, xdg } = fixture();
    const source = join(ghost, "docs", "nested", "notes.md");
    writeFileSync(source, "notes\n", "utf8");

    const result = trashGhostContextFile(ghost, "docs", "docs/nested/notes.md", {
      env: { XDG_DATA_HOME: xdg },
    });

    expect(result.path).toBe("docs/nested/notes.md");
    expect(result.trash).toBe(join(trash, "files", "notes.md"));
    expect(readFileSync(result.trash, "utf8")).toBe("notes\n");
  });

  it("moves a memory symlink itself without following it", () => {
    const { ghost, xdg } = fixture();
    const outside = join(ghost, "outside.txt");
    writeFileSync(outside, "keep\n", "utf8");
    symlinkSync(outside, join(ghost, "memory", "linked.md"));

    trashGhostContextFile(ghost, "memory", "memory/linked.md", {
      env: { XDG_DATA_HOME: xdg },
    });

    expect(readFileSync(outside, "utf8")).toBe("keep\n");
  });

  it.each([
    ["docs", "../character.md"],
    ["docs", "docs/../../outside.md"],
    ["docs", "/tmp/outside.md"],
    ["memory", "docs/note.md"],
    ["memory", "memory/not-markdown.txt"],
  ] as const)("rejects %s path %s", (section, path) => {
    const { ghost } = fixture();
    expect(() => trashGhostContextFile(ghost, section, path)).toThrowError(
      expect.objectContaining({ code: "invalid_context_path", status: 400 }),
    );
  });

  it("reports a missing owned file", () => {
    const { ghost } = fixture();
    expect(() => trashGhostContextFile(ghost, "memory", "memory/missing.md")).toThrowError(
      expect.objectContaining({ code: "not_found", status: 404 }),
    );
  });
});
