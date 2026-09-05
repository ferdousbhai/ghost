import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveDocumentsDirectory } from "../src/xdg-user-dirs.js";
import { createTempDir } from "./support/fixture.js";

let workspace: { dir: string; cleanup(): Promise<void> };

beforeEach(async () => {
  workspace = await createTempDir();
});

afterEach(async () => {
  await workspace.cleanup();
});

it("resolves the owner's documents directory the way the desktop does", async () => {
  expect(resolveDocumentsDirectory({ XDG_DOCUMENTS_DIR: "$HOME/Dokumente" }, "/home/someone"))
    .toBe("/home/someone/Dokumente");
  expect(resolveDocumentsDirectory({}, "/home/someone")).toBe("/home/someone/Documents");

  await mkdir(join(workspace.dir, ".config"), { recursive: true });
  await writeFile(
    join(workspace.dir, ".config", "user-dirs.dirs"),
    'XDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_DOCUMENTS_DIR="$HOME/Notes"\n',
  );

  // A systemd user unit inherits no XDG desktop variables, so the file decides.
  expect(resolveDocumentsDirectory({}, workspace.dir)).toBe(join(workspace.dir, "Notes"));
});
