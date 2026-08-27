import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readToolCwds,
  TOOL_CWDS_MAX_BYTES,
  toolCwdsPath,
  writeToolCwds,
} from "../src/tool-cwds.js";

describe("tool cwd sidecar", () => {
  let sessionDir = "";
  const conversationId = "tool-cwd-boundary";

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "ghost-tool-cwds-"));
  });

  afterEach(() => rmSync(sessionDir, { recursive: true, force: true }));

  it("publishes and reads an entry at the exact inclusive 16 MiB boundary", async () => {
    const minimal = '{"version":2,"cwds":[["call","/"]]}\n';
    const cwd = `/${"x".repeat(TOOL_CWDS_MAX_BYTES - Buffer.byteLength(minimal))}`;

    await writeToolCwds(sessionDir, conversationId, new Map([["call", cwd]]));

    const path = toolCwdsPath(sessionDir, conversationId);
    expect(statSync(path).size).toBe(TOOL_CWDS_MAX_BYTES);
    await expect(readToolCwds(sessionDir, conversationId))
      .resolves.toEqual(new Map([["call", cwd]]));
  });

  it("compacts a one-byte-over pathological entry to readable empty state", async () => {
    const minimal = '{"version":2,"cwds":[["call","/"]]}\n';
    const cwd = `/${"x".repeat(TOOL_CWDS_MAX_BYTES - Buffer.byteLength(minimal) + 1)}`;

    await writeToolCwds(sessionDir, conversationId, new Map([["call", cwd]]));

    expect(statSync(toolCwdsPath(sessionDir, conversationId)).size)
      .toBeLessThanOrEqual(TOOL_CWDS_MAX_BYTES);
    await expect(readToolCwds(sessionDir, conversationId)).resolves.toEqual(new Map());
  });

  it("evicts oldest entries and preserves ordered special keys across restart", async () => {
    const minimal = '{"version":2,"cwds":[["old","/"]]}\n';
    const oldCwd = `/${"x".repeat(TOOL_CWDS_MAX_BYTES - Buffer.byteLength(minimal))}`;
    await writeToolCwds(sessionDir, conversationId, new Map([
      ["old", oldCwd],
      ["__proto__", "/prototype"],
      ["constructor", "/constructor"],
    ]));

    const firstRestart = await readToolCwds(sessionDir, conversationId);
    expect([...firstRestart]).toEqual([
      ["__proto__", "/prototype"],
      ["constructor", "/constructor"],
    ]);
    const parsed = JSON.parse(readFileSync(
      toolCwdsPath(sessionDir, conversationId),
      "utf8",
    )) as { cwds: unknown };
    expect(parsed.cwds).toEqual([
      ["__proto__", "/prototype"],
      ["constructor", "/constructor"],
    ]);

    firstRestart.delete("__proto__");
    firstRestart.set("__proto__", "/updated-prototype");
    firstRestart.set("1", "/numeric-key");
    await writeToolCwds(sessionDir, conversationId, firstRestart);
    const secondRestart = await readToolCwds(sessionDir, conversationId);
    expect([...secondRestart]).toEqual([
      ["constructor", "/constructor"],
      ["__proto__", "/updated-prototype"],
      ["1", "/numeric-key"],
    ]);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps the previous durable sidecar byte-exact on validation failure", async () => {
    await writeToolCwds(sessionDir, conversationId, new Map([["stable", "/stable"]]));
    const path = toolCwdsPath(sessionDir, conversationId);
    const before = readFileSync(path);

    await expect(writeToolCwds(
      sessionDir,
      conversationId,
      new Map([["invalid", "relative/path"]]),
    )).rejects.toThrow("invalid tool cwd entry");

    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(sessionDir)).toEqual([path.slice(sessionDir.length + 1)]);
  });

  it("reads legacy maps without exposing prototype properties and rejects ambiguity", async () => {
    const path = toolCwdsPath(sessionDir, conversationId);
    writeFileSync(
      path,
      '{"version":1,"cwds":{"__proto__":"/prototype","constructor":"/constructor"}}\n',
      { mode: 0o600 },
    );
    await expect(readToolCwds(sessionDir, conversationId)).resolves.toEqual(new Map([
      ["__proto__", "/prototype"],
      ["constructor", "/constructor"],
    ]));

    writeFileSync(
      path,
      '{"version":2,"cwds":[["duplicate","/one"],["duplicate","/two"]]}\n',
      { mode: 0o600 },
    );
    await expect(readToolCwds(sessionDir, conversationId))
      .rejects.toMatchObject({ code: "tool_cwds_invalid", status: 500 });
  });
});
