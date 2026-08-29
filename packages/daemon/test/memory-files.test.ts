import { mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listGhostMemory,
  trashGhostMemoryFile,
  writeGhostMemory,
} from "../src/memory-files.js";
import { tempDir, useCleanups } from "./helpers/fixtures.js";

const cleanups = useCleanups();

function fixture(): { ghost: string; xdg: string } {
  const temp = tempDir("ghost-memory-files-");
  cleanups.push(temp.cleanup);
  const ghost = join(temp.path, "ghost");
  mkdirSync(join(ghost, "memory"), { recursive: true });
  return { ghost, xdg: join(temp.path, "xdg") };
}

describe("listGhostMemory", () => {
  it("lists the plain fact per file, newest first, and reports the unreadable ones", async () => {
    const { ghost } = fixture();
    const older = new Date("2026-08-20T10:00:00.000Z");
    const newer = new Date("2026-08-27T10:00:00.000Z");
    writeFileSync(join(ghost, "memory", "alpha.md"), "The first remembered fact.\n", "utf8");
    utimesSync(join(ghost, "memory", "alpha.md"), older, older);
    writeFileSync(join(ghost, "memory", "zeta.md"), "The last remembered fact.\n", "utf8");
    utimesSync(join(ghost, "memory", "zeta.md"), newer, newer);
    writeFileSync(join(ghost, "memory", "broken.md"), "\n", "utf8");

    const listing = await listGhostMemory(ghost);

    expect(listing.memory).toEqual([
      {
        path: "memory/zeta.md",
        slug: "zeta",
        content: "The last remembered fact.",
        updated: newer.toISOString(),
      },
      {
        path: "memory/alpha.md",
        slug: "alpha",
        content: "The first remembered fact.",
        updated: older.toISOString(),
      },
    ]);
    expect(listing.skipped).toHaveLength(1);
    expect(listing.skipped[0]!.path).toBe("memory/broken.md");
    expect(listing.skipped[0]!.reason.length).toBeGreaterThan(0);
  });

  it("is empty for a ghost with no memory directory", async () => {
    const { ghost } = fixture();
    rmSync(join(ghost, "memory"), { recursive: true });
    expect(await listGhostMemory(ghost)).toEqual({ memory: [], skipped: [] });
  });
});

describe("writeGhostMemory", () => {
  it("derives a slug, replaces by name, and redacts like the model's writer", async () => {
    const { ghost } = fixture();

    const created = await writeGhostMemory(ghost, { content: "Prefers concise replies." });
    expect(created).toEqual({
      slug: "prefers-concise-replies",
      path: "memory/prefers-concise-replies.md",
      created: true,
    });
    expect(readFileSync(join(ghost, created.path), "utf8")).toBe("Prefers concise replies.\n");

    const replaced = await writeGhostMemory(ghost, {
      name: "prefers-concise-replies",
      content: "Prefers concise replies; token sk-abcdefghijklmnop is not worth keeping.",
    });
    expect(replaced.created).toBe(false);
    expect(readFileSync(join(ghost, replaced.path), "utf8")).toContain("[REDACTED_SECRET]");
  });

  it("keeps the writer's own rejection code and reason", async () => {
    const { ghost } = fixture();
    await expect(writeGhostMemory(ghost, { content: "   " })).rejects.toThrowError(
      expect.objectContaining({
        code: "invalid_format",
        status: 400,
        message: expect.stringContaining("one concise fact"),
      }),
    );
    await expect(writeGhostMemory(ghost, { name: "Not A Slug", content: "x" })).rejects
      .toThrowError(expect.objectContaining({ code: "invalid_format", status: 400 }));
  });
});

describe("trashGhostMemoryFile", () => {
  it("moves a memory symlink itself without following it", () => {
    const { ghost, xdg } = fixture();
    const outside = join(ghost, "outside.txt");
    writeFileSync(outside, "keep\n", "utf8");
    symlinkSync(outside, join(ghost, "memory", "linked.md"));

    trashGhostMemoryFile(ghost, "memory/linked.md", { env: { XDG_DATA_HOME: xdg } });

    expect(readFileSync(outside, "utf8")).toBe("keep\n");
  });

  it.each([
    "docs/note.md",
    "character.md",
    "memory/not-markdown.txt",
    "memory/../../outside.md",
    "memory/Not A Slug.md",
    "/memory/absolute.md",
  ])("rejects path %s", (path) => {
    const { ghost } = fixture();
    expect(() => trashGhostMemoryFile(ghost, path)).toThrowError(
      expect.objectContaining({ code: "invalid_memory_path", status: 400 }),
    );
  });

  it("reports a missing file", () => {
    const { ghost } = fixture();
    expect(() => trashGhostMemoryFile(ghost, "memory/missing.md")).toThrowError(
      expect.objectContaining({ code: "not_found", status: 404 }),
    );
  });
});
