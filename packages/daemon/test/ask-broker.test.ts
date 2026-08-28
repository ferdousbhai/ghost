import { describe, expect, it, vi } from "vitest";
import {
  AskBroker,
  AskBrokerError,
  HeadlessUIUnavailableError,
} from "../src/ask-broker.js";

const QUESTIONS = [{
  id: "shape",
  question: "Which shape?",
  header: "Shape",
  options: [
    { label: "Round", description: "Soft edges" },
    { label: "Square", preview: "┌─┐\n└─┘" },
  ],
  recommended: 1,
}];

describe("AskBroker", () => {
  it("implements OMP's full UI contract and refuses surfaces the daemon does not have", async () => {
    const warn = vi.fn();
    const broker = new AskBroker({
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });
    const ui = broker.uiContext;

    await expect(ui.select("Choose", [{ label: "One" }]))
      .rejects.toBeInstanceOf(HeadlessUIUnavailableError);
    await expect(ui.confirm("Confirm", "Continue?"))
      .rejects.toBeInstanceOf(HeadlessUIUnavailableError);
    await expect(ui.input("Input"))
      .rejects.toBeInstanceOf(HeadlessUIUnavailableError);
    const factory = vi.fn();
    await expect(ui.custom(factory))
      .rejects.toThrow("cannot show a custom interactive UI");
    expect(factory).not.toHaveBeenCalled();
    expect(() => ui.setEditorText("unreachable"))
      .toThrow(HeadlessUIUnavailableError);
    ui.notify("A warning the owner should see", "warning");
    expect(warn).toHaveBeenCalledWith("OMP UI notification", {
      type: "warning",
      message: "A warning the owner should see",
    });
  });

  it("publishes a pending dialog and resolves the exact result shape", async () => {
    const broker = new AskBroker();
    const result = broker.open(QUESTIONS);
    const pending = broker.pending!;
    expect(pending.questions).toEqual(QUESTIONS);

    broker.answer(pending.id, {
      kind: "submit",
      results: [{ id: "shape", selectedOptions: ["Round"], note: "Keep it calm" }],
    });
    await expect(result).resolves.toEqual({
      kind: "submit",
      results: [{
        id: "shape",
        question: "Which shape?",
        options: ["Round", "Square"],
        multi: false,
        selectedOptions: ["Round"],
        note: "Keep it calm",
      }],
    });
    expect(broker.pending).toBeNull();
  });

  it("rejects stale, invented, and ambiguous single-choice answers", async () => {
    const broker = new AskBroker();
    const result = broker.open(QUESTIONS);
    const id = broker.pending!.id;
    expect(() => broker.answer("older", { kind: "chat" })).toThrowError(AskBrokerError);
    expect(() => broker.answer(id, {
      kind: "submit",
      results: [{ id: "shape", selectedOptions: ["Triangle"] }],
    })).toThrow(/not offered/);
    expect(() => broker.answer(id, {
      kind: "submit",
      results: [{ id: "shape", selectedOptions: ["Round"], customInput: "Oval" }],
    })).toThrow(/cannot select/);
    broker.answer(id, { kind: "cancel" });
    await expect(result).resolves.toBeUndefined();
  });

  it("auto-selects the recommended option when a timeout is configured", async () => {
    vi.useFakeTimers();
    try {
      const broker = new AskBroker();
      const result = broker.open(QUESTIONS, { timeout: 500 });
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toMatchObject({
        kind: "submit",
        results: [{ selectedOptions: ["Square"], timedOut: true }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits nothing when a timed-out question recommended nothing", async () => {
    vi.useFakeTimers();
    try {
      const broker = new AskBroker();
      const { recommended: _recommended, ...open } = QUESTIONS[0]!;
      const result = broker.open([open], { timeout: 500 });
      await vi.advanceTimersByTimeAsync(500);
      // The first option is an answer nobody gave; an empty selection is the
      // truthful report of a question that expired, and the model can act on it.
      await expect(result).resolves.toMatchObject({
        kind: "submit",
        results: [{ selectedOptions: [], timedOut: true }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits forever when no deadline was resolved for the question", async () => {
    vi.useFakeTimers();
    try {
      // Unset, `ask.timeout: 0`, and plan mode all reach the broker as one
      // absent timeout, so this is the only honest reading of all three.
      const broker = new AskBroker();
      const result = broker.open(QUESTIONS);
      expect(broker.pending?.timeoutAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(broker.pending).not.toBeNull();
      broker.close();
      await expect(result).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the dialog when its turn signal aborts", async () => {
    const broker = new AskBroker();
    const controller = new AbortController();
    const result = broker.open(QUESTIONS, { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    expect(broker.pending).toBeNull();
  });
});
