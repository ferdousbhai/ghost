import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { antiSlopPromptSection, createAntiSlopHook } from "../src/anti-slop-hook.js";
import { loadGhostSettings } from "../src/ghost-settings.js";
import { ghostPaths } from "../src/ghosts.js";
import {
  GhostHookRunner,
  ghostSessionStopContinuation,
  type GhostBeforePromptEvent,
  type GhostSessionStopEvent,
} from "../src/hooks.js";
import { MAX_PRIVATE_FILE_BYTES } from "../src/private-file.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, tempDir, useCleanups } from "./helpers/fixtures.js";
import { startMockProvider } from "./helpers/mock-provider.js";
import { recordingLogger } from "./helpers/recording-logger.js";

const cleanups = useCleanups();

function scratchGhostHome(settingsYaml?: string): string {
  const { path: home, cleanup } = tempDir("ghost-anti-slop-");
  cleanups.push(cleanup);
  if (settingsYaml !== undefined) writeFileSync(ghostPaths(home).settingsFile, settingsYaml, "utf8");
  return home;
}

const SLOPPY_REPLY = "Great question! I'd be happy to leverage this. Moreover, it works.";
const MINOR_ONLY_REPLY = "In order to win, we must try.";

function stopEvent(
  home: string,
  overrides: Partial<GhostSessionStopEvent> = {},
): GhostSessionStopEvent {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: SLOPPY_REPLY }],
  };
  return {
    type: "session_stop",
    owner_prompt: "Explain the plan.",
    messages: [message],
    turn_id: 1,
    last_assistant_message: message,
    session_id: "session-1",
    stop_hook_active: false,
    signal: new AbortController().signal,
    ghost_name: "casper",
    ghost_home: home,
    cwd: home,
    runtime: "pi",
    conversation_id: "session-1",
    conversation_runtime: "pi",
    ...overrides,
  };
}

async function runnerWith(logger = recordingLogger()) {
  const runner = new GhostHookRunner({ logger });
  await runner.register(createAntiSlopHook({ logger }));
  return runner;
}

describe("anti-slop session_stop hook", () => {
  it("accepts when settings.yml is absent", async () => {
    const runner = await runnerWith();
    const result = await runner.emitSessionStop(stopEvent(scratchGhostHome()));
    expect(ghostSessionStopContinuation(result)).toBeUndefined();
  });

  it("accepts when the mode is off or unknown", async () => {
    const runner = await runnerWith();
    for (const mode of ["off", "aggressive"]) {
      const home = scratchGhostHome(`antiSlop:\n  mode: ${mode}\n`);
      const result = await runner.emitSessionStop(stopEvent(home));
      expect(ghostSessionStopContinuation(result)).toBeUndefined();
    }
  });

  it("logs one bounded advisory line without reply text and accepts", async () => {
    const logger = recordingLogger();
    const runner = await runnerWith(logger);
    const home = scratchGhostHome("antiSlop:\n  mode: advisory\n");
    const result = await runner.emitSessionStop(stopEvent(home));
    expect(ghostSessionStopContinuation(result)).toBeUndefined();
    const advisory = logger.records.filter((r) => r.message === "anti-slop findings");
    expect(advisory).toHaveLength(1);
    const fields = advisory[0]?.fields as { mode: string; rules: Record<string, number> } | undefined;
    expect(fields?.mode).toBe("advisory");
    expect(fields?.rules["chatbot-phrase"]).toBeGreaterThan(0);
    expect(JSON.stringify(logger.records)).not.toContain("Great question");
  });

  it("requests one bounded rewrite continuation in strict mode", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome("antiSlop:\n  mode: strict\n");
    const result = await runner.emitSessionStop(stopEvent(home));
    expect(result?.continue).toBe(true);
    const context = ghostSessionStopContinuation(result);
    expect(context).toBeDefined();
    expect(context!.length).toBeLessThanOrEqual(2_000);
    expect(context).toContain("1. [major] chatbot-phrase:");
    expect(context).toContain("Remove canned assistant phrasing.");
    expect(context).toContain("overrule reason in one sentence");
  });

  it("accepts a continuation pass unconditionally in strict mode", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome("antiSlop:\n  mode: strict\n");
    const result = await runner.emitSessionStop(stopEvent(home, { stop_hook_active: true }));
    expect(ghostSessionStopContinuation(result)).toBeUndefined();
  });

  it("accepts minor-only findings in strict mode with an advisory-style log", async () => {
    const logger = recordingLogger();
    const runner = await runnerWith(logger);
    const home = scratchGhostHome("antiSlop:\n  mode: strict\n");
    const message = { role: "assistant", content: [{ type: "text", text: MINOR_ONLY_REPLY }] };
    const result = await runner.emitSessionStop(
      stopEvent(home, { messages: [message], last_assistant_message: message }),
    );
    expect(ghostSessionStopContinuation(result)).toBeUndefined();
    expect(logger.records.some((r) => r.message === "anti-slop findings")).toBe(true);
  });

  it("honors disabledRules from settings.yml", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome(
      "antiSlop:\n  mode: strict\n  disabledRules:\n    - chatbot-phrase\n    - essay-connective\n",
    );
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Great question! Moreover, it works." }],
    };
    const result = await runner.emitSessionStop(
      stopEvent(home, { messages: [message], last_assistant_message: message }),
    );
    expect(ghostSessionStopContinuation(result)).toBeUndefined();
  });

  it("fails open when settings.yml cannot be read", async () => {
    const logger = recordingLogger();
    const runner = await runnerWith(logger);
    const home = scratchGhostHome(`# ${"x".repeat(MAX_PRIVATE_FILE_BYTES)}\n`);
    const result = await runner.emitSessionStop(stopEvent(home));
    expect(ghostSessionStopContinuation(result)).toBeUndefined();
    expect(logger.records.some((r) =>
      r.level === "warn" && r.message === "anti-slop review failed open"
    )).toBe(true);
  });

  it("analyzes only text content blocks, never tool payloads", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome("antiSlop:\n  mode: strict\n");
    const message = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "bash", input: { command: `echo "${SLOPPY_REPLY}"` } },
        { type: "thinking", thinking: SLOPPY_REPLY },
        { type: "text", text: "Done. The tests pass." },
      ],
    };
    const result = await runner.emitSessionStop(
      stopEvent(home, { messages: [message], last_assistant_message: message }),
    );
    expect(ghostSessionStopContinuation(result)).toBeUndefined();
  });

  it("skips fenced code blocks inside the reply text", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome("antiSlop:\n  mode: strict\n");
    const message = {
      role: "assistant",
      content: [{ type: "text", text: `Run this:\n\`\`\`sh\necho "${SLOPPY_REPLY}"\n\`\`\`\nThen ship.` }],
    };
    const result = await runner.emitSessionStop(
      stopEvent(home, { messages: [message], last_assistant_message: message }),
    );
    expect(ghostSessionStopContinuation(result)).toBeUndefined();
  });

  it("registers with the anti_slop settings key on the status row", async () => {
    const runner = await runnerWith();
    const row = runner.status().hooks.find((hook) => hook.name === "Anti-slop review");
    expect(row).toMatchObject({ event: "session_stop", source: "builtin", settingsKey: "anti_slop" });
  });
});

function promptEvent(
  home: string,
  overrides: Partial<GhostBeforePromptEvent> = {},
): GhostBeforePromptEvent {
  return {
    type: "before_prompt",
    prompt: "Continue.",
    turn_id: 2,
    session_id: "session-1",
    signal: new AbortController().signal,
    ghost_name: "casper",
    ghost_home: home,
    cwd: home,
    runtime: "pi",
    conversation_id: "session-1",
    conversation_runtime: "pi",
    ...overrides,
  };
}

describe("anti-slop next-turn feedback", () => {
  it("nudges the next prompt once with rule counts, never reply text", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome("antiSlop:\n  mode: advisory\n");
    await runner.emitSessionStop(stopEvent(home));

    const first = await runner.emitBeforePrompt(promptEvent(home));
    expect(first?.additionalContext).toContain("flagged your previous reply");
    expect(first?.additionalContext).toContain("chatbot-phrase");
    expect(first?.additionalContext).not.toContain("Great question");

    const second = await runner.emitBeforePrompt(promptEvent(home));
    expect(second).toBeUndefined();
  });

  it("records nothing when the mode is off", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome();
    await runner.emitSessionStop(stopEvent(home));
    expect(await runner.emitBeforePrompt(promptEvent(home))).toBeUndefined();
  });

  it("clears a pending nudge when the turn's final pass is clean", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome("antiSlop:\n  mode: strict\n");
    await runner.emitSessionStop(stopEvent(home));
    const clean = { role: "assistant", content: [{ type: "text", text: "Done. Tests pass." }] };
    await runner.emitSessionStop(stopEvent(home, {
      stop_hook_active: true,
      messages: [clean],
      last_assistant_message: clean,
    }));
    expect(await runner.emitBeforePrompt(promptEvent(home))).toBeUndefined();
  });

  it("caps the record map, evicting the oldest conversation", async () => {
    const runner = await runnerWith();
    const home = scratchGhostHome("antiSlop:\n  mode: advisory\n");
    for (let index = 0; index <= 64; index += 1) {
      await runner.emitSessionStop(stopEvent(home, { conversation_id: `conversation-${index}` }));
    }
    expect(await runner.emitBeforePrompt(promptEvent(home, { conversation_id: "conversation-0" })))
      .toBeUndefined();
    const kept = await runner.emitBeforePrompt(promptEvent(home, { conversation_id: "conversation-64" }));
    expect(kept?.additionalContext).toContain("chatbot-phrase");
  });
});

describe("antiSlopPromptSection", () => {
  it("renders only for advisory and strict, honoring disabledRules", () => {
    expect(antiSlopPromptSection(loadGhostSettings(scratchGhostHome()))).toBeUndefined();
    expect(antiSlopPromptSection(loadGhostSettings(scratchGhostHome("antiSlop:\n  mode: off\n"))))
      .toBeUndefined();
    for (const mode of ["advisory", "strict"]) {
      const section = antiSlopPromptSection(loadGhostSettings(scratchGhostHome(
        `antiSlop:\n  mode: ${mode}\n  disabledRules: [emoji-bullets]\n`,
      )));
      expect(section).toContain("## Style contract");
      expect(section).toContain("chatbot-phrase");
      expect(section).not.toContain("emoji-bullets");
    }
  });
});

describe("anti-slop prompt wiring", () => {
  it("appends the style contract to a pi session prompt only when enabled", async () => {
    const temp = makeTempGhosts();
    cleanups.push(temp.cleanup);
    const provider = await startMockProvider({ script: [{ kind: "text", text: "Hello." }] });
    cleanups.push(() => provider.close());
    for (const [name, settings] of [
      ["casper", "antiSlop:\n  mode: advisory\n  disabledRules: [emoji-bullets]\n"],
      ["boo", undefined],
    ] as const) {
      const dir = seedGhost(temp.root, {
        name,
        provider: { baseUrl: provider.url, modelId: provider.modelId },
      });
      if (settings) writeFileSync(join(dir, "settings.yml"), settings, "utf8");
    }
    const host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      scheduleUnitDir: join(temp.ownerHome, ".xdg-config", "systemd", "user"),
      offline: true,
      title: { generate: async () => "Anti-slop wiring" },
      greeting: { enabled: false },
    });
    cleanups.push(() => host.disposeAll());

    await host.runTurn("casper", { sessionId: "conv-style", prompt: "Hi", emit: () => {} });
    const enabled = provider.requests.at(-1)!.system;
    expect(enabled).toContain("## Style contract");
    expect(enabled).toContain("chatbot-phrase");
    expect(enabled).not.toContain("emoji-bullets");

    await host.runTurn("boo", { sessionId: "conv-plain", prompt: "Hi", emit: () => {} });
    expect(provider.requests.at(-1)!.system).not.toContain("## Style contract");
  });
});
