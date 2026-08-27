import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyDocumentsPlacementCommand,
  placeLegacyDocuments,
} from "../src/legacy-documents-placement.js";

const roots: string[] = [];

function fixture(): {
  root: string;
  source: string;
  documents: string;
  outside: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ghost-legacy-documents-"));
  roots.push(root);
  const source = join(root, "legacy", "docs");
  const documents = join(root, "Documents");
  const outside = join(root, "outside");
  mkdirSync(source, { recursive: true });
  mkdirSync(documents);
  mkdirSync(outside);
  return { root, source, documents, outside };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy Documents placement", () => {
  it("defaults the command to a deterministic read-only dry run", async () => {
    const { source, documents } = fixture();
    mkdirSync(join(source, "folder"));
    writeFileSync(join(source, "folder", "note.md"), "legacy\n");
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(legacyDocumentsPlacementCommand([
      "--source", source,
      "--documents-root", documents,
    ], {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    })).resolves.toBe(0);

    expect(stdout.join("")).toContain('would place "folder/note.md"');
    expect(stdout.join("")).toContain("no destination changes");
    expect(stderr).toEqual([]);
    expect(existsSync(join(documents, "folder"))).toBe(false);
    expect(readFileSync(join(source, "folder", "note.md"), "utf8")).toBe("legacy\n");
  });

  it("places nested files without removing sources and preserves file metadata", async () => {
    const { source, documents } = fixture();
    const sourceDirectory = join(source, "folder");
    const sourceFile = join(sourceDirectory, "note.md");
    mkdirSync(sourceDirectory);
    writeFileSync(sourceFile, "legacy bytes\n");
    chmodSync(sourceFile, 0o640);
    const timestamp = new Date("2024-02-03T04:05:06.000Z");
    utimesSync(sourceFile, timestamp, timestamp);
    const before = statSync(sourceFile);

    const result = await placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
      dryRun: false,
    });

    const destination = join(documents, "folder", "note.md");
    const sourceAfter = statSync(sourceFile);
    const destinationStats = statSync(destination);
    expect(result).toMatchObject({ dryRun: false, placed: 1 });
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["folder/note.md"]);
    expect(readFileSync(destination, "utf8")).toBe("legacy bytes\n");
    expect(sourceAfter.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(sourceAfter.atimeMs).toBe(before.atimeMs);
    expect(sourceAfter.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(sourceFile, "utf8")).toBe("legacy bytes\n");
    expect(destinationStats.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(Math.abs(destinationStats.mtimeMs - before.mtimeMs)).toBeLessThan(2);
    expect(readdirSync(join(documents, "folder"))).toEqual(["note.md"]);
  });

  it("refuses direct and ancestor destination symlinks without writing outside", async () => {
    const direct = fixture();
    writeFileSync(join(direct.source, "note.md"), "source");
    const directAlias = join(direct.root, "Documents-link");
    symlinkSync(direct.documents, directAlias);
    await expect(placeLegacyDocuments({
      sourceRoot: direct.source,
      documentsRoot: directAlias,
    })).rejects.toMatchObject({ code: "invalid_path" });
    expect(readdirSync(direct.documents)).toEqual([]);

    const ancestor = fixture();
    writeFileSync(join(ancestor.source, "note.md"), "source");
    const alias = join(ancestor.root, "alias");
    const realParent = join(ancestor.root, "real-parent");
    mkdirSync(join(realParent, "Documents"), { recursive: true });
    symlinkSync(realParent, alias);
    await expect(placeLegacyDocuments({
      sourceRoot: ancestor.source,
      documentsRoot: join(alias, "Documents"),
    })).rejects.toMatchObject({ code: "invalid_path" });
    expect(readdirSync(join(realParent, "Documents"))).toEqual([]);
  });

  it("refuses relative roots instead of resolving them against operator cwd", async () => {
    const { source, documents } = fixture();
    writeFileSync(join(source, "note.md"), "source");

    await expect(placeLegacyDocuments({
      sourceRoot: "relative/docs",
      documentsRoot: documents,
    })).rejects.toMatchObject({ code: "invalid_path" });
    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: "relative/Documents",
    })).rejects.toMatchObject({ code: "invalid_path" });
    expect(readdirSync(documents)).toEqual([]);
  });

  it("refuses a symlink destination parent and every existing final collision", async () => {
    const { source, documents, outside } = fixture();
    mkdirSync(join(source, "nested"));
    writeFileSync(join(source, "nested", "note.md"), "source");
    symlinkSync(outside, join(documents, "nested"));
    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
    })).rejects.toMatchObject({ code: "invalid_destination" });
    expect(readdirSync(outside)).toEqual([]);

    rmSync(join(documents, "nested"));
    mkdirSync(join(documents, "nested"));
    writeFileSync(join(documents, "nested", "note.md"), "existing");
    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
      dryRun: false,
    })).rejects.toMatchObject({ code: "collision" });
    expect(readFileSync(join(documents, "nested", "note.md"), "utf8")).toBe("existing");
    expect(readFileSync(join(source, "nested", "note.md"), "utf8")).toBe("source");
  });

  it("rejects source symlinks and special files before creating destinations", async () => {
    const linked = fixture();
    writeFileSync(join(linked.outside, "outside.md"), "outside");
    symlinkSync(join(linked.outside, "outside.md"), join(linked.source, "linked.md"));
    await expect(placeLegacyDocuments({
      sourceRoot: linked.source,
      documentsRoot: linked.documents,
      dryRun: false,
    })).rejects.toMatchObject({ code: "invalid_source" });
    expect(readdirSync(linked.documents)).toEqual([]);

    const special = fixture();
    execFileSync("mkfifo", [join(special.source, "blocking")]);
    await expect(placeLegacyDocuments({
      sourceRoot: special.source,
      documentsRoot: special.documents,
      dryRun: false,
    })).rejects.toMatchObject({ code: "invalid_source" });
    expect(readdirSync(special.documents)).toEqual([]);
  });

  it("detects a destination-parent race before publication and writes nowhere outside", async () => {
    const { source, documents, outside } = fixture();
    mkdirSync(join(source, "nested"));
    mkdirSync(join(documents, "nested"));
    const outsideTarget = join(outside, "target");
    const movedParent = join(outside, "moved-parent");
    mkdirSync(outsideTarget);
    writeFileSync(join(source, "nested", "note.md"), "source");

    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
      dryRun: false,
      probe: (stage) => {
        if (stage !== "before-publish") return;
        renameSync(join(documents, "nested"), movedParent);
        symlinkSync(outsideTarget, join(documents, "nested"));
      },
    })).rejects.toMatchObject({ code: "destination_escaped" });

    expect(readdirSync(movedParent)).toEqual([]);
    expect(readdirSync(outsideTarget)).toEqual([]);
    expect(readFileSync(join(source, "nested", "note.md"), "utf8")).toBe("source");
  });

  it("rejects an in-root foo-to-bar rename instead of publishing under the retained descriptor", async () => {
    const { source, documents } = fixture();
    mkdirSync(join(source, "foo"));
    mkdirSync(join(documents, "foo"));
    writeFileSync(join(source, "foo", "note.md"), "source");

    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
      dryRun: false,
      probe: (stage) => {
        if (stage === "before-publish") {
          renameSync(join(documents, "foo"), join(documents, "bar"));
        }
      },
    })).rejects.toMatchObject({ code: "destination_changed" });

    expect(readdirSync(join(documents, "bar"))).toEqual([]);
    expect(existsSync(join(documents, "foo"))).toBe(false);
    expect(readFileSync(join(source, "foo", "note.md"), "utf8")).toBe("source");
  });

  it("rejects a retained parent swapped for a recreated directory at the same logical name", async () => {
    const { source, documents } = fixture();
    mkdirSync(join(source, "foo"));
    mkdirSync(join(documents, "foo"));
    writeFileSync(join(source, "foo", "note.md"), "source");

    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
      dryRun: false,
      probe: (stage) => {
        if (stage !== "before-publish") return;
        renameSync(join(documents, "foo"), join(documents, "displaced-foo"));
        mkdirSync(join(documents, "foo"));
      },
    })).rejects.toMatchObject({ code: "destination_changed" });

    expect(readdirSync(join(documents, "foo"))).toEqual([]);
    expect(readdirSync(join(documents, "displaced-foo"))).toEqual([]);
    expect(readFileSync(join(source, "foo", "note.md"), "utf8")).toBe("source");
  });

  it("checks every nested logical component rather than only the retained leaf", async () => {
    const { source, documents } = fixture();
    mkdirSync(join(source, "foo", "nested"), { recursive: true });
    mkdirSync(join(documents, "foo", "nested"), { recursive: true });
    writeFileSync(join(source, "foo", "nested", "note.md"), "source");

    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
      dryRun: false,
      probe: (stage) => {
        if (stage === "before-publish") {
          renameSync(
            join(documents, "foo"),
            join(documents, "renamed-foo"),
          );
        }
      },
    })).rejects.toMatchObject({ code: "destination_changed" });

    expect(readdirSync(join(documents, "renamed-foo", "nested"))).toEqual([]);
    expect(readFileSync(join(source, "foo", "nested", "note.md"), "utf8")).toBe("source");
  });

  it("detects a post-publication in-root rename and removes the actual published inode", async () => {
    const { source, documents } = fixture();
    mkdirSync(join(source, "foo"));
    mkdirSync(join(documents, "foo"));
    writeFileSync(join(source, "foo", "note.md"), "source");

    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
      dryRun: false,
      probe: (stage) => {
        if (stage === "after-publish") {
          renameSync(join(documents, "foo"), join(documents, "bar"));
        }
      },
    })).rejects.toMatchObject({ code: "destination_changed" });

    expect(readdirSync(join(documents, "bar"))).toEqual([]);
    expect(existsSync(join(documents, "foo"))).toBe(false);
    expect(readFileSync(join(source, "foo", "note.md"), "utf8")).toBe("source");
  });

  it("rolls back earlier publications when a later file fails", async () => {
    const { source, documents } = fixture();
    mkdirSync(join(source, "folder"));
    writeFileSync(join(source, "folder", "a.md"), "a");
    writeFileSync(join(source, "folder", "b.md"), "b");

    await expect(placeLegacyDocuments({
      sourceRoot: source,
      documentsRoot: documents,
      dryRun: false,
      probe: (stage, relativePath) => {
        if (stage === "before-copy" && relativePath === "folder/b.md") {
          throw new Error("injected second-file failure");
        }
      },
    })).rejects.toThrow("injected second-file failure");

    expect(readdirSync(documents)).toEqual([]);
    expect(readFileSync(join(source, "folder", "a.md"), "utf8")).toBe("a");
    expect(readFileSync(join(source, "folder", "b.md"), "utf8")).toBe("b");
  });
});
