/**
 * Golden: a conversation that writes a note mid-session.
 *
 * Two turns through the session host on a scripted harness. Turn one runs a
 * tool and answers; turn two resumes the harness's own session. The fixture
 * pins, per turn: the persona the harness found in its directory (`AGENTS.md`),
 * the prompt and resume flag it was launched with, the MCP servers it was
 * handed, and the whole turn event stream; then the conversation listing, the
 * rendered transcript, the conversation directory's layout, and the ghost
 * home on disk.
 *
 * See ./harness.ts for the normalisation rules and the regeneration command.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationDir } from "../../src/conversation-log.js";
import { ghostPaths } from "../../src/ghosts.js";
import { SessionHost } from "../../src/session-host.js";
import type { TurnEvent } from "../../src/turn-events.js";
import { fakeHarness, onlyHarnesses, type FakeHarness } from "../helpers/fake-harness.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "../helpers/fixtures.js";
import {
  expectGolden,
  ghostHomeSnapshot,
  Normalizer,
  type GoldenSection,
} from "./harness.js";

let temp: TempGhosts | null = null;
let harness: FakeHarness | null = null;
let host: SessionHost | null = null;

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  harness?.cleanup();
  harness = null;
  temp?.cleanup();
  temp = null;
});

const CHARACTER = `# casper

You are casper, a letterpress printer. You answer in short sentences.
`;

describe("golden: session", () => {
  it("runs two turns on one harness session and records them in the conversation", async () => {
    temp = makeTempGhosts();
    const dir = seedGhost(temp.root, { name: "casper", character: CHARACTER });
    const notePath = join(temp.ownerHome, "Documents", "owner-prefers-short.md");
    harness = fakeHarness([
      {
        events: [
          { type: "session", id: "fake-session-1" },
          { type: "tool_start", id: "t1", name: "Write", args: { path: notePath, content: "The owner wants short answers." } },
          { type: "tool_end", id: "t1", isError: false, output: "Wrote 1 file." },
          { type: "text", block: "a", delta: "Written down." },
        ],
      },
      { events: [{ type: "text", block: "a", delta: "That you want short answers." }] },
    ]);
    const scheduleUnitDir = join(temp.ownerHome, ".xdg-config", "systemd", "user");
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      scheduleUnitDir,
      scheduleCliPath: "/usr/bin/ghost",
      scheduleCommandRunner: async () => ({ stdout: "", stderr: "", code: 0 }),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: temp.ownerHome },
      ...onlyHarnesses(harness),
    });

    const normalizer = new Normalizer()
      .path(dir, "<ghost-home>")
      .path(temp.ownerHome, "<owner-home>")
      .path(temp.root, "<ghosts-root>");
    const sections: GoldenSection[] = [];

    const prompts = ["Remember that I want short answers.", "What do you remember about me?"];
    for (const [index, prompt] of prompts.entries()) {
      const events: TurnEvent[] = [];
      await host.runTurn("casper", {
        sessionId: "conv-golden",
        prompt,
        emit: (event) => events.push(event),
      });
      const turn = index + 1;
      const call = harness.calls()[index];
      expect(call, `turn ${turn} must reach the harness`).toBeDefined();
      const persona = call!.agents ?? "";
      expect(persona).toContain(CHARACTER.trim());
      expect(persona).toContain(scheduleUnitDir);
      expect(persona).toContain("ghost-timer-v1-6-casper-<slug>");

      sections.push({ title: `turn ${turn}: owner prompt`, body: prompt });
      sections.push({ title: `turn ${turn}: persona (AGENTS.md)`, body: normalizer.text(persona.trimEnd()) });
      sections.push({
        title: `turn ${turn}: harness launch`,
        body: normalizer.json({
          prompt: call!.prompt,
          resume: call!.resume,
          sessionId: call!.sessionId,
          cwd: call!.cwd,
          ghost: call!.ghost,
          session: call!.session,
          mcp: call!.mcp,
        }),
      });
      sections.push({
        title: `turn ${turn}: turn events`,
        body: events.map((event) => normalizer.line(event)).join("\n"),
      });
    }

    const listing = await host.listSessions("casper");
    sections.push({ title: "conversation listing", body: normalizer.json(listing) });

    const transcript = await host.readTranscript("casper", "conv-golden");
    sections.push({ title: "rendered transcript", body: normalizer.json(transcript) });

    const conversation = conversationDir(ghostPaths(dir).sessionDir, "conv-golden");
    sections.push({ title: "conversation directory", body: readdirSync(conversation).sort().join("\n") });

    sections.push({
      title: "ghost home after the conversation",
      body: ghostHomeSnapshot(dir, normalizer),
    });

    expectGolden("session", sections);
  });
});
