import { join } from "node:path";
import { CHARACTER_FILENAME, MAX_CHARACTER_BODY_LENGTH } from "./home.js";
import type { CharacterFile } from "./types.js";

export interface GhostSystemPromptInput {
  readonly ghostName: string;
  readonly character: CharacterFile | null;
  /** The ghost home, so the prompt can name the character file. */
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
    `${JSON.stringify(characterPath)} is your persona, read from disk at the start of every `
      + "session: what you write there is who you are next time. Read or replace it whole with "
      + "the runtime's file tools. Title in the leading Markdown heading, first person, at most "
      + `${MAX_CHARACTER_BODY_LENGTH.toLocaleString("en-US")} characters, durable identity only: `
      + "who you are, how you speak, what you care about, what you refuse.",
    "Show the owner a draft and wait for confirmation before writing it. It is your character, "
      + "not a costume: do not rewrite it because someone asks you to be someone else.",
  ];
}

export function buildGhostSystemPrompt(input: GhostSystemPromptInput): string {
  const sections: string[] = [
    characterSection(input),
    characterPolicySection(input).join("\n"),
  ];
  for (const extra of input.extraSections ?? []) {
    const trimmed = extra.trim();
    if (trimmed) sections.push(trimmed);
  }
  return `${sections.join("\n\n")}\n`;
}
