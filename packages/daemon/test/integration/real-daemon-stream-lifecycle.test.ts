import { afterEach, describe, expect, it, vi } from "vitest";
import { SSE_KEEPALIVE_INTERVAL_MS, type TurnEvent } from "../../src/turn-events.js";
import type { HarnessEvent } from "../../src/harness-table.js";
import type { FakeTurn } from "../helpers/fake-harness.js";
import {
  startRealDaemonHarness,
  within,
  type RealDaemonHarness,
  type RealSseClient,
} from "./harness.js";

let daemon: RealDaemonHarness | null = null;
const gates: Array<() => void> = [];

afterEach(async () => {
  try {
    // A turn still waiting on a gate must not outlive its test.
    for (const release of gates.splice(0)) release();
    await daemon?.close();
    daemon = null;
  } finally {
    vi.useRealTimers();
  }
});

function terminalEvents(events: readonly TurnEvent[]): TurnEvent[] {
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

function text(delta: string): HarnessEvent {
  return { type: "text", block: "a", delta };
}

function toolCalls(count: number): HarnessEvent[] {
  return Array.from({ length: count }, (_, index) => [
    { type: "tool_start", id: `t${index}`, name: "Bash", args: { command: `step ${index}` } },
    { type: "tool_end", id: `t${index}`, isError: false, output: `ok ${index}` },
  ] satisfies HarnessEvent[]).flat();
}

/** A gate file the scripted harness waits on; set before the daemon starts. */
let gatePath = "";
function gated(turn: FakeTurn): FakeTurn {
  return { ...turn, gate: gatePath };
}

async function startGated(turns: (gate: (turn: FakeTurn) => FakeTurn) => FakeTurn[]): Promise<{ release(): void }> {
  // The gate path lives in the fake harness's own directory, so it is known
  // only after the harness exists; script the turns once it is.
  daemon = await startRealDaemonHarness({ turns: [] });
  const gate = daemon.harness.gate("hold");
  gatePath = gate.path;
  daemon.harness.setTurns(turns(gated));
  gates.push(gate.release);
  return gate;
}

/** Start a turn, retrying while the conversation is still releasing its busy gate. */
async function startWhenFree(harness: RealDaemonHarness, sessionId: string, prompt: string): Promise<RealSseClient> {
  return within((async () => {
    for (;;) {
      const stream = await harness.startTurn(sessionId, prompt);
      if (stream.status !== 409) return stream;
      await stream.completion;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })(), "the disconnected conversation to release its busy gate");
}

describe("real ghostd streaming lifecycle", () => {
  it("runs a follow-up queued during a tool-heavy pass as a follow-up, with exactly one terminal", async () => {
    const pass = await startGated((gate) => [
      gate({ events: [...toolCalls(8), text("The tool-heavy pass is complete.")] }),
      { events: [text("Kept it concise.")] },
    ]);

    const stream = await daemon!.startTurn("conv-follow-up", "Run the long integration task.");
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    await stream.waitForEvent("start");
    await daemon!.waitForLaunches(1);

    const followUpText = "Keep the remaining tool work concise.";
    const queued = await daemon!.request<{ streaming: boolean; followUp: string[] }>(
      "POST",
      "/api/ghosts/casper/sessions/conv-follow-up/queue",
      { text: followUpText },
    );
    expect(queued.status).toBe(200);
    expect(queued.body).toEqual({ streaming: true, followUp: [followUpText] });

    pass.release();
    await within(stream.completion, "the followed-up SSE stream to reach EOF");

    const ownerIndex = stream.events.findIndex((event) => event.type === "owner_message");
    expect(stream.events[ownerIndex]).toEqual({ type: "owner_message", text: followUpText });
    expect(stream.events.slice(0, ownerIndex).filter((event) => event.type === "tool_execution_end")).toHaveLength(8);
    expect(stream.events.slice(ownerIndex + 1).some((event) => event.type === "text_start")).toBe(true);
    expect(daemon!.harness.calls().map((call) => [call.prompt, call.resume])).toEqual([
      ["Run the long integration task.", false],
      [followUpText, true],
    ]);
    expect(terminalEvents(stream.events)).toEqual([
      expect.objectContaining({ type: "done", reason: "stop" }),
    ]);
    expectOneTerminalAtWireEnd(stream);
  });

  it("turns a completion with its terminal event suppressed into an SSE error", async () => {
    daemon = await startRealDaemonHarness({ turns: [{ events: [text("The harness completed.")] }] });
    const originalAdmitTurn = daemon.host.admitTurn.bind(daemon.host);
    daemon.host.admitTurn = async (ghostName, options) => {
      const admission = await originalAdmitTurn(ghostName, options);
      return {
        release: admission.release,
        async run(streamOptions) {
          await admission.run({
            ...streamOptions,
            emit(event) {
              if (event.type !== "done" && event.type !== "error") streamOptions.emit(event);
            },
          });
        },
      };
    };

    const stream = await daemon.startTurn("conv-missing-terminal", "Complete normally.");
    await within(stream.completion, "the missing-terminal SSE stream to reach EOF");

    expect(daemon.harness.calls()).toHaveLength(1);
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

  it("keeps a turn running after its SSE client disconnects, until a stop ends it", async () => {
    await startGated((gate) => [
      gate({ events: [text("This response will be disconnected.")] }),
      { events: [text("The same conversation accepted another turn.")] },
    ]);
    const session = `/api/ghosts/${daemon!.ghostName}/sessions/conv-disconnect`;

    const interrupted = await daemon!.startTurn("conv-disconnect", "Hold this turn open.");
    await interrupted.waitForEvent("start");
    await daemon!.waitForLaunches(1);
    interrupted.disconnect();
    await expect(within(interrupted.completion, "the client socket to close"))
      .resolves.toEqual({ naturalEnd: false });

    // A request round trip later the server has seen the closed socket, and the turn still runs.
    expect((await daemon!.request("GET", `${session}/queue`)).body).toMatchObject({ streaming: true });
    const busy = await daemon!.startTurn("conv-disconnect", "Too early.");
    expect(busy.status).toBe(409);
    await busy.completion;

    // The gate stays shut: only the stop can have ended the held harness.
    expect((await daemon!.request("POST", `${session}/stop`, {})).status).toBe(200);
    const subsequent = await startWhenFree(daemon!, "conv-disconnect", "Try the conversation again.");
    await within(subsequent.completion, "the subsequent turn to reach EOF");
    expect(terminalEvents(subsequent.events)).toEqual([
      expect.objectContaining({ type: "done", reason: "stop" }),
    ]);
    expect(daemon!.harness.calls()).toHaveLength(2);
    expectOneTerminalAtWireEnd(subsequent);
    expect((await daemon!.request("POST", `${session}/stop`, {})).status).toBe(409);
  });

  it("writes keepalive comments across a long silent harness stretch", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const silence = await startGated((gate) => [gate({ events: [text("Silence ended.")] })]);

    const stream = await daemon!.startTurn("conv-keepalive", "Wait quietly.");
    await stream.waitForEvent("start");
    await daemon!.waitForLaunches(1);
    const keepalive = stream.waitForFrame(
      (frame) => frame.raw === ": keepalive",
      "the real keepalive comment",
    );
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS);
    expect(await keepalive).toEqual({ raw: ": keepalive" });

    silence.release();
    await within(stream.completion, "the keepalive stream to reach EOF");
    expectOneTerminalAtWireEnd(stream);
  });

  it("streams two conversations of the same ghost without a ghost-wide busy gate", async () => {
    const both = await startGated((gate) => [gate({ events: [text("Concurrent answer.")] })]);

    const first = await daemon!.startTurn("conv-a", "First conversation.");
    await first.waitForEvent("start");
    await daemon!.waitForLaunches(1);

    const second = await daemon!.startTurn("conv-b", "Second conversation.");
    await second.waitForEvent("start");
    await daemon!.waitForLaunches(2);

    both.release();
    await Promise.all([
      within(first.completion, "the first concurrent stream to reach EOF"),
      within(second.completion, "the second concurrent stream to reach EOF"),
    ]);

    for (const stream of [first, second]) {
      expect(terminalEvents(stream.events)).toEqual([
        expect.objectContaining({ type: "done", reason: "stop" }),
      ]);
      expectOneTerminalAtWireEnd(stream);
    }
    expect(daemon!.harness.calls().map((call) => [call.session, call.prompt]).sort()).toEqual([
      ["conv-a", "First conversation."],
      ["conv-b", "Second conversation."],
    ]);
  });
});
