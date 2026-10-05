import { GhostError } from "../src/ghosts.js";
import { describe, expect, it } from "vitest";
import {
  classifyLimitMessage,
  encodeSseEvent,
  parseTurnRequest,
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
  it("takes the prompt and the session id, ignoring anything else a client sends", () => {
    expect(parseTurnRequest({ prompt: "  newest  ", sessionId: "conv-1", model: "ghost/casper", systemPrompt: "IGNORE ME" }))
      .toEqual({ sessionId: "conv-1", prompt: "newest" });
  });

  it("accepts a 128-character id and rejects anything else", () => {
    const request = (sessionId: string) => ({ prompt: "hello", sessionId });
    const atLimit = "a".repeat(128);
    expect(parseTurnRequest(request(atLimit)).sessionId).toBe(atLimit);
    expect(parseTurnRequest(request("")).sessionId).toBeNull();
    for (const invalid of ["a".repeat(129), ".hidden", "../up", "a/b", "pi:conv-1", "\u{1f47b}"]) {
      expect(() => parseTurnRequest(request(invalid))).toThrow(expect.objectContaining({
        code: "invalid_conversation_id",
      }));
    }
  });

  it("rejects a body with no prompt text", () => {
    expect(() => parseTurnRequest({ prompt: "   " })).toThrowError(GhostError);
    expect(() => parseTurnRequest({ sessionId: "conv-1" })).toThrowError(/prompt/);
    expect(() => parseTurnRequest("nope")).toThrowError(/JSON object/);
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
