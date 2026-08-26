import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGhostHome } from "@ghost/extensions";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_MAINTENANCE_STATE_FILENAME,
  contextDiff,
  ConversationContextMaintenance,
} from "../src/conversation-maintenance.js";
import { GhostHookRunner } from "../src/hooks.js";
import { openAiCompatiblePreset, writeGhostModels } from "../src/models.js";
import type { GhostOmpRuntime } from "../src/omp-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ghost-maintenance-"));
  roots.push(cwd);
  const home = openGhostHome(cwd);
  await home.ensure();
  const runner = new GhostHookRunner();
  return { cwd, home, runner };
}

function idleEvent(cwd: string, turnId = 2) {
  return {
    type: "conversation_idle" as const,
    conversation_id: "conversation-a",
    turn_id: turnId,
    idle_for_ms: 60_000,
    last_turn_outcome: "completed" as const,
    session_id: "runtime-session-a",
    signal: new AbortController().signal,
    ghost_name: "test-ghost",
    cwd,
    runtime: "omp" as const,
  };
}

describe("ConversationContextMaintenance", () => {
  it("reviews every pending turn and injects its diff until delivery is acknowledged", async () => {
    const { cwd, home, runner } = await fixture();
    const update = vi.fn(async ({ transcript }: { transcript: string }) => {
      expect(transcript).toContain("Owner turn 1");
      expect(transcript).toContain("Owner turn 2");
      await home.writeMemory({
        name: "preferred-editor",
        description: "Owner's preferred editor",
        content: "The owner prefers Helix.",
      });
    });
    const maintenance = new ConversationContextMaintenance({
      withRuntime: async () => {
        throw new Error("the injected updater should replace the model");
      },
      update,
    });
    await runner.register(maintenance.hookFactory);
    await maintenance.recordTurn({
      ghostName: "test-ghost",
      cwd,
      runtime: "omp",
      conversationId: "conversation-a",
      turnId: 1,
      ownerPrompt: "Remember my editor.",
      assistantText: "I will.",
      outcome: "completed",
    });
    await maintenance.recordTurn({
      ghostName: "test-ghost",
      cwd,
      runtime: "omp",
      conversationId: "conversation-a",
      turnId: 2,
      ownerPrompt: "It is Helix.",
      assistantText: "Understood.",
      outcome: "completed",
    });

    await runner.emitConversationIdle(idleEvent(cwd));
    expect(update).toHaveBeenCalledTimes(1);

    const prompt = {
      type: "before_prompt" as const,
      conversation_id: "conversation-a",
      prompt: "What were we doing?",
      turn_id: 3,
      session_id: "runtime-session-a",
      signal: new AbortController().signal,
      ghost_name: "test-ghost",
      cwd,
      runtime: "omp" as const,
    };
    const first = await runner.emitBeforePrompt(prompt);
    expect(first?.additionalContext).toContain("memory/preferred-editor.md");
    expect(first?.additionalContext).toContain("+The owner prefers Helix.");

    const beforeAck = await runner.emitBeforePrompt(prompt);
    expect(beforeAck?.additionalContext).toBe(first?.additionalContext);
    await first?.acknowledge?.();
    expect(await runner.emitBeforePrompt(prompt)).toBeUndefined();

    const state = JSON.parse(readFileSync(
      join(cwd, "sessions", CONVERSATION_MAINTENANCE_STATE_FILENAME),
      "utf8",
    )) as {
      conversations: Record<string, {
        retainedThroughTurn: number;
        pendingTurns: unknown[];
      }>;
    };
    expect(state.conversations['["omp","conversation-a"]']).toMatchObject({
      retainedThroughTurn: 2,
      pendingTurns: [],
    });
  });

  it("reports partial file changes but keeps the transcript pending after model failure", async () => {
    const { cwd, home, runner } = await fixture();
    const maintenance = new ConversationContextMaintenance({
      withRuntime: async () => {
        throw new Error("unused");
      },
      update: async () => {
        await home.writeDoc("project.md", { body: "# Project\n\nChosen.\n" });
        throw new Error("provider disconnected");
      },
    });
    await runner.register(maintenance.hookFactory);
    await maintenance.recordTurn({
      ghostName: "test-ghost",
      cwd,
      runtime: "omp",
      conversationId: "conversation-a",
      turnId: 1,
      ownerPrompt: "We chose the project.",
      assistantText: "Recorded.",
      outcome: "completed",
    });

    await runner.emitConversationIdle(idleEvent(cwd, 1));
    const notice = await runner.emitBeforePrompt({
      type: "before_prompt",
      conversation_id: "conversation-a",
      prompt: "Continue",
      turn_id: 2,
      session_id: "runtime-session-a",
      signal: new AbortController().signal,
      ghost_name: "test-ghost",
      cwd,
      runtime: "omp",
    });
    expect(notice?.additionalContext).toContain("docs/project.md");

    const state = JSON.parse(readFileSync(
      join(cwd, "sessions", CONVERSATION_MAINTENANCE_STATE_FILENAME),
      "utf8",
    )) as {
      conversations: Record<string, {
        retainedThroughTurn: number;
        pendingTurns: unknown[];
      }>;
    };
    expect(state.conversations['["omp","conversation-a"]']).toMatchObject({
      retainedThroughTurn: 0,
    });
    expect(state.conversations['["omp","conversation-a"]']?.pendingTurns).toHaveLength(1);
  });

  it("bounds the unified diff without hiding the changed path manifest", () => {
    const before = { files: new Map([["docs/large.md", "old\n".repeat(300)]]) };
    const after = { files: new Map([["docs/large.md", "new\n".repeat(300)]]) };
    const result = contextDiff(before, after, 256);
    expect(result.changed).toEqual(["docs/large.md"]);
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(256);
    expect(result.truncated).toBe(true);
  });

  it("does not retain an aborted owner turn for later maintenance", async () => {
    const { cwd, runner } = await fixture();
    const update = vi.fn();
    const maintenance = new ConversationContextMaintenance({
      withRuntime: async () => {
        throw new Error("unused");
      },
      update,
    });
    await runner.register(maintenance.hookFactory);
    await maintenance.recordTurn({
      ghostName: "test-ghost",
      cwd,
      runtime: "omp",
      conversationId: "conversation-a",
      turnId: 1,
      ownerPrompt: "Never completed",
      assistantText: "Partial",
      outcome: "aborted",
    });
    await runner.emitConversationIdle({
      ...idleEvent(cwd, 1),
      last_turn_outcome: "aborted",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("delivers changes from an idle run that is cancelled by the next prompt", async () => {
    const { cwd, home, runner } = await fixture();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const maintenance = new ConversationContextMaintenance({
      withRuntime: async () => {
        throw new Error("unused");
      },
      update: async ({ signal }) => {
        await home.writeDoc("race.md", { body: "# Captured before cancellation\n" });
        startedResolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    });
    await runner.register(maintenance.hookFactory);
    await maintenance.recordTurn({
      ghostName: "test-ghost",
      cwd,
      runtime: "omp",
      conversationId: "conversation-a",
      turnId: 1,
      ownerPrompt: "Capture this.",
      assistantText: "Working.",
      outcome: "completed",
    });
    const controller = new AbortController();
    const idle = runner.emitConversationIdle({
      ...idleEvent(cwd, 1),
      signal: controller.signal,
    });
    await started;
    controller.abort();

    const notice = await runner.emitBeforePrompt({
      type: "before_prompt",
      conversation_id: "conversation-a",
      prompt: "Continue.",
      turn_id: 2,
      session_id: "runtime-session-a",
      signal: new AbortController().signal,
      ghost_name: "test-ghost",
      cwd,
      runtime: "omp",
    });
    await idle;
    expect(notice?.additionalContext).toContain("docs/race.md");
  });

  it("retains every turn since the previous successful maintenance run", async () => {
    const { cwd, runner } = await fixture();
    const update = vi.fn(async ({ transcript }: { transcript: string }) => {
      expect(transcript).toContain("Owner turn 1");
      expect(transcript).toContain("Owner turn 15");
    });
    const maintenance = new ConversationContextMaintenance({
      withRuntime: async () => {
        throw new Error("unused");
      },
      update,
    });
    await runner.register(maintenance.hookFactory);
    for (let turnId = 1; turnId <= 15; turnId += 1) {
      await maintenance.recordTurn({
        ghostName: "test-ghost",
        cwd,
        runtime: "omp",
        conversationId: "conversation-a",
        turnId,
        ownerPrompt: `Owner message ${turnId}`,
        assistantText: `Assistant message ${turnId}`,
        outcome: "completed",
      });
    }

    await runner.emitConversationIdle(idleEvent(cwd, 15));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps one pending idle run when a previous run is still settling", async () => {
    const { cwd, runner } = await fixture();
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const transcripts: string[] = [];
    const maintenance = new ConversationContextMaintenance({
      withRuntime: async () => {
        throw new Error("unused");
      },
      update: async ({ transcript }) => {
        transcripts.push(transcript);
        if (transcripts.length === 1) {
          firstStartedResolve();
          await firstGate;
        }
      },
    });
    await runner.register(maintenance.hookFactory);
    await maintenance.recordTurn({
      ghostName: "test-ghost",
      cwd,
      runtime: "omp",
      conversationId: "conversation-a",
      turnId: 1,
      ownerPrompt: "First.",
      assistantText: "One.",
      outcome: "completed",
    });
    const first = runner.emitConversationIdle(idleEvent(cwd, 1));
    await firstStarted;
    await maintenance.recordTurn({
      ghostName: "test-ghost",
      cwd,
      runtime: "omp",
      conversationId: "conversation-a",
      turnId: 2,
      ownerPrompt: "Second.",
      assistantText: "Two.",
      outcome: "completed",
    });
    const second = runner.emitConversationIdle(idleEvent(cwd, 2));
    releaseFirst();
    await Promise.all([first, second]);

    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toContain("Owner turn 1");
    expect(transcripts[1]).toContain("Owner turn 2");
  });

  it("runs smol_model with only the context maintenance tools", async () => {
    const { cwd, home, runner } = await fixture();
    const modelsFile = openAiCompatiblePreset({
      providerId: "fixture",
      baseUrl: "https://example.invalid/v1",
      modelId: "fast",
    });
    modelsFile.roles = {
      ...modelsFile.roles,
      smol_model: { provider: "fixture", modelId: "fast" },
    };
    writeGhostModels(cwd, modelsFile);
    const model = {
      provider: "fixture",
      id: "fast",
      cost: { input: 0, output: 0 },
    } as Model<never>;
    const contexts: Context[] = [];
    let call = 0;
    const runtime = {
      getModels: () => [model],
      getModel: () => model,
      hasConfiguredAuth: () => true,
      isUsingSubscription: () => false,
      isUsingOAuth: () => false,
      complete: async (_model: Model<never>, context: Context) => {
        contexts.push(context);
        call += 1;
        return {
          role: "assistant",
          content: call === 1 ? [{
            type: "toolCall",
            id: "tool-1",
            name: "write_memory",
            arguments: {
              name: "preferred-editor",
              description: "Owner's preferred editor",
              content: "The owner prefers Helix.",
            },
          }] : [{ type: "text", text: "Done" }],
          api: "openai-completions",
          provider: "fixture",
          model: "fast",
          usage: {},
          stopReason: call === 1 ? "toolUse" : "stop",
          timestamp: Date.now(),
        } as AssistantMessage;
      },
    } as unknown as GhostOmpRuntime;
    const maintenance = new ConversationContextMaintenance({
      withRuntime: async (_ghostName, use) => use(runtime),
    });
    await runner.register(maintenance.hookFactory);
    await maintenance.recordTurn({
      ghostName: "test-ghost",
      cwd,
      runtime: "omp",
      conversationId: "conversation-a",
      turnId: 1,
      ownerPrompt: "I use Helix.",
      assistantText: "Thanks.",
      outcome: "completed",
    });

    await runner.emitConversationIdle(idleEvent(cwd, 1));
    expect((await home.readMemory("preferred-editor")).content).toBe("The owner prefers Helix.");
    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual([
      "list_context",
      "read_context",
      "search_context",
      "write_doc",
      "write_memory",
      "delete_context",
    ]);
    expect(contexts[1]?.messages.some((message) => message.role === "toolResult")).toBe(true);
  });
});
