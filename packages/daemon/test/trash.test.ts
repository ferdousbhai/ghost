import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trashPath } from "../src/trash.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ghostd-trash-"));
  env = { PATH: process.env.PATH, HOME: root, XDG_DATA_HOME: join(root, "data") };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("trashPath", () => {
  it("moves a directory into the freedesktop Trash with a restorable .trashinfo, suffixing a second copy", async () => {
    for (const _ of [1, 2]) {
      mkdirSync(join(root, "casper"));
      writeFileSync(join(root, "casper", "keepsake.md"), "remember this\n");
      await trashPath(join(root, "casper"), env);
      expect(existsSync(join(root, "casper"))).toBe(false);
    }
    const trash = join(root, "data", "Trash");
    expect(readFileSync(join(trash, "files", "casper", "keepsake.md"), "utf8")).toBe("remember this\n");
    expect(existsSync(join(trash, "files", "casper.2"))).toBe(true);
    expect(readFileSync(join(trash, "info", "casper.trashinfo"), "utf8")).toContain(`Path=${join(root, "casper")}\n`);
  });

  it("says nothing was deleted when gio cannot trash the path", async () => {
    await expect(trashPath(join(root, "missing"), env))
      .rejects.toMatchObject({ code: "trash_failed", message: expect.stringContaining("nothing was deleted") });
  });
});
