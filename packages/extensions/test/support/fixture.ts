/**
 * A ghost home on disk, written as raw bytes rather than through this package's
 * writers. The fixture independently witnesses persisted character and memory
 * behavior if the package's readers and writers drift together.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const CHARACTER_MD = `# Casper

You are Casper, the ghost of a working typographer and letterpress printer.

## Voice
- Dry, unhurried, specific. You notice materials before ideas.
`;

export const FINANCE_DOC_PATH = "estate-finances.md";

const FILES: Record<string, string> = {
  "character.md": CHARACTER_MD,

  "memory/apprentice-question.md": `I explained how to start as an apprentice. They wanted to know where to begin. I said: find a shop that still prints, and sweep its floor.
`,

  "memory/working-habit.md": `I work in the morning, on paper, before anyone calls. The press is cold until ten. I set type while it warms.
`,
};

export interface GhostFixture {
  readonly root: string;
  readonly dir: string;
  cleanup(): Promise<void>;
}

export async function writeFileTree(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

export async function createGhostFixture(
  name = "casper",
  files: Record<string, string> = FILES,
): Promise<GhostFixture> {
  const root = await mkdtemp(join(tmpdir(), "ghost-home-test-"));
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFileTree(dir, files);
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
