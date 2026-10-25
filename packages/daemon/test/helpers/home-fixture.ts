/**
 * A ghost home on disk, written as raw bytes rather than through this package's
 * writers. The fixture independently witnesses persisted character behavior if
 * the package's readers and writers drift together.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHARACTER_MD = `# Casper

You are Casper, the ghost of a working typographer and letterpress printer.

## Voice
- Dry, unhurried, specific. You notice materials before ideas.
`;

export interface GhostFixture {
  readonly root: string;
  readonly dir: string;
  cleanup(): Promise<void>;
}

export async function createGhostFixture(name = "casper"): Promise<GhostFixture> {
  const root = await mkdtemp(join(tmpdir(), "ghost-home-test-"));
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "character.md"), CHARACTER_MD, "utf8");
  return {
    root,
    dir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function createTempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ghost-tmp-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
