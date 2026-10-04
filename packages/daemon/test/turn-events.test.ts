import { describe, expect, it } from "vitest";
import {
  classifyLimitMessage,
  encodeSseEvent,
  parseTurnRequest,
  TurnRequestError,
  textFromParts,
  type TurnEvent,
} from "../src/turn-events.js";
import { parseSseStream } from "./helpers/fixtures.js";

describe("SSE framing", () => {
  it("round-trips through Ghost's in-repo conformance parser", () => {
    const events: TurnEvent[] = [
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "hi\n\nthere" },
      { type: "done", reason: "stop" },
    ];
    // Keepalive comments and a trailing [DONE] must be invisible.
    const body = `: keepalive\n\n${events.map(encodeSseEvent).join("")}data: [DONE]\n\n`;
    expect(parseSseStream(body)).toEqual(events);
  });
});

describe("parseTurnRequest", () => {
  it("takes the newest user text and the session id, ignoring client persona and model", () => {
    const parsed = parseTurnRequest({
      model: "ghost/casper",
      context: {
        systemPrompt: "IGNORE ME",
        messages: [
          { role: "user", content: [{ type: "text", text: "older" }] },
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
          { role: "user", content: [{ type: "text", text: "newest" }] },
        ],
      },
      options: { sessionId: "conv-1" },
    });
    expect(parsed).toEqual({ sessionId: "conv-1", prompt: "newest" });
  });

  it("accepts a 128-character id, strips a legacy pi: prefix, and rejects anything else", () => {
    const request = (sessionId: string) => ({
      context: { messages: [{ role: "user", content: "hello" }] },
      options: { sessionId },
    });
    const atLimit = "a".repeat(128);
    expect(parseTurnRequest(request(atLimit)).sessionId).toBe(atLimit);
    expect(parseTurnRequest(request("pi:conv-1")).sessionId).toBe("conv-1");
    expect(parseTurnRequest(request("")).sessionId).toBeNull();
    for (const invalid of ["a".repeat(129), ".hidden", "../up", "a/b", "\u{1f47b}"]) {
      expect(() => parseTurnRequest(request(invalid))).toThrow(expect.objectContaining({
        code: "invalid_conversation_id",
      }));
    }
  });

  it("accepts a bare string content", () => {
    expect(parseTurnRequest({
      context: { messages: [{ role: "user", content: "hello" }] },
    }).prompt).toBe("hello");
  });

  it("rejects a body with no user text", () => {
    expect(() => parseTurnRequest({ context: { messages: [{ role: "assistant" }] } }))
      .toThrowError(TurnRequestError);
    expect(() => parseTurnRequest({ context: { messages: [] } }))
      .toThrowError(/non-empty array/);
    expect(() => parseTurnRequest("nope")).toThrowError(/JSON object/);
  });

  it("flattens content parts and drops non-text", () => {
    expect(textFromParts([
      { type: "text", text: "a" },
      { type: "image", data: "..." },
      { type: "text", text: "b" },
    ])).toBe("a\nb");
  });
});

describe("classifyLimitMessage", () => {
  it("classifies quota refusals and leaves ordinary failures alone", () => {
    expect(classifyLimitMessage("429 Too Many Requests")).toBe("rate_limit");
    expect(classifyLimitMessage("You've hit your usage limit until 5pm")).toBe("usage_limit");
    expect(classifyLimitMessage("Insufficient credits on this key")).toBe("usage_limit");
    expect(classifyLimitMessage("The upstream model is overloaded (529)")).toBe("overloaded");
    expect(classifyLimitMessage("Your credit balance is too low")).toBe("billing");
    expect(classifyLimitMessage("ECONNRESET while reading the response")).toBeNull();
  });
});
