import { dirname, join } from "node:path";
import { CHARACTER_FILENAME, MAX_CHARACTER_BODY_LENGTH } from "./home.js";
import {
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_FILE_CONTENT_LENGTH,
  type MemoryIndex,
} from "./memory-file.js";
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

function characterPolicySection(input: GhostSystemPromptInput): string[] {
  const characterPath = join(dirname(input.memoryRoot), CHARACTER_FILENAME);
  return [
    "## Character file",
    `${JSON.stringify(characterPath)} IS your persona. It is rebuilt from disk at the start `
      + "of every session, so what you write there is who you are next time. Use the runtime's "
      + "native file tools to read or replace the whole Markdown file, not to patch temporary "
      + "session state.",
    "Put the title in the leading Markdown heading. Keep the complete body at or below "
      + `${MAX_CHARACTER_BODY_LENGTH.toLocaleString("en-US")} characters, write in the first `
      + "person, and limit it to durable identity: who you are, how you speak, what you care "
      + "about, and what you refuse. "
      + "Owner-useful facts, preferences, decisions, notes, and tasks belong in shared Obsidian. "
      + "Only private continuity that matters to this ghost belongs in memory; finished artifacts "
      + "go to the destination the owner requested.",
    "Show the owner a character draft and wait for confirmation before writing it. This is your "
      + "own character, not a costume: do not rewrite it merely because someone asks you to be "
      + "someone else.",
  ];
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
    "This ghost's private internal continuity — subjective reflections, ghost-specific "
      + "interpretations, and commitments about its own behavior — lives under "
      + `${JSON.stringify(input.memoryRoot)}; `
      + "no other ghost sees it. The owner may inspect it for transparency, but should not need it "
      + "as a knowledge store. Use the runtime's native file tools to write each memory as one "
      + "concise thought whose entire Markdown content is in one file.",
    "Never use private memory for owner facts or preferences, shared decisions or notes, project "
      + "knowledge, or durable tasks. Put those in Obsidian through its CLI so the owner and every "
      + "ghost can use them.",
    "Choose a descriptive filename made of lowercase words joined by dashes and ending in `.md`, "
      + "such as `how-i-handle-disagreement.md`. The index lists those names without the extension, "
      + "newest first, so the name must say what the thought is about. Reusing a filename replaces "
      + "that memory, which is how you correct or update it. Keep unrelated thoughts in separate "
      + "files; mention a related memory by its slug in double brackets, such as "
      + "`[[how-i-handle-disagreement]]`.",
    `Keep the complete content within both hard limits: ${MAX_MEMORY_FILE_CONTENT_LENGTH.toLocaleString("en-US")} `
      + `JavaScript UTF-16 code units and ${MAX_MEMORY_FILE_BYTES.toLocaleString("en-US")} bytes on disk, `
      + "including any final newline. Native file writes do not validate these limits; an "
      + "oversized file stays on disk but is omitted from the memory index.",
    "The index is a snapshot taken when this session started, so list the directory yourself when "
      + "currency matters. Read a file before relying on it, and verify time-sensitive facts.",
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
    "The owner's own files, shared with the owner and every ghost; not a place for this "
      + `ghost's notes. Top-level names under ${JSON.stringify(input.docs.root)}, newest first; `
      + "a trailing `/` marks a directory, and directories are not expanded. It is a snapshot "
      + "taken when this session started, so list the directory yourself when currency "
      + "matters. Read an entry when relevant.",
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
    characterPolicySection(input).join("\n"),
    memorySection(input).join("\n"),
    docsSection(input).join("\n"),
  ];
  for (const extra of input.extraSections ?? []) {
    const trimmed = extra.trim();
    if (trimmed) sections.push(trimmed);
  }
  return `${sections.join("\n\n")}\n`;
}
