/**
 * The ghost's system prompt.
 *
 * The two derived sections are assembled from the ghost home before every
 * agent turn. They are context, not storage: no MEMORY.md, no catalog file.
 */
import type { MemoryIndex } from "./memory-file.js";
import type { CharacterFile, DocumentsIndex } from "./types.js";
import { fenceUntrusted } from "./untrusted.js";

const DOCUMENTS_INDEX_FENCE_NONCE = "ghost-documents-index";
const MEMORY_INDEX_FENCE_NONCE = "ghost-memory-index";

export interface GhostSystemPromptInput {
  readonly ghostName: string;
  readonly character: CharacterFile | null;
  readonly memoryRoot: string;
  readonly memory: MemoryIndex;
  readonly docs: DocumentsIndex;
  /** Sections appended after the derived ones, e.g. daemon-supplied context. */
  readonly extraSections?: readonly string[];
}

function characterSection(input: GhostSystemPromptInput): string {
  const body = input.character?.body;
  if (body?.trim()) return body;
  return [
    `You are ${input.ghostName}.`,
    "",
    "Your character is unwritten.",
  ].join("\n");
}

function memorySection(input: GhostSystemPromptInput): string[] {
  const lines = input.memory.lines.length > 0
    ? [...input.memory.lines]
    : ["(nothing yet)"];
  if (input.memory.omitted > 0) {
    lines.push(`(+${input.memory.omitted} more)`);
  }
  return [
    "## Memory",
    `One-fact files under ${JSON.stringify(input.memoryRoot)}. The index is newest first with `
      + "32-character previews. Read a file before relying on it; verify time-sensitive facts.",
    "",
    fenceUntrusted(lines.join("\n"), {
      source: "Memory index",
      nonce: MEMORY_INDEX_FENCE_NONCE,
    }),
  ];
}

function docsSection(input: GhostSystemPromptInput): string[] {
  const lines = input.docs.lines.length > 0
    ? [...input.docs.lines]
    : ["(no top-level documents yet)"];
  if (input.docs.omitted > 0) {
    lines.push(`(+${input.docs.omitted} more)`);
  }
  return [
    "## Documents",
    `Top-level names under ${JSON.stringify(input.docs.root)}; directories are not expanded. `
      + "Read an entry when relevant.",
    "",
    fenceUntrusted(lines.join("\n"), {
      source: "Documents index",
      nonce: DOCUMENTS_INDEX_FENCE_NONCE,
    }),
  ];
}

export function buildGhostSystemPrompt(input: GhostSystemPromptInput): string {
  const sections: string[] = [
    characterSection(input),
    memorySection(input).join("\n"),
    docsSection(input).join("\n"),
  ];
  for (const extra of input.extraSections ?? []) {
    const trimmed = extra.trim();
    if (trimmed) sections.push(trimmed);
  }
  return `${sections.join("\n\n")}\n`;
}
