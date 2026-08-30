/**
 * Golden: a conversation that writes a memory mid-session.
 *
 * Two turns through one hosted session against the scripted mock provider. The
 * model calls `ghost_memory_write` on turn one — the ideal golden tool: no
 * network, no clock, and its effect is a file on disk — and turn two's persona
 * must show that memory in the index, because the persona is rebuilt from the
 * ghost home before every agent start.
 *
 * The fixture pins, per turn: the complete system prompt that reached the
 * model, the tool surface on the wire, and the whole pi-messages event stream;
 * then the rendered transcript, conversation listing, and ghost home on disk.
 *
 * See ./harness.ts for the normalisation rules and the regeneration command.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MachineDocuments } from "@ghost/extensions";
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

const PRESS_DOC = `# Restoring the Vandercook

Pull the roller bearings before you soak anything.
`;

const LEDGER_DOC = `# Ledger

The Heidelberg cost more than it should have.
`;

/**
 * Additional OMP tools worth auditing beside the phase-1 minimum. Ghost does
 * not contract for these. `task` is included specifically to pin the deliberate
 * phase-1 subtraction while the fixture records the rest of the harness.
 */
const OTHER_AUDITED_OMP_TOOLS = ["ask", "eval", "inspect_image", "task", "todo"] as const;

describe("golden: session", () => {
  it("writes a memory mid-conversation and carries it into the next system prompt", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({
      script: [
        // Turn 1, step 1: reach for the ghost's own memory capability.
        {
          kind: "tool",
          name: "ghost_memory_write",
          args: {
            name: "owner-prefers-short.md",
            content: "The owner wants short answers. They asked for the story, not the spec sheet. Keep replies to a line or two.",
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
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    const documentsRoot = join(temp.root, ".documents");
    mkdirSync(documentsRoot);
    writeFileSync(join(documentsRoot, "press.md"), PRESS_DOC);
    writeFileSync(join(documentsRoot, "ledger.md"), LEDGER_DOC);
    const machineSkills = join(temp.ownerHome, ".agents", "skills");
    const omarchySkill = join(machineSkills, "omarchy");
    mkdirSync(omarchySkill, { recursive: true });
    writeFileSync(
      join(omarchySkill, "SKILL.md"),
      "---\nname: omarchy\ndescription: Control this Omarchy laptop through its CLI.\n---\n\nUse the stable CLI routes.\n",
    );
    const documents = new MachineDocuments(documentsRoot);
    const scheduleUnitDir = join(temp.ownerHome, ".xdg-config", "systemd", "user");
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      scheduleUnitDir,
      machineSkillPaths: [machineSkills],
      offline: true,
      extensionOptions: { documents },
      // Titling is a background smol completion; pin it rather than let a
      // second model call race the fixture.
      title: { generate: async () => "Remembering how you like answers" },
      // The greeting has its own fixture and is not part of a turn.
      greeting: { enabled: false },
    });

    const normalizer = new Normalizer()
      .path(provider.url, "<mock-provider>")
      .path(dir, "<ghost-home>")
      .path(documentsRoot, "<documents-root>")
      .path(temp.ownerHome, "<owner-home>")
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
      const systemPrompt = requests[0]!.system.trimEnd();
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

    // The session's own registry is wider than the wire list: OMP mounts some
    // of Ghost's capabilities through its xd:// device registry rather than
    // advertising them as functions. Record a presence table so OMP may change
    // presentation without hiding a missing native or Ghost-owned capability.
    const handle = await host.open("casper", "conv-golden");
    const universe = [
      ...PI_NATIVE_TOOL_NAMES,
      ...OTHER_AUDITED_OMP_TOOLS,
      ...resolveGhostExtensions({ documents }, dir, { vision: false }).toolNames,
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
