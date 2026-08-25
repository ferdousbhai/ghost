import { describe, expect, it, vi } from "vitest";
import { AskBroker, AskBrokerError } from "../src/ask-broker.js";

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
  it("publishes a pending dialog and resolves the exact OMP result shape", async () => {
    const broker = new AskBroker();
    const result = broker.uiContext.askDialog!(QUESTIONS);
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
    const result = broker.uiContext.askDialog!(QUESTIONS);
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

  it("auto-selects the recommended option when an OMP timeout is configured", async () => {
    vi.useFakeTimers();
    try {
      const broker = new AskBroker();
      const onTimeout = vi.fn();
      const result = broker.uiContext.askDialog!(QUESTIONS, { timeout: 500, onTimeout });
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toMatchObject({
        kind: "submit",
        results: [{ selectedOptions: ["Square"], timedOut: true }],
      });
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the daemon's default timeout when the asker names none", async () => {
    vi.useFakeTimers();
    try {
      const broker = new AskBroker(2);
      const result = broker.uiContext.askDialog!(QUESTIONS);
      expect(broker.pending?.timeoutAt).toBeTruthy();
      await vi.advanceTimersByTimeAsync(2000);
      // The recommended option, submitted on the user's behalf, is what lets
      // the turn carry on instead of holding a question nobody can answer.
      await expect(result).resolves.toMatchObject({
        kind: "submit",
        results: [{ timedOut: true }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a question with its own deadline keep it", async () => {
    vi.useFakeTimers();
    try {
      const broker = new AskBroker(600);
      const result = broker.uiContext.askDialog!(QUESTIONS, { timeout: 500 });
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toMatchObject({ kind: "submit" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits forever at zero, which is what shipped before a default existed", async () => {
    vi.useFakeTimers();
    try {
      const broker = new AskBroker(0);
      const result = broker.uiContext.askDialog!(QUESTIONS);
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
    const result = broker.uiContext.askDialog!(QUESTIONS, { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    expect(broker.pending).toBeNull();
  });
});
