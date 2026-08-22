import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importCommand, parseImportArgs } from "../src/import-command.js";

/**
 * A minimal, valid ghost-home/v1 archive as an extracted directory —
 * `importGhostArchive` accepts a directory or a zip, and a directory keeps the
 * daemon test free of a zip dependency.
 */
function makeArchiveDir(parent: string, ghostname: string): string {
  const dir = join(parent, `${ghostname}-archive`, ghostname);
  mkdirSync(join(dir, "memory"), { recursive: true });
  const manifest = { format: "ghost-home/v1", ghostname, exportedAt: "2026-08-22T00:00:00.000Z" };
  writeFileSync(join(dir, "export-manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "character.md"), "---\npublic: true\n---\n\nI am a ghost.\n");
  writeFileSync(join(dir, "memory", "tone.md"), "---\ndescription: tone\n---\n\nTerse.\n");
  return dir;
}

describe("parseImportArgs", () => {
  it("reads the source, name, overwrite, and root", () => {
    const args = parseImportArgs(["a.zip", "--name", "casper", "--overwrite", "--ghosts-root", "/g"]);
    expect(args.source).toBe("a.zip");
    expect(args.name).toBe("casper");
    expect(args.overwrite).toBe(true);
    expect(args.overrides.ghostsRoot).toBe("/g");
  });

  it("rejects a second positional and unknown flags", () => {
    expect(() => parseImportArgs(["a.zip", "b.zip"])).toThrow(/Unexpected argument/);
    expect(() => parseImportArgs(["--nope"])).toThrow(/Unknown option/);
  });
});

describe("importCommand", () => {
  let root: string;
  let out: string[];
  let err: string[];
  const io = () => ({ stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ghost-import-"));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("imports an archive into <ghostsRoot>/<name>", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "Ghosts");

    const code = await importCommand([archive, "--ghosts-root", ghostsRoot], io());

    expect(code).toBe(0);
    expect(out.join("")).toMatch(/Imported "casper"/);
    expect(readFileSync(join(ghostsRoot, "casper", "character.md"), "utf8")).toContain("I am a ghost.");
    expect(readFileSync(join(ghostsRoot, "casper", "memory", "tone.md"), "utf8")).toContain("Terse.");
  });

  it("--name overrides the archive's ghostname", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "Ghosts");

    const code = await importCommand([archive, "--name", "mildred", "--ghosts-root", ghostsRoot], io());

    expect(code).toBe(0);
    expect(readFileSync(join(ghostsRoot, "mildred", "character.md"), "utf8")).toContain("I am a ghost.");
  });

  it("refuses a non-empty home without --overwrite, then accepts it with", async () => {
    const archive = makeArchiveDir(root, "casper");
    const ghostsRoot = join(root, "Ghosts");
    mkdirSync(join(ghostsRoot, "casper"), { recursive: true });
    writeFileSync(join(ghostsRoot, "casper", "keep.md"), "existing");

    const refused = await importCommand([archive, "--ghosts-root", ghostsRoot], io());
    expect(refused).toBe(1);
    expect(err.join("")).toMatch(/already exists/);

    const accepted = await importCommand([archive, "--ghosts-root", ghostsRoot, "--overwrite"], io());
    expect(accepted).toBe(0);
  });

  it("fails cleanly on a missing archive", async () => {
    const code = await importCommand([join(root, "nope-archive"), "--ghosts-root", join(root, "Ghosts")], io());
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/import:/);
  });

  it("returns usage code 2 with no source", async () => {
    const code = await importCommand(["--ghosts-root", join(root, "Ghosts")], io());
    expect(code).toBe(2);
  });
});
