import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindConversationId,
  conversationIdFromSessionFile,
  requireSessionFileConversationId,
  sessionFileNameFor,
} from "../src/session-files.js";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("Pi conversation transcript identity", () => {
  it("keeps direct filenames compatible and isolates generated stems from raw aliases", () => {
    expect(sessionFileNameFor("conversation-1")).toBe("conversation-1.jsonl");

    const generated = sessionFileNameFor("unsafe/conversation?one");
    expect(generated).toMatch(/^ghost~[0-9a-f]{64}\.jsonl$/u);
    expect(generated).not.toContain("/");
    const generatedStem = generated.slice(0, -".jsonl".length);
    expect(sessionFileNameFor(generatedStem)).not.toBe(generated);
    expect(() => sessionFileNameFor("\ud800")).toThrow(expect.objectContaining({
      code: "invalid_conversation_id",
      status: 400,
    }));
    expect(() => sessionFileNameFor("\udc00")).toThrow(expect.objectContaining({
      code: "invalid_conversation_id",
      status: 400,
    }));
  });

  it("round-trips an unsafe raw id from native transcript metadata", async () => {
    root = mkdtempSync(join(tmpdir(), "ghost-session-files-"));
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir);
    const conversationId = "unsafe/folder?query=#fragment and spaces";
    const path = join(sessionDir, sessionFileNameFor(conversationId));
    writeFileSync(path, "");
    const manager = SessionManager.open(path, sessionDir, root);
    bindConversationId(manager, conversationId);

    await expect(conversationIdFromSessionFile(path)).resolves.toBe(conversationId);
  });

  it("omits a transplanted hash identity and rejects direct actions with 409", async () => {
    root = mkdtempSync(join(tmpdir(), "ghost-session-files-"));
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir);
    const requested = "unsafe/requested id";
    const stored = "unsafe/stored id";
    const path = join(sessionDir, sessionFileNameFor(requested));
    writeFileSync(path, "");
    const manager = SessionManager.open(path, sessionDir, root);
    bindConversationId(manager, stored);

    await expect(conversationIdFromSessionFile(path)).resolves.toBeNull();
    await expect(requireSessionFileConversationId(path, requested)).rejects.toMatchObject({
      code: "session_identity_mismatch",
      status: 409,
    });

    const storedPath = join(sessionDir, sessionFileNameFor(stored));
    writeFileSync(storedPath, "");
    const storedManager = SessionManager.open(storedPath, sessionDir, root);
    bindConversationId(storedManager, stored);
    await expect(conversationIdFromSessionFile(storedPath)).resolves.toBe(stored);
    await expect(requireSessionFileConversationId(storedPath, stored)).resolves.toBe(stored);
  });
});
