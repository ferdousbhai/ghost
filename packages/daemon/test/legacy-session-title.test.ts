import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { afterEach, describe, expect, it } from "vitest";
import { ghostPaths } from "../src/ghosts.js";
import {
  migrateLegacySessionTitle,
  SessionHost,
  sessionFileNameFor,
} from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

function writeLegacyTranscript(path: string, cwd: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const timestamp = "2026-08-23T19:13:55.703Z";
  const entries = [
    { type: "session", version: 3, id: "legacy-session", timestamp, cwd },
    {
      type: "message",
      id: "user-message",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "What files do I have?" }],
        timestamp: Date.parse(timestamp),
      },
    },
    {
      type: "message",
      id: "assistant-message",
      parentId: "user-message",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the overview." }],
        api: "openai-completions",
        provider: "ghost-local",
        model: "test-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.parse(timestamp),
      },
    },
    {
      type: "session_info",
      id: "legacy-title",
      parentId: "assistant-message",
      timestamp,
      name: "Dropbox Files Overview",
    },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

describe("legacy conversation titles", () => {
  it("lists the pi 0.84 title and promotes it to OMP 18 when resumed", async () => {
    temp = makeTempGhosts();
    const dir = seedGhost(temp.root, { name: "dous" });
    const path = join(ghostPaths(dir).sessionDir, sessionFileNameFor("legacy-conversation"));
    writeLegacyTranscript(path, dir);
    host = new SessionHost({ registry: temp.registry, offline: true });

    expect((await host.listSessions("dous"))[0]?.title).toBe("Dropbox Files Overview");
    expect((await host.readTranscript("dous", "legacy-conversation")).title)
      .toBe("Dropbox Files Overview");
    expect(JSON.parse(readFileSync(path, "utf8").split("\n")[0]!).type).toBe("session");

    const manager = await SessionManager.open(
      path,
      ghostPaths(dir).sessionDir,
      undefined,
      { initialCwd: dir },
    );
    expect(await migrateLegacySessionTitle(manager)).toBe("Dropbox Files Overview");
    expect(manager.getSessionName()).toBe("Dropbox Files Overview");
    await manager.close();

    const records = readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      type: "title",
      title: "Dropbox Files Overview",
      source: "auto",
    });
    expect(records).toContainEqual(expect.objectContaining({
      type: "title_change",
      title: "Dropbox Files Overview",
      trigger: "ghost-legacy-session-info",
    }));
  });
});
