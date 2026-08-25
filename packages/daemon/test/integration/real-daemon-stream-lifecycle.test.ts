import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SSE_KEEPALIVE_INTERVAL_MS,
  type PiMessagesEvent,
} from "../../src/pi-messages.js";
import {
  createMockProviderBarrier,
  type MockStep,
} from "../helpers/mock-provider.js";
import {
  startRealDaemonHarness,
  within,
  type JsonResponse,
  type RealDaemonHarness,
  type RealSseClient,
} from "./harness.js";

let daemon: RealDaemonHarness | null = null;

afterEach(async () => {
  try {
    await daemon?.close();
    daemon = null;
  } finally {
    vi.useRealTimers();
  }
});

function terminalEvents(events: readonly PiMessagesEvent[]): PiMessagesEvent[] {
  return events.filter((event) => event.type === "done" || event.type === "error");
}

function expectOneTerminalAtWireEnd(stream: RealSseClient): void {
  const terminals = terminalEvents(stream.events);
  expect(terminals).toHaveLength(1);
  const terminalFrame = stream.frames.findIndex((frame) =>
    frame.event?.type === "done" || frame.event?.type === "error");
  expect(terminalFrame).toBeGreaterThanOrEqual(0);
  expect(stream.frames.slice(terminalFrame + 1)).toEqual([]);
}

async function waitUntilCommandsAreAccepted(
  harness: RealDaemonHarness,
  sessionId: string,
): Promise<JsonResponse> {
  return within((async () => {
    for (;;) {
      const response = await harness.request(
        "GET",
        `/api/ghosts/${harness.ghostName}/sessions/${encodeURIComponent(`pi:${sessionId}`)}/commands`,
      );
      if (response.status === 200) return response;
      expect(response.status).toBe(409);
      await setImmediate();
    }
  })(), "the disconnected conversation to release its busy gate");
}

function memoryStep(index: number, barrier?: ReturnType<typeof createMockProviderBarrier>): MockStep {
  return {
    kind: "tool",
    name: "ghost_memory_write",
    args: {
      name: `integration-step-${index}.md`,
      description: `Integration tool step ${index}`,
      content: `The owner requested deterministic integration tool step ${index}.`,
    },
    ...(barrier ? { barrier } : {}),
  };
}

describe("real ghostd streaming lifecycle", () => {
  it("streams a dequeued steering message and exactly one terminal after a tool-heavy turn", async () => {
    const dequeueBoundary = createMockProviderBarrier();
    daemon = await startRealDaemonHarness({
      script: [
        memoryStep(1),
        memoryStep(2),
        memoryStep(3),
        memoryStep(4, dequeueBoundary),
        memoryStep(5),
        memoryStep(6),
        memoryStep(7),
        memoryStep(8),
        { kind: "text", text: "The steered tool-heavy turn is complete." },
      ],
    });

    const stream = await daemon.startTurn("conv-steering", "Run the long integration task.");
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    await stream.waitForEvent("start");
    await within(dequeueBoundary.waitForArrivals(), "the held provider step");

    const steeringText = "Keep the remaining tool work concise.";
    const queued = await daemon.request<{
      streaming: boolean;
      steering: string[];
    }>(
      "POST",
      "/api/ghosts/casper/sessions/pi%3Aconv-steering/queue",
      { mode: "steer", text: steeringText },
    );
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ streaming: true, steering: [steeringText] });

    dequeueBoundary.release();
    await within(stream.completion, "the steered SSE stream to reach EOF");

    const ownerIndex = stream.events.findIndex((event) => event.type === "owner_message");
    expect(stream.events[ownerIndex]).toEqual({ type: "owner_message", text: steeringText });
    expect(stream.events.slice(0, ownerIndex).filter((event) =>
      event.type === "tool_execution_end").length).toBeGreaterThanOrEqual(4);
    expect(stream.events.slice(ownerIndex + 1).some((event) =>
      event.type === "toolcall_start" || event.type === "text_start")).toBe(true);
    expect(stream.events.filter((event) => event.type === "tool_execution_end")).toHaveLength(8);
    expect(terminalEvents(stream.events)).toEqual([
      expect.objectContaining({ type: "done", reason: "stop" }),
    ]);
    expectOneTerminalAtWireEnd(stream);
  });

  it("turns a real runtime completion with its terminal callback suppressed into an SSE error", async () => {
    daemon = await startRealDaemonHarness({
      script: [{ kind: "text", text: "The real runtime completed." }],
    });
    const originalRunTurn = daemon.host.runTurn.bind(daemon.host);
    daemon.host.runTurn = (ghostName, options) => originalRunTurn(ghostName, {
      ...options,
      emit(event) {
        if (event.type !== "done" && event.type !== "error") options.emit(event);
      },
    });

    const stream = await daemon.startTurn("conv-missing-terminal", "Complete normally.");
    await within(stream.completion, "the missing-terminal SSE stream to reach EOF");

    expect(daemon.provider.requests).toHaveLength(1);
    expect(stream.events.some((event) => event.type === "text_end")).toBe(true);
    expect(terminalEvents(stream.events)).toEqual([
      expect.objectContaining({
        type: "error",
        reason: "error",
        errorMessage: "The turn ended without a terminal event.",
      }),
    ]);
    expectOneTerminalAtWireEnd(stream);
  });

  it("releases a conversation after its SSE client disconnects mid-turn", async () => {
    const heldRequest = createMockProviderBarrier();
    daemon = await startRealDaemonHarness({
      script: [
        { kind: "text", text: "This response will be disconnected.", barrier: heldRequest },
        { kind: "text", text: "The same conversation accepted another turn." },
      ],
      provider: { sequential: true },
    });

    const interrupted = await daemon.startTurn("conv-disconnect", "Hold this turn open.");
    await interrupted.waitForEvent("start");
    await within(heldRequest.waitForArrivals(), "the provider request before disconnect");
    interrupted.disconnect();
    await expect(within(interrupted.completion, "the client socket to close"))
      .resolves.toEqual({ naturalEnd: false });
    heldRequest.release();

    expect((await waitUntilCommandsAreAccepted(daemon, "conv-disconnect")).status).toBe(200);
    const subsequent = await daemon.startTurn("conv-disconnect", "Try the conversation again.");
    await within(subsequent.completion, "the subsequent turn to reach EOF");
    expect(terminalEvents(subsequent.events)).toEqual([
      expect.objectContaining({ type: "done", reason: "stop" }),
    ]);
    expect(daemon.provider.requests).toHaveLength(2);
    expectOneTerminalAtWireEnd(subsequent);
  });

  it("writes keepalive comments across a long silent provider stretch", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const silentStretch = createMockProviderBarrier();
    daemon = await startRealDaemonHarness({
      script: [{ kind: "text", text: "Silence ended.", barrier: silentStretch }],
    });

    const stream = await daemon.startTurn("conv-keepalive", "Wait quietly.");
    await stream.waitForEvent("start");
    await within(silentStretch.waitForArrivals(), "the silent provider stretch");
    const keepalive = stream.waitForFrame(
      (frame) => frame.raw === ": keepalive",
      "the real keepalive comment",
    );
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS);
    expect(await keepalive).toEqual({ raw: ": keepalive" });

    silentStretch.release();
    await within(stream.completion, "the keepalive stream to reach EOF");
    expectOneTerminalAtWireEnd(stream);
  });

  it("streams two conversations of the same ghost without a ghost-wide busy gate", async () => {
    const bothAtProvider = createMockProviderBarrier();
    daemon = await startRealDaemonHarness({
      script: [{ kind: "text", text: "Concurrent answer.", barrier: bothAtProvider }],
    });

    const first = await daemon.startTurn("conv-a", "First conversation.");
    await first.waitForEvent("start");
    await within(bothAtProvider.waitForArrivals(1), "the first conversation at the provider");

    const second = await daemon.startTurn("conv-b", "Second conversation.");
    await second.waitForEvent("start");
    await within(bothAtProvider.waitForArrivals(2), "both conversations at the provider");

    bothAtProvider.release();
    await Promise.all([
      within(first.completion, "the first concurrent stream to reach EOF"),
      within(second.completion, "the second concurrent stream to reach EOF"),
    ]);

    expect(terminalEvents(first.events)).toEqual([
      expect.objectContaining({ type: "done", reason: "stop" }),
    ]);
    expect(terminalEvents(second.events)).toEqual([
      expect.objectContaining({ type: "done", reason: "stop" }),
    ]);
    expectOneTerminalAtWireEnd(first);
    expectOneTerminalAtWireEnd(second);
    const providerMessages = daemon.provider.requests.map((request) => JSON.stringify(request.messages));
    expect(providerMessages.some((messages) => messages.includes("First conversation."))).toBe(true);
    expect(providerMessages.some((messages) => messages.includes("Second conversation."))).toBe(true);
  });
});
