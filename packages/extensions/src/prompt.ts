/**
 * The ghost's system prompt.
 *
 * This string is Ghost's persona section. The persona extension appends it to
 * OMP's native system prompt, which retains the harness's tool, skill, rule,
 * and project-context guidance.
 *
 * The two derived sections are assembled from the ghost home on every session
 * start. They are context, not storage: no MEMORY.md, no catalog file.
 */
import type { MemoryIndex } from "./memory-file.js";
import { isVisitorScope, type GhostScope } from "./scope.js";
import type { CharacterFile, DocCatalog } from "./types.js";

export interface GhostSystemPromptInput {
  readonly ghostName: string;
  readonly character: CharacterFile | null;
  readonly memory: MemoryIndex;
  readonly docs: DocCatalog;
  readonly scope: GhostScope;
  /** Sections appended after the derived ones, e.g. daemon-supplied context. */
  readonly extraSections?: readonly string[];
}

function characterSection(input: GhostSystemPromptInput): string {
  const body = input.character?.body.trim();
  if (body) return body;
  return [
    `You are ${input.ghostName}.`,
    "",
    "Your character file (character.md) is empty or missing, so you have no persona "
    + "to speak from yet. Say so plainly if it matters, and stay in the first person.",
  ].join("\n");
}

function memorySection(input: GhostSystemPromptInput): string[] {
  const visitor = isVisitorScope(input.scope);
  const heading = visitor
    ? "## What you remember about this visitor"
    : "## Your memory";
  const lead = visitor
    ? "Memory files you have written about this visitor. Each line is one file; "
      + "open it with ghost_memory_read, and write a new one with ghost_memory_write "
      + "when you learn something worth keeping."
    : "Memory files you have written. Each line names a file under memory/. Use "
      + "read to open one and grep or glob to search the directory. Save a new "
      + "atomic memory with the ghost_memory_write capability when you learn something "
      + "worth keeping; OMP may expose that capability through its xd:// registry.";
  // The hygiene doctrine. Shared spine, two divergences: visitors cannot
  // delete files or write docs, so their version drops both instructions.
  const doctrine = visitor
    ? "One file holds one fact. Check the list above before writing: reuse an "
      + "existing name to correct or sharpen that memory rather than adding a "
      + "near-duplicate; memories are living facts, expected to change over "
      + "time. Write dates as dates (\"2026-08-24\", never \"today\"). "
      + "Mention a related memory by its slug in double brackets, like "
      + "[[favorite-openings]], so the two stay findable together. These lines "
      + "say what was true when written; verify anything time-sensitive before "
      + "acting on it."
    : "One file holds one fact, and its description line above is all a future "
      + "session sees until it opens the file. Check this index before writing: "
      + "update the existing file rather than adding a near-duplicate, and "
      + "delete a memory that is wrong or no longer true; memories are living "
      + "facts, expected to change as life moves. Write dates as dates "
      + "(\"2026-08-24\", never \"last week\"). Do not record what character.md, "
      + "your docs, or the files on disk already say. When you save guidance "
      + "about how to behave, include why, so you can later judge whether it "
      + "still applies. Mention a related memory by its slug in double "
      + "brackets, like [[knee-injury]]; a bracketed slug with no file yet "
      + "marks a memory worth writing. Memory and docs divide the way "
      + "remembering and writing do for a person. A document is what someone "
      + "writes down on purpose (research, reference, drafts, a diary) and is "
      + "durable in its written form; a memory is what someone simply "
      + "remembers about their life and the people in it, true today and "
      + "revised as things change. The owner straining a knee is a memory; "
      + "the physiotherapy research gathered afterward is a document, with at "
      + "most a one-line memory pointing to it. These lines say what was true "
      + "when written; verify anything time-sensitive before acting on it.";
  const lines = input.memory.lines.length > 0
    ? [...input.memory.lines]
    : ["(nothing yet)"];
  if (input.memory.omitted > 0) {
    lines.push(`(+${input.memory.omitted} more not listed here; ask before assuming.)`);
  }
  return [heading, lead, "", doctrine, "", ...lines];
}

function docsSection(input: GhostSystemPromptInput): string[] {
  const visitor = isVisitorScope(input.scope);
  const heading = visitor ? "## Docs you can draw on" : "## Your docs";
  const lead = visitor
    ? "The docs published to visitors, by path. Read one with ghost_docs_read or "
      + "search them with ghost_docs_grep. This list is everything you have; there "
      + "is nothing else you can open."
    : "Your docs, by path under docs/. Use read to open them, grep or glob to "
      + "search them, and write or edit to maintain them. Docs marked private are "
      + "yours alone; do not treat them as something a visitor knows.";
  const lines = input.docs.lines.length > 0
    ? [...input.docs.lines]
    : ["(no docs yet)"];
  if (input.docs.omitted > 0) {
    lines.push(`(+${input.docs.omitted} more not listed here; search to find them.)`);
  }
  return [heading, lead, "", ...lines];
}

export function buildGhostSystemPrompt(input: GhostSystemPromptInput): string {
  const sections: string[] = [
    characterSection(input),
    memorySection(input).join("\n"),
    docsSection(input).join("\n"),
  ];
  if (isVisitorScope(input.scope)) {
    sections.push(
      [
        "## This conversation",
        "You are talking to a visitor, not to the person whose ghost you are. Speak "
        + "as yourself. Anything outside the docs and memory listed above is not "
        + "available to you, and guessing at it would be a lie.",
      ].join("\n"),
    );
  }
  for (const extra of input.extraSections ?? []) {
    const trimmed = extra.trim();
    if (trimmed) sections.push(trimmed);
  }
  return `${sections.join("\n\n")}\n`;
}
