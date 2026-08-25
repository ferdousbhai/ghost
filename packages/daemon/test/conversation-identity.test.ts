import { describe, expect, it } from "vitest";
import {
  conversationIdentity,
  isValidConversationId,
  MAX_CONVERSATION_ID_SCALARS,
  parseConversationIdentity,
  requireConversationIdentity,
} from "../src/conversation-identity.js";

describe("runtime-qualified conversation identity", () => {
  it("round-trips an opaque raw resume id without folding it into the runtime", () => {
    const identity = conversationIdentity("claude-code", "default/with:punctuation");
    expect(identity).toEqual({
      id: "claude-code:default/with:punctuation",
      conversationId: "default/with:punctuation",
      runtime: "claude-code",
    });
    expect(parseConversationIdentity(identity.id)).toEqual(identity);
  });

  it("does not guess a runtime for empty or unqualified ids", () => {
    expect(parseConversationIdentity("default")).toBeNull();
    expect(parseConversationIdentity("pi:")).toBeNull();
    expect(() => requireConversationIdentity("default")).toThrow(expect.objectContaining({
      code: "invalid_conversation_id",
      status: 400,
    }));
  });

  it("accepts bounded Unicode scalars without accepting malformed UTF-16", () => {
    const atLimit = `${"a".repeat(MAX_CONVERSATION_ID_SCALARS - 1)}\u{1f47b}`;
    expect(atLimit.length).toBe(MAX_CONVERSATION_ID_SCALARS + 1);
    expect(isValidConversationId(atLimit)).toBe(true);
    expect(parseConversationIdentity(`pi:${atLimit}`)?.conversationId).toBe(atLimit);
    expect(isValidConversationId("a".repeat(MAX_CONVERSATION_ID_SCALARS + 1))).toBe(false);
    expect(parseConversationIdentity(`pi:${"a".repeat(MAX_CONVERSATION_ID_SCALARS + 1)}`))
      .toBeNull();
    expect(isValidConversationId("\ud800")).toBe(false);
    expect(isValidConversationId("\udc00")).toBe(false);
    expect(parseConversationIdentity("pi:\ud800")).toBeNull();
    expect(parseConversationIdentity("pi:\udc00")).toBeNull();
  });
});
