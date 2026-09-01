/**
 * Golden: a conversation that writes a memory mid-session.
 *
 * Two turns through one hosted session against the scripted mock provider. The
 * model calls the native `write` tool on turn one — the ideal golden effect: no
 * network, no clock, just a file on disk — and turn two must reach the provider
 * under the byte-identical system prompt, because the persona and its indexes
 * are derived once per session rather than before every agent start. The
 * written fact lives on disk, where the native file tools read it.
 *
 * The fixture pins, per turn: the complete system prompt that reached the
 * model, the tool surface on the wire, and the whole pi-messages event stream;
 * then the rendered transcript, conversation listing, and ghost home on disk.
 *
 * See ./harness.ts for the normalisation rules and the regeneration command.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGhostExtensions } from "../../src/extensions.js";
import {
  PI_NATIVE_TOOL_NAMES,
  SessionHost,
} from "../../src/session-host.js";
import type { PiMessagesEvent } from "../../src/pi-messages.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "../helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "../helpers/mock-provider.js";
import {
  expectGolden,
  ghostHomeSnapshot,
  Normalizer,
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

const CHARACTER = `# casper

You are casper, a letterpress printer. You answer in short sentences.
`;

/**
 * Additional Pi tool names worth auditing beside the phase-1 minimum. Ghost does
 * not contract for these. `task` is included specifically to pin the deliberate
 * phase-1 subtraction while the fixture records the rest of the harness.
 */
const OTHER_AUDITED_PI_TOOLS = ["ask", "eval", "inspect_image", "task"] as const;

describe("golden: session", () => {
  it("writes a memory mid-conversation and holds the session's system prompt fixed", async () => {
    temp = makeTempGhosts();
    const memoryPath = relative(
      temp.ownerHome,
      join(temp.root, "casper", "memory", "owner-prefers-short.md"),
    );
    provider = await startMockProvider({
      script: [
        // Turn 1, step 1: use the runtime's native file writer at the rendered root.
        {
          kind: "tool",
          name: "write",
          args: {
            path: memoryPath,
            content: "The owner wants short answers. They asked for the story, not the spec sheet. Keep replies to a line or two.",
          },
        },
        // Turn 1, step 2: having written it, say so.
        { kind: "text", text: "Written down." },
        // Turn 2: a plain answer, on the persona the session started with.
        { kind: "text", text: "That you want short answers." },
      ],
    });
    const dir = seedGhost(temp.root, {
      name: "casper",
      character: CHARACTER,
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    const machineSkills = join(temp.ownerHome, ".agents", "skills");
    const omarchySkill = join(machineSkills, "omarchy");
    mkdirSync(omarchySkill, { recursive: true });
    writeFileSync(
      join(omarchySkill, "SKILL.md"),
      "---\nname: omarchy\ndescription: Control this Omarchy laptop through its CLI.\n---\n\nUse the stable CLI routes.\n",
    );
    const scheduleUnitDir = join(temp.ownerHome, ".xdg-config", "systemd", "user");
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      scheduleUnitDir,
      machineSkillPaths: [machineSkills],
      offline: true,
      // Titling is a background smol completion; pin it rather than let a
      // second model call race the fixture.
      title: { generate: async () => "Remembering how you like answers" },
      // The greeting has its own fixture and is not part of a turn.
      greeting: { enabled: false },
    });

    const normalizer = new Normalizer()
      .path(provider.url, "<mock-provider>")
      .path(dir, "<ghost-home>")
      .path(temp.ownerHome, "<owner-home>")
      .path(temp.root, "<ghosts-root>");
    const sections: GoldenSection[] = [];
    const systemPrompts: string[] = [];

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
      const systemPrompt = requests[0]!.system.trimEnd();
      systemPrompts.push(systemPrompt);
      expect(systemPrompt).toContain(CHARACTER.trim());
      expect(systemPrompt).toContain(scheduleUnitDir);
      expect(systemPrompt).toContain("ghost-timer-v1-6-casper-<slug>");
      expect(systemPrompt).not.toContain("~/.config/systemd/user");
      for (const inherited of [
        "Oh My Pi",
        "§ Runtime",
        "§ Tool Policy",
        "<system-conventions>",
        "report_issue",
      ]) expect(systemPrompt).not.toContain(inherited);
      sections.push({
        title: `turn ${turn}: complete system prompt`,
        body: normalizer.text(systemPrompt),
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

    // The memory index is session-start state: turn 1 writes a memory, and
    // turn 2 is answered under the same prompt it started with rather than a
    // rewritten prefix. The fact is on disk, where the native file tools read
    // it, and a conversation opened after the write indexes it.
    expect(systemPrompts[1]).toBe(systemPrompts[0]);
    expect(systemPrompts[1]).not.toContain("owner-prefers-short");

    // Record both the session registry and provider-facing wire list so an
    // accidental presentation mismatch cannot hide a missing native or
    // Ghost-owned capability.
    const handle = await host.open("casper", "conv-golden");
    const universe = [
      ...PI_NATIVE_TOOL_NAMES,
      ...OTHER_AUDITED_PI_TOOLS,
      ...resolveGhostExtensions({}, dir, { vision: false }).toolNames,
    ];
    sections.push({
      title: "tool surface",
      body: toolSurfaceTable(
        universe,
        handle.session.getActiveToolNames(),
        provider.requests.at(-1)?.toolNames ?? [],
        // `invokable` independently proves that every advertised definition is
        // callable through the session registry.
        (name) => handle.session.getToolDefinition(name) !== undefined,
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
