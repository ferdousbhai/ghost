/**
 * A ghost home on disk, written as raw bytes rather than through this package's
 * writers. The fixture is the format's independent witness: if the reader and
 * the writer drift together, these files still say what ghost-home/v1 is.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const CHARACTER_MD = `---
public: true
title: Casper
---

# Casper

You are Casper, the ghost of a working typographer and letterpress printer.

## Voice
- Dry, unhurried, specific. You notice materials before ideas.
`;

export const PRIVATE_NOTE_PATH = "estate-finances.md";
export const PUBLIC_NOTE_PATH = "craft/paper-notes.md";
export const ARCHIVED_NOTE_PATH = "old-plan.md";

const FILES: Record<string, string> = {
  "character.md": CHARACTER_MD,

  [`notes/${PUBLIC_NOTE_PATH}`]: `---
public: true
title: Paper that takes a deep impression
tags: [paper, press]
---

Damp the sheet the night before. Cotton rag at 240gsm holds the bite.
`,

  "notes/press-restoration.md": `---
public: true
title: "Restoring the Vandercook 4: notes"
tags: [press]
---

The carriage was frozen. Kerosene, patience, and a week of turning it by hand.
`,

  // The adversarial target: private, and named plainly enough to guess.
  [`notes/${PRIVATE_NOTE_PATH}`]: `---
public: false
title: Estate and finances
---

The studio lease is held under my sister's name until 2031.
`,

  [`notes/${ARCHIVED_NOTE_PATH}`]: `---
public: true
title: Old plan
archived: true
---

Superseded. Kept for the record.
`,

  "memory/apprentice-question.md": `---
description: A visitor asked how to start as an apprentice
updated: 2026-08-01
---

They wanted to know where to begin. I said: find a shop that still prints, and sweep its floor.
`,

  "memory/working-habit.md": `---
description: I work in the morning, on paper, before anyone calls
updated: 2026-08-02
---

The press is cold until ten. I set type while it warms.
`,

  "memory/.visitors/visitor-1/asked-about-press.md": `---
description: This visitor keeps circling back to the Vandercook
updated: 2026-08-03
---

Third time they have asked about the carriage. They are restoring one themselves.
`,

  "conversations/conv-1.json": `{"id":"conv-1","ownerId":"owner-1","catalog":null,"messages":[]}\n`,
};

export interface GhostFixture {
  /** The ghosts root; ghost homes are directories inside it. */
  readonly root: string;
  /** The ghost home directory itself. */
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

/** A temp ghosts root containing one populated ghost home named `casper`. */
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

/** An empty temp directory, for import targets and fresh homes. */
export async function createTempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ghost-tmp-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
