import { GhostError } from "../src/errors.js";
import { describe, expect, it } from "vitest";
import {
  classifyLimitMessage,
  encodeSseEvent,
  parseTurnRequest,
  statedReturn,
  type TurnEvent,
} from "../src/turn-events.js";
import { parseSseStream } from "./helpers/fixtures.js";

describe("SSE framing", () => {
  it("round-trips through Ghost's in-repo conformance parser", () => {
    const events: TurnEvent[] = [
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "hi\n\nthere" },
      { type: "done" },
    ];
    // Keepalive comments must be invisible.
    const body = `: keepalive\n\n${events.map(encodeSseEvent).join("")}`;
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

describe("statedReturn", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");

  it("reads the date a provider says access returns, as UTC", () => {
    const anthropic = "429 You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-11-01 at 00:00 UTC.";
    expect(statedReturn(anthropic, now)).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(statedReturn("Quota resets 2026-10-29T09:30Z", now)).toBe(Date.parse("2026-10-29T09:30:00Z"));
    expect(statedReturn("Usage resets on 2026-10-30.", now)).toBe(Date.parse("2026-10-30T00:00:00Z"));
  });

  it("reads a stated span from now", () => {
    expect(statedReturn("Rate limited. Try again in 30 minutes.", now)).toBe(now + 30 * 60_000);
    expect(statedReturn("retry after 90 seconds", now)).toBe(now + 90_000);
    expect(statedReturn("Your limit resets in 5 hours", now)).toBe(now + 5 * 3_600_000);
  });

  it("believes nothing past, absent, or more than a month away", () => {
    expect(statedReturn("You will regain access on 2026-10-01 at 00:00 UTC.", now)).toBeNull();
    expect(statedReturn("model_not_found", now)).toBeNull();
    expect(statedReturn("Not logged in. Run login first.", now)).toBeNull();
    expect(statedReturn("You will regain access on 2027-06-01 at 00:00 UTC.", now)).toBeNull();
  });
});
