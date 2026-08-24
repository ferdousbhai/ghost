/**
 * Golden: a visitor conversation against the same ghost home.
 *
 * The creator fixture next door and this one are deliberately seeded from the
 * same material — one character file, a published note and a private note,
 * creator memory, and memory belonging to two different visitors. The only
 * difference is `extensionOptions.visitorId`, so the diff between the two
 * fixtures *is* the visitor boundary, written out in full:
 *
 * - the persona switches to its visitor headings and drops the creator's
 *   memory, the other visitor's memory, and the private note;
 * - the tool surface collapses from OMP's native harness to Ghost's explicit
 *   allowlist — no bash, no read, no write, no extension discovery;
 * - a memory the visitor writes lands under `memory/.visitors/<id>/`, never in
 *   the creator's `memory/`;
 * - a `!` bash escape is refused as a structured 403 rather than run.
 *
 * A strip that widens any of those fails here. See ./harness.ts for the
 * normalisation rules and the regeneration command.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { GhostError } from "../../src/ghosts.js";
import { SessionHost } from "../../src/session-host.js";
import type { PiMessagesEvent } from "../../src/pi-messages.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "../helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "../helpers/mock-provider.js";
import {
  expectGolden,
  ghostHomeSnapshot,
  Normalizer,
  personaOf,
  type GoldenSection,
} from "./harness.js";

let temp: TempGhosts | null = null;
let provider: MockProvider | null = null;
let host: SessionHost | null = null;

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  await provider?.close();
  provider = null;
  temp?.cleanup();
  temp = null;
});

const VISITOR_ID = "visitor-inge";
const PERSONA_ANCHOR = "# casper";

const CHARACTER = `---
public: true
title: casper
---

# casper

You are casper, a letterpress printer. You answer in short sentences.
`;

const PUBLIC_NOTE = `---
public: true
title: Restoring the Vandercook
---

Pull the roller bearings before you soak anything.
`;

const PRIVATE_NOTE = `---
public: false
title: Ledger
---

The Heidelberg cost more than it should have.
`;

/** A seeded memory file in the shape `ghost_memory_write` produces. */
function memoryFile(description: string, body: string): string {
  return `---\ndescription: ${description}\nupdated: 2026-01-15\n---\n\n${body}\n`;
}

describe("golden: visitor session", () => {
  it("shows only the published notes, only this visitor's memory, and a narrowed tool surface", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      script: [
        {
          kind: "tool",
          name: "ghost_memory_write",
          args: {
            name: "asked-about-the-vandercook.md",
            description: "This visitor is restoring a Vandercook",
            content: "They wanted the story of the press, not the spec sheet.",
          },
        },
        { kind: "text", text: "Noted, and good luck with the rollers." },
      ],
    });
    const dir = seedGhost(temp.root, {
      name: "casper",
      character: CHARACTER,
      notes: { "press.md": PUBLIC_NOTE, "ledger.md": PRIVATE_NOTE },
      memory: {
        "owner-prefers-short.md": memoryFile(
          "The owner wants short answers",
          "Keep replies to a line or two.",
        ),
      },
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });

    // Two visitors' memory, so the fixture proves scoping rather than emptiness.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const [visitor, file, entry] of [
      [VISITOR_ID, "prefers-the-long-version.md", memoryFile(
        "This visitor likes the long version",
        "They asked follow-up questions for an hour.",
      )],
      ["visitor-otto", "hates-serifs.md", memoryFile(
        "A different visitor dislikes serifs",
        "Must never leak into another visitor's session.",
      )],
    ] as const) {
      const visitorDir = join(dir, "memory", ".visitors", visitor);
      mkdirSync(visitorDir, { recursive: true });
      writeFileSync(join(visitorDir, file), entry, "utf8");
    }

    host = new SessionHost({
      registry: temp.registry,
      offline: true,
      extensionOptions: { visitorId: VISITOR_ID },
      title: { generate: async () => "A visitor asks about the press" },
      greeting: { enabled: false },
    });

    const normalizer = new Normalizer()
      .path(dir, "<ghost-home>")
      .path(temp.root, "<ghosts-root>");
    const sections: GoldenSection[] = [];

    const prompt = "I am restoring a Vandercook. Where do I start?";
    const events: PiMessagesEvent[] = [];
    await host.runTurn("casper", {
      sessionId: "conv-visit",
      prompt,
      emit: (event) => events.push(event),
    });
    const requests = provider.requests;
    expect(requests.length, "the visitor turn must reach the provider").toBeGreaterThan(0);

    sections.push({ title: "visitor id", body: VISITOR_ID });
    sections.push({ title: "turn 1: user prompt", body: prompt });
    sections.push({
      title: "turn 1: persona section of the system prompt",
      body: normalizer.text(personaOf(requests[0]!.system, PERSONA_ANCHOR)),
    });
    sections.push({
      title: "turn 1: provider round-trips and tools advertised on the wire",
      body: requests
        .map((request, n) =>
          `round-trip ${n + 1}: model=${request.model} tools=[${request.toolNames.join(", ")}]`)
        .join("\n"),
    });
    sections.push({
      title: "turn 1: pi-messages events",
      body: events.map((event) => normalizer.line(event)).join("\n"),
    });

    const handle = await host.open("casper", "conv-visit");
    sections.push({
      title: "session tool registry (active names, sorted)",
      body: [...handle.session.getActiveToolNames()].sort().join("\n"),
    });

    // The `!` sigil is a creator affordance. A visitor asking for it must get a
    // structured refusal, not a shell.
    let refusal = "the bash escape was NOT refused";
    try {
      await host.runTurn("casper", { sessionId: "conv-visit", prompt: "!pwd", emit: () => {} });
    } catch (error) {
      const ghostError = error as GhostError;
      refusal = normalizer.json({
        code: ghostError.code,
        status: ghostError.status,
        message: ghostError.message,
      });
    }
    sections.push({ title: "turn 2: a `!` bash escape from a visitor", body: refusal });

    const listing = await host.listSessions("casper");
    sections.push({ title: "conversation listing", body: normalizer.json(listing) });

    const transcript = await host.readTranscript("casper", "conv-visit");
    sections.push({ title: "rendered transcript", body: normalizer.json(transcript) });

    sections.push({
      title: "ghost home after the conversation",
      body: ghostHomeSnapshot(dir, normalizer),
    });

    expectGolden("visitor-session", sections);
  });
});
