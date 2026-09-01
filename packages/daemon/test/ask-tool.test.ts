import { describe, expect, it, vi } from "vitest";
import { AskBroker } from "../src/ask-broker.js";
import {
  AskCancelledError,
  createAskTool,
  isAskToolInput,
  type AskToolInput,
} from "../src/ask-tool.js";

const QUESTION = {
  header: "Shape",
  question: "Which shape?",
  options: [
    { label: "Round (Recommended)", description: "Soft edges", preview: "A round preview" },
    { label: "Square", description: "Sharp edges" },
  ],
  multiSelect: false,
} satisfies AskToolInput["questions"][number];

function askTool(timeoutMs = 0) {
  const broker = new AskBroker();
  const tool = createAskTool({ broker, timeoutMs: () => timeoutMs });
  const run = (questions: AskToolInput["questions"], signal?: AbortSignal) =>
    tool.execute("call-1", { questions }, signal, undefined, {} as never);
  return { broker, run };
}

describe("ask tool", () => {
  it("uses Claude's native question signature", () => {
    expect(isAskToolInput({ questions: [QUESTION] })).toBe(true);
    expect(isAskToolInput({
      questions: [{ ...QUESTION, options: [{ label: "Only", description: "No choice" }] }],
    })).toBe(false);
    expect(isAskToolInput({
      questions: [{ ...QUESTION, header: "This header is too long" }],
    })).toBe(false);
    expect(isAskToolInput({
      questions: [{ ...QUESTION, id: "legacy", multiSelect: undefined, multi: false }],
    })).toBe(false);
  });

  it("publishes broker questions and returns Claude's native output", async () => {
    const { broker, run } = askTool();
    const result = run([QUESTION]);
    const pending = broker.pending!;
    expect(pending.questions).toEqual([{
      id: "question-1",
      header: "Shape",
      question: "Which shape?",
      options: [
        { label: "Round (Recommended)", description: "Soft edges", preview: "A round preview" },
        { label: "Square", description: "Sharp edges" },
      ],
      multi: false,
    }]);
    expect(pending.timeoutAt).toBeUndefined();

    broker.answer(pending.id, {
      kind: "submit",
      results: [{
        id: "question-1",
        selectedOptions: ["Round (Recommended)"],
        note: "calm",
      }],
    });
    const settled = await result;
    expect(JSON.parse((settled.content[0] as { text: string }).text)).toEqual({
      questions: [QUESTION],
      answers: { "Which shape?": "Round (Recommended)" },
      annotations: {
        "Which shape?": { preview: "A round preview", notes: "calm" },
      },
    });
    expect(settled.details).toMatchObject({
      output: { answers: { "Which shape?": "Round (Recommended)" } },
      question: "Which shape?",
      options: ["Round (Recommended)", "Square"],
      multi: false,
      selectedOptions: ["Round (Recommended)"],
      note: "calm",
    });
  });

  it("keys multiple and custom answers by question text", async () => {
    const { broker, run } = askTool();
    const second = {
      header: "Sizes",
      question: "Which sizes?",
      options: [
        { label: "Small", description: "Compact" },
        { label: "Medium", description: "Balanced" },
      ],
      multiSelect: true,
    } satisfies AskToolInput["questions"][number];
    const result = run([QUESTION, second]);
    broker.answer(broker.pending!.id, {
      kind: "submit",
      results: [
        { id: "question-1", selectedOptions: [], customInput: "Oval" },
        { id: "question-2", selectedOptions: ["Small", "Medium"] },
      ],
    });
    const settled = await result;
    expect(JSON.parse((settled.content[0] as { text: string }).text)).toMatchObject({
      answers: { "Which shape?": "Oval", "Which sizes?": "Small, Medium" },
    });
    expect(settled.details).toMatchObject({
      results: [
        { id: "question-1", customInput: "Oval" },
        { id: "question-2", selectedOptions: ["Small", "Medium"], multi: true },
      ],
    });
  });

  it("reports a chat redirect and throws on cancel or abort", async () => {
    const { broker, run } = askTool();
    const chat = run([QUESTION]);
    broker.answer(broker.pending!.id, { kind: "chat" });
    await expect(chat).resolves.toMatchObject({
      details: {
        chatRedirect: true,
        output: { answers: {}, response: expect.stringContaining("discuss") },
      },
    });

    const cancelled = run([QUESTION]);
    broker.answer(broker.pending!.id, { kind: "cancel" });
    await expect(cancelled).rejects.toBeInstanceOf(AskCancelledError);

    const controller = new AbortController();
    const aborted = run([QUESTION], controller.signal);
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(AskCancelledError);
  });

  it("times out without inventing an owner selection", async () => {
    vi.useFakeTimers();
    try {
      const { broker, run } = askTool(500);
      const result = run([QUESTION]);
      expect(broker.pending?.timeoutAt).toBeDefined();
      await vi.advanceTimersByTimeAsync(500);
      const settled = await result;
      expect(JSON.parse((settled.content[0] as { text: string }).text)).toEqual({
        questions: [QUESTION],
        answers: {},
        autoAnsweredAfterMs: 500,
      });
      expect(settled.details).toMatchObject({ timedOut: true, selectedOptions: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses UI-reserved and duplicate labels before asking", async () => {
    const { broker, run } = askTool();
    await expect(run([{
      ...QUESTION,
      options: [
        { label: "Other", description: "Reserved" },
        { label: "Square", description: "Sharp edges" },
      ],
    }])).rejects.toThrow(/reserved/u);
    await expect(run([{
      ...QUESTION,
      options: [
        { label: "Same", description: "First" },
        { label: "Same", description: "Second" },
      ],
    }])).rejects.toThrow(/duplicate/u);
    expect(broker.pending).toBeNull();
  });
});
