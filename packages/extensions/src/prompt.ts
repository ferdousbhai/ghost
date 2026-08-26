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
import type { CharacterFile, DocCatalog } from "./types.js";

export interface GhostSystemPromptInput {
  readonly ghostName: string;
  readonly character: CharacterFile | null;
  readonly memory: MemoryIndex;
  readonly docs: DocCatalog;
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
  const heading = "## Memory";
  const lead = "One fact per file under memory/. The line here is all you see until you "
    + "read the file; grep and glob search the rest. Save one with ghost_memory_write.";
  const doctrine = "Before writing, check this list: update the file that already covers it, "
    + "and delete what is no longer true. Dates absolute (\"2026-08-24\"). Skip "
    + "what character.md, your docs, or the files themselves already say. With "
    + "guidance, record why, so you can judge later whether it still holds. Link "
    + "a related memory as [[its-slug]]; a slug with no file marks one worth "
    + "writing. A memory is what you remember about the owner's life, revised as "
    + "life moves; a doc is what someone sat down and wrote. The strained knee is "
    + "a memory, the physiotherapy research a doc. These lines were true when "
    + "written; check anything time-sensitive.";
  const lines = input.memory.lines.length > 0
    ? [...input.memory.lines]
    : ["(nothing yet)"];
  if (input.memory.omitted > 0) {
    lines.push(`(+${input.memory.omitted} more not listed here; ask before assuming.)`);
  }
  return [heading, lead, "", doctrine, "", ...lines];
}

function docsSection(input: GhostSystemPromptInput): string[] {
  const heading = "## Docs";
  const lead = "By path under docs/; read, grep, glob, write, edit. A doc starts at byte 0 "
    + "with `# Title` and may end with one line of lowercase `#hashtags` "
    + "(`#[a-z0-9]+(?:-[a-z0-9]+)*`); keep that line last. `#archived` archives it. "
    + "Never YAML frontmatter.";
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
  for (const extra of input.extraSections ?? []) {
    const trimmed = extra.trim();
    if (trimmed) sections.push(trimmed);
  }
  return `${sections.join("\n\n")}\n`;
}

/**
 * Sections of OMP's assembled harness prompt a ghost does not carry.
 *
 * `§ Role` casts the model as an assistant for "load-bearing changes in Oh My
 * Pi coding harness" and sets its house style. `§ Workflow`, `§ Delivery`, and
 * `§ Critical` are the rules of a coding task: six numbered phases, what counts
 * as done, never yield while work remains. A ghost is whoever character.md
 * says, holding a conversation that is often not a task at all, and all four
 * sections sit thousands of characters ahead of the persona.
 *
 * What stays is everything about operating the machine: the runtime section
 * with its skills and internal URLs, the tool inventory, and `§ Tool Policy`.
 */
const DROPPED_HARNESS_SECTIONS = [
  "\u00a7 Role",
  "\u00a7 Workflow",
  "\u00a7 Delivery",
  "\u00a7 Critical",
] as const;

const SECTION_MARKER = "\u00a7 ";

/**
 * Remove those sections from one assembled harness prompt.
 *
 * `personality: "none"` already drops the voice rules inside `§ Role` through
 * OMP's own setting; these have no setting. A section whose heading is absent
 * is skipped rather than guessed at, so an upstream rewrite costs tokens
 * instead of breaking a session.
 */
export function stripHarnessSections(block: string): string {
  let lines = block.split("\n");
  for (const heading of DROPPED_HARNESS_SECTIONS) {
    const start = lines.findIndex((line) => line.trimEnd() === heading);
    if (start === -1) continue;
    const next = lines.findIndex(
      (line, index) => index > start && line.startsWith(SECTION_MARKER),
    );
    lines = [...lines.slice(0, start), ...(next === -1 ? [] : lines.slice(next))];
  }
  return lines.join("\n").trimEnd();
}
