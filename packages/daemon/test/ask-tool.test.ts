import { describe, expect, it, vi } from "vitest";
import { AskBroker } from "../src/ask-broker.js";
import { AskCancelledError, createAskTool, type AskToolInput } from "../src/ask-tool.js";

const QUESTION = {
  id: "shape",
  question: "Which shape?",
  options: [{ label: "Round", description: " " }, { label: "Square" }],
  recommended: 1,
};

function askTool(timeoutMs = 0) {
  const broker = new AskBroker();
  const tool = createAskTool({ broker, timeoutMs: () => timeoutMs });
  const run = (questions: AskToolInput["questions"], signal?: AbortSignal) =>
    tool.execute("call-1", { questions }, signal, undefined, {} as never);
  return { broker, run };
}

describe("ask tool", () => {
  it("publishes the question to the broker and returns the owner's single answer", async () => {
    const { broker, run } = askTool();
    const result = run([QUESTION]);
    const pending = broker.pending!;
    expect(pending.questions).toEqual([{ id: "shape", question: "Which shape?", options: [{ label: "Round" }, { label: "Square" }], recommended: 1 }]);
    expect(pending.timeoutAt).toBeUndefined();

    broker.answer(pending.id, { kind: "submit", results: [{ id: "shape", selectedOptions: ["Round"], note: "calm" }] });
    await expect(result).resolves.toEqual({
      content: [{ type: "text", text: "User selected: Round\nUser added note: calm" }],
      details: { question: "Which shape?", options: ["Round", "Square"], multi: false, selectedOptions: ["Round"], note: "calm" },
    });
  });

  it("formats several answers and keeps them as results", async () => {
    const { broker, run } = askTool();
    const second = { id: "size", question: "Which sizes?", options: [{ label: "S" }, { label: "M" }], multi: true };
    const result = run([QUESTION, second]);
    broker.answer(broker.pending!.id, {
      kind: "submit",
      results: [{ id: "shape", selectedOptions: [], customInput: "Oval" }, { id: "size", selectedOptions: ["S", "M"] }],
    });
    await expect(result).resolves.toMatchObject({
      content: [{ type: "text", text: 'User answers:\nshape: "Oval"\nsize: [S, M]' }],
      details: { results: [{ id: "shape", customInput: "Oval" }, { id: "size", selectedOptions: ["S", "M"], multi: true }] },
    });
  });

  it("reports a chat redirect and throws on cancel or abort", async () => {
    const { broker, run } = askTool();
    const chat = run([QUESTION]);
    broker.answer(broker.pending!.id, { kind: "chat" });
    await expect(chat).resolves.toMatchObject({ details: { chatRedirect: true, questions: ["Which shape?"] } });

    const cancelled = run([QUESTION]);
    broker.answer(broker.pending!.id, { kind: "cancel" });
    await expect(cancelled).rejects.toBeInstanceOf(AskCancelledError);

    const controller = new AbortController();
    const aborted = run([QUESTION], controller.signal);
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(AskCancelledError);
  });

  it("settles on the recommendation when the daemon's deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const { broker, run } = askTool(500);
      const result = run([QUESTION]);
      expect(broker.pending?.timeoutAt).toBeDefined();
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toEqual({
        content: [{ type: "text", text: "User selected: Square (auto-selected after timeout)" }],
        details: { question: "Which shape?", options: ["Round", "Square"], multi: false, selectedOptions: ["Square"], timedOut: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses reserved labels and out-of-range recommendations before asking", async () => {
    const { broker, run } = askTool();
    await expect(run([{ ...QUESTION, options: [{ label: "Chat about this" }] }])).rejects.toThrow(/reserved/);
    await expect(run([{ ...QUESTION, recommended: 5 }])).rejects.toThrow(/does not offer/);
    expect(broker.pending).toBeNull();
  });
});
