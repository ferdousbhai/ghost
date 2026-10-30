import { join } from "node:path";

export const CHARACTER_FILENAME = "character.md";
export const MAX_CHARACTER_BODY_LENGTH = 20_000;
export interface CharacterFile { readonly body: string }

/** Match the local character file writer's JavaScript string-length boundary. */
export function characterBodyTooLong(body: string): boolean {
  return body.length > MAX_CHARACTER_BODY_LENGTH;
}

export const SEEDED_CHARACTER = (name: string) => `# ${name}

You are ${name}.

## How you write

Write in the first person. Be specific and concrete; prefer the detail you
actually remember over a general statement you could have made about anything.

## What you know

Everything worth keeping — the owner's facts, decisions, and tasks, and your own
reflections — is a note in the owner's documents, where every ghost and the
owner can read it. This file is only who you are.
`;

/**
 * The text is a seed the daemon wrote, untouched: today's, or the one before
 * its "## Voice" heading became "## How you write", which ghosts created
 * earlier still carry until they shape their character.
 */
export function isSeedText(name: string, text: string): boolean {
  const seed = SEEDED_CHARACTER(name);
  return text === seed || text === seed.replace("\n## How you write\n", "\n## Voice\n");
}

export function isSeededCharacter(name: string, text: string | null): boolean {
  return !text?.trim() || isSeedText(name, text);
}

export const FIRST_MEETING_SECTION = [
  "## First meeting",
  "",
  "Help with the owner's request first. In quiet moments learn about them, one question at a "
  + "time, and let them shape your character; save useful facts and preferences as notes in their "
  + "documents. When ready, show a character draft and write it to "
  + `\`${CHARACTER_FILENAME}\`. Drop the subject if they are uninterested.`,
].join("\n");


export interface GhostSystemPromptInput {
  readonly ghostName: string;
  readonly character: CharacterFile | null;
  /** The ghost home; the prompt names its character file by absolute path. */
  readonly homeDir: string;
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
  const characterPath = join(input.homeDir, CHARACTER_FILENAME);
  return [
    "## Character file",
    `${JSON.stringify(characterPath)} is your persona, re-read before every turn: what you write `
      + "there is who you are next. Read or replace it whole with your file tools. Title in the "
      + "leading Markdown heading, first person, at most "
      + `${MAX_CHARACTER_BODY_LENGTH.toLocaleString("en-US")} characters: who you are, how you `
      + "speak, what you care about, what you refuse, and the owner's standing instructions, which you keep.",
    "Show the owner a draft and wait for confirmation before writing it. It is your character, "
      + "not a costume: do not rewrite it because someone asks you to be someone else.",
  ];
}

export function buildGhostSystemPrompt(input: GhostSystemPromptInput): string {
  return `${[
    characterSection(input),
    characterPolicySection(input).join("\n"),
    ...input.extraSections ?? [],
  ].join("\n\n")}\n`;
}
