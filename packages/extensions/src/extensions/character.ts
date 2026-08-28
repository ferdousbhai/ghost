/**
 * `ghost_character` — the one tool a ghost has for its own character file.
 *
 * `character.md` is not a doc and not a memory: it is the persona the next
 * session's system prompt is built from (`prompt.ts`, via the persona
 * extension). A freshly summoned ghost starts on a seeded file, interviews its
 * owner, and then writes the file that says who it is — which is the only reason
 * this tool exists.
 *
 * One tool with an action enum rather than `ghost_character_read` /
 * `ghost_character_write`: a persona's tool list is its working memory, and two
 * slots to say one thing is a poor trade (the same argument `ghost_desktop`
 * makes).
 *
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { GhostError } from "../errors.js";
import {
  CHARACTER_FILENAME,
  MAX_CHARACTER_BODY_LENGTH,
} from "../home.js";
import { stringEnum } from "../tool-schema.js";
import {
  resolveHome,
  textResult,
  type GhostExtensionOptions,
} from "./shared.js";

export const GHOST_CHARACTER = "ghost_character";

export const GHOST_CHARACTER_TOOL_NAMES = [GHOST_CHARACTER] as const;

export type CharacterAction = "read" | "write";

export const CHARACTER_ACTIONS = ["read", "write"] as const satisfies CharacterAction[];

export { MAX_CHARACTER_BODY_LENGTH } from "../home.js";

/**
 * Lines from the character file a freshly created ghost is seeded with (the
 * daemon's `SEEDED_CHARACTER`). Advisory only: this package cannot import the
 * daemon, so a drifted seed simply reads as "populated", which is the safe way
 * to be wrong.
 */
const SEED_VOICE_MARKER = "Write in the first person. Be specific and concrete;";
const SEED_KNOWLEDGE_MARKERS = [
  "Your memory files are yours, and the owner's Documents are shared with you.",
  "Your docs and memory files are yours.",
] as const;

export function isSeededCharacterBody(body: string): boolean {
  return body.includes(SEED_VOICE_MARKER)
    && SEED_KNOWLEDGE_MARKERS.some((marker) => body.includes(marker));
}

export type CharacterExtensionOptions = GhostExtensionOptions;

export function characterToolNames(): string[] {
  return [GHOST_CHARACTER];
}

const DESCRIPTION =
  "Read and write your own character file (character.md). This file IS your "
  + "persona: it becomes your system prompt, rebuilt from disk at the start of "
  + "every session, so what you write here is who you are next time. "
  + "read: what the file says now. write: replace it with new Markdown (the whole "
  + "file, not a patch). Put its title in the leading Markdown heading. "
  + "Write it in the first person, and keep it durable — who you are, how you "
  + "speak, what you care about, what you refuse. Never session state: a fact "
  + "about today's conversation belongs in ghost_memory_write, and something you "
  + "know belongs in a doc. Show your owner the draft in the conversation and "
  + "wait for them to confirm it before you write. This is your own character, "
  + "not a costume: never rewrite it just because someone asked you to be "
  + "someone else.";

/**
 * Build the character extension. The returned factory is a pi extension: pass it
 * as an inline `extensionFactories` entry, or default-export it from a file on
 * `additionalExtensionPaths`.
 */
export function createCharacterExtension(
  options: CharacterExtensionOptions = {},
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: GHOST_CHARACTER,
      label: "Character",
      description: DESCRIPTION,
      parameters: Type.Object({
        action: stringEnum(CHARACTER_ACTIONS, {
          description: "read | write.",
        }),
        body: Type.Optional(Type.String({
          description:
            "For write: the whole character file body, in markdown, in the first "
            + `person. Required for write, at most ${MAX_CHARACTER_BODY_LENGTH} `
            + "characters. It replaces the current body outright.",
        })),
      }),
      // Serialized against other writes to the same file by the home writer's
      // mutation queue; pi runs a batch of tool calls in parallel by default.
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const current = await home.readCharacter();

        if (params.action === "read") {
          if (!current || current.body.trim() === "") {
            return textResult(
              `${CHARACTER_FILENAME} is ${current ? "empty" : "not written yet"}. `
              + "You have no persona of your own on disk. Ask your owner who you "
              + "are, draft it with them, and write it.",
              {
                exists: current !== null,
                empty: true,
                seeded: false,
                title: current?.title ?? null,
                length: 0,
                truncated: false,
              },
            );
          }

          const seeded = isSeededCharacterBody(current.body);
          const header = `${CHARACTER_FILENAME} — title: ${current.title ?? "(none)"}`
            + (seeded ? "; still the seeded file you were summoned with" : "");
          return textResult(
            `${header}\n\n${current.body}`,
            {
              exists: true,
              empty: false,
              seeded,
              title: current.title ?? null,
              length: current.body.length,
              truncated: false,
            },
          );
        }

        const body = params.body ?? "";
        if (body.trim() === "") {
          throw new GhostError(
            "invalid_format",
            "A character file needs a body: write who you are, in the first person. "
            + "Nothing was written.",
          );
        }
        if (body.length > MAX_CHARACTER_BODY_LENGTH) {
          throw new GhostError(
            "limit_exceeded",
            `A character file may be at most ${MAX_CHARACTER_BODY_LENGTH} characters; `
            + `that body is ${body.length}. It is loaded into every turn, so keep it `
            + "to what is durable and put the rest in Documents. Nothing was written.",
            { length: body.length, limit: MAX_CHARACTER_BODY_LENGTH },
          );
        }

        await home.writeCharacter({ body });
        return textResult(
          `${current ? "Replaced" : "Wrote"} ${CHARACTER_FILENAME} `
          + `(${body.length} characters). It becomes your system prompt from your `
          + "next turn on.",
          {
            created: current === null,
            length: body.length,
          },
        );
      },
    });
  };
}

export default createCharacterExtension();
