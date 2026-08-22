/**
 * The ghost's system prompt.
 *
 * This string **replaces** pi's coding-agent prompt wholesale — the spike
 * confirmed that returning `systemPrompt` from `before_agent_start` leaves zero
 * bytes of the original (report §3). Nothing here should read like a coding
 * agent: no tool preambles about files and shells, no "you are pi".
 *
 * The two derived sections are assembled from the ghost home on every session
 * start. They are context, not storage: no MEMORY.md, no catalog file.
 */
import type { MemoryIndex } from "./memory-file.js";
import { isVisitorScope, type GhostScope } from "./scope.js";
import type { CharacterFile, NoteCatalog } from "./types.js";

export interface GhostSystemPromptInput {
  readonly ghostName: string;
  readonly character: CharacterFile | null;
  readonly memory: MemoryIndex;
  readonly notes: NoteCatalog;
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
    : "Memory files you have written. Each line is one file; open it with "
      + "ghost_memory_read, and write a new one with ghost_memory_write when you "
      + "learn something worth keeping.";
  const lines = input.memory.lines.length > 0
    ? [...input.memory.lines]
    : ["(nothing yet)"];
  if (input.memory.omitted > 0) {
    lines.push(`(+${input.memory.omitted} more not listed here; ask before assuming.)`);
  }
  return [heading, lead, "", ...lines];
}

function notesSection(input: GhostSystemPromptInput): string[] {
  const visitor = isVisitorScope(input.scope);
  const heading = visitor ? "## Notes you can draw on" : "## Your notes";
  const lead = visitor
    ? "The notes published to visitors, by path. Read one with ghost_notes_read or "
      + "search them with ghost_notes_grep. This list is everything you have; there "
      + "is nothing else you can open."
    : "Your notes, by path. Read one with ghost_notes_read or search them with "
      + "ghost_notes_grep. Notes marked private are yours alone — they are never "
      + "shown to visitors, so do not treat them as something a visitor knows.";
  const lines = input.notes.lines.length > 0
    ? [...input.notes.lines]
    : ["(no notes yet)"];
  if (input.notes.omitted > 0) {
    lines.push(`(+${input.notes.omitted} more not listed here; search to find them.)`);
  }
  return [heading, lead, "", ...lines];
}

export function buildGhostSystemPrompt(input: GhostSystemPromptInput): string {
  const sections: string[] = [
    characterSection(input),
    memorySection(input).join("\n"),
    notesSection(input).join("\n"),
  ];
  if (isVisitorScope(input.scope)) {
    sections.push(
      [
        "## This conversation",
        "You are talking to a visitor, not to the person whose ghost you are. Speak "
        + "as yourself. Anything outside the notes and memory listed above is not "
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
