import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { homeTrashDir, trashPath } from "../src/trash.js";

let roots: string[] = [];

function root(name: string): string {
  const path = join(tmpdir(), `ghost-trash-${name}-${crypto.randomUUID()}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
  roots = [];
});

describe("trashPath", () => {
  it("moves a file into freedesktop trash with an encoded origin", () => {
    const sourceRoot = root("source");
    const xdg = root("xdg");
    const source = join(sourceRoot, "résumé note.md");
    writeFileSync(source, "kept\n");

    const result = trashPath(source, {
      now: new Date(2026, 7, 24, 15, 30, 0),
      env: { XDG_DATA_HOME: xdg },
    });

    expect(result).toEqual({
      trash: join(xdg, "Trash", "files", "résumé note.md"),
      kind: "freedesktop",
    });
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(result.trash, "utf8")).toBe("kept\n");
    expect(readFileSync(join(xdg, "Trash", "info", "résumé note.md.trashinfo"), "utf8"))
      .toContain(`Path=${encodeURIComponent(source).replaceAll("%2F", "/")}`);
  });

  it("uses collision suffixes without overwriting an existing trash entry", () => {
    const sourceRoot = root("source");
    const xdg = root("xdg");
    const first = join(sourceRoot, "memory.md");
    writeFileSync(first, "first");
    const firstResult = trashPath(first, { env: { XDG_DATA_HOME: xdg } });
    writeFileSync(first, "second");
    const secondResult = trashPath(first, { env: { XDG_DATA_HOME: xdg } });

    expect(firstResult.trash).toBe(join(xdg, "Trash", "files", "memory.md"));
    expect(secondResult.trash).toBe(join(xdg, "Trash", "files", "memory.md.2"));
    expect(readFileSync(firstResult.trash, "utf8")).toBe("first");
    expect(readFileSync(secondResult.trash, "utf8")).toBe("second");
  });

  it("moves a directory and everything below it", () => {
    const sourceRoot = root("source");
    const xdg = root("xdg");
    const source = join(sourceRoot, "conversation");
    mkdirSync(source);
    writeFileSync(join(source, "turn.jsonl"), "{}\n");

    const result = trashPath(source, { env: { XDG_DATA_HOME: xdg } });

    expect(readFileSync(join(result.trash, "turn.jsonl"), "utf8")).toBe("{}\n");
    expect(existsSync(source)).toBe(false);
  });

  it("resolves the home trash from an absolute XDG data home only", () => {
    expect(homeTrashDir({ XDG_DATA_HOME: "/data" }, "/home/test"))
      .toBe("/data/Trash");
    expect(homeTrashDir({ XDG_DATA_HOME: "relative" }, "/home/test"))
      .toBe("/home/test/.local/share/Trash");
  });
});
