import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhostError } from "../src/errors.js";
import { importGhostArchive } from "../src/import.js";
import { deriveMemoryIndex } from "../src/memory-file.js";
import { createTempDir, writeFileTree } from "./support/fixture.js";

/**
 * A hand-built ghost-home/v1 archive in the exact shape the hosted exporter
 * writes (`buildGhostHomeArchive` + `withExportManifest`): one root directory,
 * legacy `notes/` files with `title`/`tags`, memory files with
 * `description`/`updated`, transcripts in `conversations/`, and the manifest last.
 */
const ROOT = "casper";
const ARCHIVE: Record<string, string> = {
  [`${ROOT}/character.md`]: "---\ntitle: Casper\n---\n\n# Casper\n\nA printer.",
  [`${ROOT}/notes/craft/paper-notes.md`]:
    "---\ntitle: Paper notes\ntags: [paper]\n---\n\nDamp the sheet.",
  [`${ROOT}/notes/estate-finances.md`]:
    "---\ntitle: Estate and finances\npath: Estate & finances\n---\n\nThe lease.",
  [`${ROOT}/memory/working-habit.md`]:
    "---\ndescription: I work in the morning\nupdated: 2026-08-02\n---\n\nThe press is cold until ten.\n",
  [`${ROOT}/conversations/conv-1.json`]:
    '{\n  "id": "conv-1",\n  "ownerId": "owner-1",\n  "catalog": null,\n  "messages": []\n}\n',
  [`${ROOT}/export-manifest.json`]: `${JSON.stringify({
    format: "ghost-home/v1",
    exportedAt: "2026-08-20T12:00:00.000Z",
    ghostname: "casper",
    appVersion: "test",
    source: "browser-local-replica",
    counts: {
      characterNotes: 1,
      notes: 2,
      archivedNotes: 0,
      memoryFiles: 1,
      conversations: 1,
    },
    derived: [],
    pathRewrites: { "casper/notes/estate-finances.md": "notes/Estate & finances.md" },
    notIncluded: [],
  }, null, 2)}\n`,
};

function zipArchive(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[path] = strToU8(text);
  return zipSync(entries);
}

let workspace: { dir: string; cleanup(): Promise<void> };
let zipPath: string;

beforeEach(async () => {
  workspace = await createTempDir();
  zipPath = join(workspace.dir, "casper-ghost-home.zip");
  await writeFile(zipPath, zipArchive(ARCHIVE));
});

afterEach(async () => {
  await workspace.cleanup();
});

describe("importGhostArchive", () => {
  it("lands a zip as a readable ghost home", async () => {
    const ghostsRoot = join(workspace.dir, "Ghosts");
    const result = await importGhostArchive(zipPath, ghostsRoot);

    expect(result.ghostName).toBe("casper");
    expect(result.dir).toBe(join(ghostsRoot, "casper"));
    expect(result.manifest.format).toBe("ghost-home/v1");
    expect(result.filesWritten).toBe(Object.keys(ARCHIVE).length);

    const home = result.home;
    expect((await home.readCharacter())?.title).toBe("Casper");

    const { docs } = await home.listDocs();
    expect(docs.map((doc) => doc.path))
      .toEqual(["craft/paper-notes.md", "estate-finances.md"]);
    // The pre-sanitization app path survives the round trip.
    expect(docs.find((doc) => doc.path === "estate-finances.md")?.appPath)
      .toBe("Estate & finances");

    const memory = await home.listMemory();
    expect(deriveMemoryIndex(memory.files).lines)
      .toEqual(["- working-habit.md: I work in the morning"]);

    expect(await home.listConversations()).toEqual(["conv-1"]);
    expect((await home.readExportManifest())?.["ghostname"]).toBe("casper");
  });

  it("preserves file bytes while translating legacy notes paths to docs", async () => {
    const ghostsRoot = join(workspace.dir, "Ghosts");
    const { dir } = await importGhostArchive(zipPath, ghostsRoot);
    for (const [path, text] of Object.entries(ARCHIVE)) {
      const relative = path.slice(`${ROOT}/`.length).replace(/^notes\//, "docs/");
      const landed = join(dir, relative);
      expect(await readFile(landed, "utf8"), path).toBe(text);
    }
  });

  it("rejects an archive where legacy notes and canonical docs collide", async () => {
    const collision = join(workspace.dir, "collision.zip");
    await writeFile(collision, zipArchive({
      ...ARCHIVE,
      [`${ROOT}/docs/estate-finances.md`]: "different bytes",
    }));
    await expect(importGhostArchive(collision, join(workspace.dir, "Ghosts")))
      .rejects.toMatchObject({ code: "invalid_format" });
  });

  it("imports an already-extracted directory the same way", async () => {
    const extracted = join(workspace.dir, "extracted");
    await writeFileTree(extracted, ARCHIVE);
    const fromRoot = await importGhostArchive(
      extracted,
      join(workspace.dir, "GhostsA"),
    );
    expect(fromRoot.filesWritten).toBe(Object.keys(ARCHIVE).length);

    // …and when the directory handed over *is* the archive root.
    const fromInside = await importGhostArchive(
      join(extracted, ROOT),
      join(workspace.dir, "GhostsB"),
    );
    expect(fromInside.ghostName).toBe("casper");
    expect((await fromInside.home.readCharacter())?.title).toBe("Casper");
  });

  it("honours an explicit ghost name", async () => {
    const result = await importGhostArchive(zipPath, join(workspace.dir, "Ghosts"), {
      name: "casper-2",
    });
    expect(result.home.name).toBe("casper-2");
  });

  it("refuses to import into a non-empty ghost home unless told to", async () => {
    const ghostsRoot = join(workspace.dir, "Ghosts");
    await importGhostArchive(zipPath, ghostsRoot);
    await expect(importGhostArchive(zipPath, ghostsRoot))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(importGhostArchive(zipPath, ghostsRoot, { overwrite: true }))
      .resolves.toMatchObject({ ghostName: "casper" });
  });

  it("rejects an archive that is not ghost-home/v1", async () => {
    const wrong = join(workspace.dir, "wrong.zip");
    await writeFile(wrong, zipArchive({
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
    }));
    await expect(importGhostArchive(wrong, join(workspace.dir, "Ghosts")))
      .rejects.toMatchObject({ code: "invalid_format" });
  });

  it("rejects an archive with no manifest", async () => {
    const bare = join(workspace.dir, "bare.zip");
    await writeFile(bare, zipArchive({ [`${ROOT}/character.md`]: "hello" }));
    await expect(importGhostArchive(bare, join(workspace.dir, "Ghosts")))
      .rejects.toThrow(GhostError);
  });

  it("refuses an entry that escapes the ghost home", async () => {
    const evil = join(workspace.dir, "evil.zip");
    await writeFile(evil, zipArchive({
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v1","ghostname":"casper"}',
      [`${ROOT}/../../pwned.md`]: "no",
    }));
    await expect(importGhostArchive(evil, join(workspace.dir, "Ghosts")))
      .rejects.toMatchObject({ code: "invalid_path" });
  });

  it("ignores macOS zip cruft", async () => {
    const noisy = join(workspace.dir, "noisy.zip");
    await writeFile(noisy, zipArchive({
      ...ARCHIVE,
      "__MACOSX/._casper": "",
      [`${ROOT}/.DS_Store`]: "",
    }));
    const result = await importGhostArchive(noisy, join(workspace.dir, "Ghosts"));
    expect(result.ignored).toContain("__MACOSX/._casper");
    expect(result.filesWritten).toBe(Object.keys(ARCHIVE).length);
  });

  it("reports a missing source", async () => {
    await expect(importGhostArchive(join(workspace.dir, "nope.zip"), workspace.dir))
      .rejects.toMatchObject({ code: "not_found" });
  });
});
