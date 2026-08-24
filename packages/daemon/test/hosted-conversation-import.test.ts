import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateHostedConversations } from "../src/hosted-conversation-import.js";
import { sessionFileNameFor } from "../src/session-host.js";

const CREATED = "2026-01-01T00:00:00.000Z";
const UPDATED = "2026-01-05T00:00:00.000Z";

function hostedConversation(id = "hosted-one") {
  return {
    id,
    ownerId: "owner",
    catalog: {
      id,
      kind: "conversation",
      title: "A hosted conversation",
      messageCount: 4,
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
    messages: [
      {
        id: "user-1",
        role: "user",
        createdAt: "2026-01-01T01:00:00.000Z",
        parts: [
          { type: "text", text: "Please inspect this." },
          {
            type: "file",
            filename: "tiny.webp",
            mediaType: "image/webp",
            url: "data:image/webp;base64,aGVsbG8=",
          },
        ],
      },
      {
        id: "assistant-1",
        role: "assistant",
        metadata: {
          createdAt: "2026-01-01T02:00:00.000Z",
          finishReason: "stop",
          inputTokens: 12,
          outputTokens: 7,
          totalTokens: 19,
        },
        parts: [
          { type: "step-start" },
          {
            type: "tool-search_web",
            toolCallId: "call-1",
            toolName: "search_web",
            state: "output-available",
            input: { query: "ghost" },
            output: { hits: 2 },
          },
          { type: "step-start" },
          { type: "text", state: "done", text: "I found two results." },
          { type: "source-url", sourceId: "source-1", title: "Example", url: "https://example.com" },
        ],
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Thanks." }],
      },
      {
        id: "assistant-2",
        role: "assistant",
        metadata: { finishReason: "stop" },
        parts: [{ type: "step-start" }, { type: "text", text: "You're welcome." }],
      },
    ],
  };
}

describe("migrateHostedConversations", () => {
  let root: string;
  let home: string;
  let conversationsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ghost-hosted-conversations-"));
    home = join(root, "dous");
    conversationsDir = join(home, "conversations");
    mkdirSync(conversationsDir, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates a titled, resumable native OMP session without changing the fixture", async () => {
    const sourcePath = join(conversationsDir, "hosted-one.json");
    const sourceBytes = `${JSON.stringify(hostedConversation(), null, 2)}\n`;
    writeFileSync(sourcePath, sourceBytes);

    const result = await migrateHostedConversations(home);

    expect(result).toEqual({ found: 1, imported: 1, existing: 0, failures: [] });
    expect(readFileSync(sourcePath, "utf8")).toBe(sourceBytes);

    const sessionDir = join(home, ".sessions");
    const target = join(sessionDir, sessionFileNameFor("hosted-one"));
    const manager = await SessionManager.open(target, sessionDir, undefined, { initialCwd: home });
    try {
      expect(manager.getSessionId()).toBe("hosted-one");
      expect(manager.getSessionName()).toBe("A hosted conversation");
      expect(manager.titleSource).toBe("auto");

      const entries = manager.getEntries();
      const messages = entries.filter((entry) => entry.type === "message");
      expect(messages.map((entry) => entry.id)).toEqual([
        "user-1",
        "assistant-1",
        "assistant-1-result-1",
        "assistant-1-step-2",
        "user-2",
        "assistant-2",
      ]);
      expect(messages[0]?.message).toMatchObject({
        role: "user",
        timestamp: Date.parse("2026-01-01T01:00:00.000Z"),
        content: [
          { type: "text", text: "Please inspect this." },
          { type: "text", text: "[Attachment: tiny.webp]" },
          { type: "image", mimeType: "image/webp", data: "aGVsbG8=" },
        ],
      });
      expect(messages[1]?.message).toMatchObject({
        role: "assistant",
        timestamp: Date.parse("2026-01-01T02:00:00.000Z"),
        content: [{ type: "toolCall", id: "call-1", name: "search_web" }],
      });
      expect(messages[2]?.message).toMatchObject({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "search_web",
        isError: false,
      });
      expect(messages[3]?.message).toMatchObject({
        role: "assistant",
        usage: { input: 12, output: 7, totalTokens: 19 },
      });
      expect(entries).toContainEqual(expect.objectContaining({
        type: "custom",
        customType: "ghost_hosted_conversation_import",
        data: expect.objectContaining({
          source: "conversations/hosted-one.json",
          sourceConversationId: "hosted-one",
        }),
      }));
      expect(entries.at(-1)).toMatchObject({
        type: "title_change",
        title: "A hosted conversation",
        source: "auto",
        trigger: "ghost-hosted-import",
        timestamp: UPDATED,
      });
    } finally {
      await manager.close();
    }

    const [listed] = await SessionManager.list(home, sessionDir);
    expect(listed?.title).toBe("A hosted conversation");
    expect(listed?.created.toISOString()).toBe(CREATED);
    expect(listed?.modified.toISOString()).toBe(UPDATED);
  });

  it("is idempotent and never overwrites an existing native target", async () => {
    const sourcePath = join(conversationsDir, "hosted-one.json");
    writeFileSync(sourcePath, JSON.stringify(hostedConversation()));
    expect((await migrateHostedConversations(home)).imported).toBe(1);
    const target = join(home, ".sessions", sessionFileNameFor("hosted-one"));
    const original = readFileSync(target, "utf8");
    const originalMtime = statSync(target).mtimeMs;

    const changed = hostedConversation();
    changed.catalog.title = "This must not replace the native session";
    writeFileSync(sourcePath, JSON.stringify(changed));
    const second = await migrateHostedConversations(home);

    expect(second).toEqual({ found: 1, imported: 0, existing: 1, failures: [] });
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(statSync(target).mtimeMs).toBe(originalMtime);
  });

  it("reports a malformed fixture and continues activating valid ones", async () => {
    writeFileSync(join(conversationsDir, "broken.json"), "{not json");
    writeFileSync(join(conversationsDir, "good.json"), JSON.stringify(hostedConversation("good")));

    const result = await migrateHostedConversations(home);

    expect(result.found).toBe(2);
    expect(result.imported).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.source).toBe(join(conversationsDir, "broken.json"));
    expect(readFileSync(join(conversationsDir, "broken.json"), "utf8")).toBe("{not json");
  });

  it("does nothing when a ghost has no hosted conversation directory", async () => {
    rmSync(conversationsDir, { recursive: true });
    await expect(migrateHostedConversations(home)).resolves.toEqual({
      found: 0,
      imported: 0,
      existing: 0,
      failures: [],
    });
  });
});
