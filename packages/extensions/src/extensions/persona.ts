import type { GhostExtensionAPI, GhostExtensionFactory } from "../extension-api.js";
import { buildGhostSystemPrompt } from "../prompt.js";
import { resolveHome, type GhostExtensionOptions } from "./shared.js";

export interface PersonaExtensionOptions extends GhostExtensionOptions {
  readonly ghostName?: string;
  readonly extraSections?: readonly string[];
}

export function createPersonaExtension(
  options: PersonaExtensionOptions = {},
): GhostExtensionFactory {
  return (pi: GhostExtensionAPI) => {
    // pi fires `before_agent_start` once per turn, but the character file is
    // session-start state: deriving it again mid-conversation only rewrites a
    // prompt prefix the model has already read. One registration is one
    // session, so this closure is the session's scope. Live truth stays on
    // disk, where the native file tools read it.
    let sessionPrompt: string | undefined;
    pi.on("before_agent_start", async (_event, ctx) => {
      const home = resolveHome(options, ctx);
      if (sessionPrompt === undefined) {
        sessionPrompt = buildGhostSystemPrompt({
          ghostName: options.ghostName ?? home.name,
          character: await home.readCharacter(),
          homeDir: home.dir,
          ...(options.extraSections === undefined
            ? {}
            : { extraSections: options.extraSections }),
        });
      }
      return { systemPrompt: [sessionPrompt] };
    });
  };
}
