import { join } from "node:path";
import { CHARACTER_FILENAME, buildGhostSystemPrompt as sharedPrompt, type GhostSystemPromptInput as SharedPromptInput } from "@ghost/runtime/persona";

export interface GhostSystemPromptInput extends Omit<SharedPromptInput, "characterPath"> {
  readonly homeDir: string;
}

export function buildGhostSystemPrompt(input: GhostSystemPromptInput): string {
  return sharedPrompt({ ...input, characterPath: join(input.homeDir, CHARACTER_FILENAME) });
}
