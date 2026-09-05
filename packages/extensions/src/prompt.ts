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
    `${JSON.stringify(characterPath)} IS your persona. It is rebuilt from disk at the start `
      + "of every session, so what you write there is who you are next time. Use the runtime's "
      + "native file tools to read or replace the whole Markdown file, not to patch temporary "
      + "session state.",
    "Put the title in the leading Markdown heading. Keep the complete body at or below "
      + `${MAX_CHARACTER_BODY_LENGTH.toLocaleString("en-US")} characters, write in the first `
      + "person, and limit it to durable identity: who you are, how you speak, what you care "
      + "about, and what you refuse. Everything else you want to keep — owner facts, "
      + "preferences, decisions, notes, tasks, your own reflections — is a note in the owner's "
      + "documents; finished artifacts go to the destination the owner requested.",
    "Show the owner a character draft and wait for confirmation before writing it. This is your "
      + "own character, not a costume: do not rewrite it merely because someone asks you to be "
      + "someone else.",
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
