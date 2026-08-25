/**
 * Golden: a conversation that writes a memory mid-session.
 *
 * Two turns through one hosted session against the scripted mock provider. The
 * model calls `ghost_memory_write` on turn one — the ideal golden tool: no
 * network, no clock, and its effect is a file on disk — and turn two's persona
 * must show that memory in the index, because the persona is rebuilt from the
 * ghost home before every agent start.
 *
 * The fixture pins, per turn: the persona that reached the model, the tool
 * surface on the wire, and the whole pi-messages event stream; then the
 * rendered transcript, the conversation listing, and the ghost home on disk.
 *
 * See ./harness.ts for the normalisation rules and the regeneration command.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveGhostExtensions } from "../../src/extensions.js";
import {
  OMP_NATIVE_TOOL_NAMES,
  SessionHost,
} from "../../src/session-host.js";
import type { PiMessagesEvent } from "../../src/pi-messages.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "../helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "../helpers/mock-provider.js";
import {
  expectGolden,
  ghostHomeSnapshot,
  Normalizer,
  personaOf,
  toolSurfaceTable,
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

/** The first line of the seeded character body: where the persona section starts. */
const PERSONA_ANCHOR = "# casper";

const CHARACTER = `---
title: casper
---

# casper

You are casper, a letterpress printer. You answer in short sentences.
`;

const PRESS_DOC = `---
title: Restoring the Vandercook
---

Pull the roller bearings before you soak anything.
`;

const LEDGER_DOC = `---
title: Ledger
---

The Heidelberg cost more than it should have.
`;

/**
 * OMP natives beyond the documented minimum in
 * `OMP_NATIVE_TOOL_NAMES`. Ghost does not contract for these, but they
 * are part of the harness a strip is about to cut into, so the fixture records
 * whether each is still there.
 */
const OTHER_OMP_NATIVES = ["ask", "eval", "inspect_image", "todo"] as const;

describe("golden: session", () => {
  it("writes a memory mid-conversation and carries it into the next turn's persona", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      script: [
        // Turn 1, step 1: reach for the ghost's own memory capability.
        {
          kind: "tool",
          name: "ghost_memory_write",
          args: {
            name: "owner-prefers-short.md",
            description: "The owner wants short answers",
            content: "They asked for the story, not the spec sheet. Keep replies to a line or two.",
          },
        },
        // Turn 1, step 2: having written it, say so.
        { kind: "text", text: "Written down." },
        // Turn 2: a plain answer, on a persona that now lists the memory.
        { kind: "text", text: "That you want short answers." },
      ],
    });
    const dir = seedGhost(temp.root, {
      name: "casper",
      character: CHARACTER,
      docs: { "press.md": PRESS_DOC, "ledger.md": LEDGER_DOC },
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    host = new SessionHost({
      registry: temp.registry,
      offline: true,
      // Titling is a background smol completion; pin it rather than let a
      // second model call race the fixture.
      title: { generate: async () => "Remembering how you like answers" },
      // The greeting has its own fixture and is not part of a turn.
      greeting: { enabled: false },
    });

    const normalizer = new Normalizer()
      .path(dir, "<ghost-home>")
      .path(temp.root, "<ghosts-root>");
    const sections: GoldenSection[] = [];

    const prompts = ["Remember that I want short answers.", "What do you remember about me?"];
    for (const [index, prompt] of prompts.entries()) {
      const before = provider.requests.length;
      const events: PiMessagesEvent[] = [];
      await host.runTurn("casper", {
        sessionId: "conv-golden",
        prompt,
        emit: (event) => events.push(event),
      });
      const requests = provider.requests.slice(before);
      const turn = index + 1;
      expect(requests.length, `turn ${turn} must reach the provider`).toBeGreaterThan(0);

      sections.push({ title: `turn ${turn}: user prompt`, body: prompt });
      sections.push({
        title: `turn ${turn}: persona section of the system prompt`,
        body: normalizer.text(personaOf(requests[0]!.system, PERSONA_ANCHOR)),
      });
      sections.push({
        title: `turn ${turn}: provider round-trips`,
        body: requests
          .map((request, n) => `round-trip ${n + 1}: model=${request.model}`)
          .join("\n"),
      });
      sections.push({
        title: `turn ${turn}: pi-messages events`,
        body: events.map((event) => normalizer.line(event)).join("\n"),
      });
    }

    // The session's own registry is wider than the wire list: OMP mounts some
    // of Ghost's capabilities through its xd:// device registry rather than
    // advertising them as functions. Recorded as a presence table because a
    // session also discovers whatever the developer's own machine has
    // configured — see the harness header.
    const handle = await host.open("casper", "conv-golden");
    const universe = [
      ...OMP_NATIVE_TOOL_NAMES,
      ...OTHER_OMP_NATIVES,
      ...resolveGhostExtensions({}, dir).toolNames,
    ];
    sections.push({
      title: "tool surface",
      body: toolSurfaceTable(
        universe,
        handle.session.getActiveToolNames(),
        provider.requests.at(-1)?.toolNames ?? [],
        // `invokable` is the column that matters for Ghost's own capabilities:
        // OMP mounts them under xd:// so they are absent from both other
        // columns while remaining callable — which the events above prove.
        (name) => handle.session.getToolByName(name) !== undefined,
      ),
    });

    // listSessions awaits the in-flight title write, so this also pins titling.
    const listing = await host.listSessions("casper");
    sections.push({ title: "conversation listing", body: normalizer.json(listing) });

    const transcript = await host.readTranscript("casper", "conv-golden");
    sections.push({ title: "rendered transcript", body: normalizer.json(transcript) });

    sections.push({
      title: "ghost home after the conversation",
      body: ghostHomeSnapshot(dir, normalizer),
    });

    expectGolden("session", sections);
  });
});
