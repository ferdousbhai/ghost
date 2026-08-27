import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { expandInternalUrls } from "@oh-my-pi/pi-coding-agent/tools/bash-skill-urls";
import { afterEach, describe, expect, it } from "vitest";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "./helpers/mock-provider.js";

let temp: TempGhosts | null = null;
let provider: MockProvider | null = null;
let host: SessionHost | null = null;

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  await provider?.close();
  provider = null;
  temp?.cleanup();
  temp = null;
});

function writeScopedMcp(ghostDir: string, label: string): void {
  const serverPath = join(ghostDir, "scoped-resource.mjs");
  writeFileSync(serverPath, `
import { createInterface } from "node:readline";
const label = ${JSON.stringify(label)};
const lines = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send(request.id, {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: "scoped-resource", version: "1.0.0" },
  });
  else if (request.method === "tools/list") send(request.id, { tools: [] });
  else if (request.method === "resources/list") send(request.id, {
    resources: [{ uri: "fixture://shared", name: "shared", mimeType: "text/plain" }],
  });
  else if (request.method === "resources/templates/list") send(request.id, { resourceTemplates: [] });
  else if (request.method === "prompts/list") send(request.id, { prompts: [] });
  else if (request.method === "resources/read") send(request.id, {
    contents: [{ uri: "fixture://shared", mimeType: "text/plain", text: label }],
  });
  else send(request.id, {});
});
`, "utf8");
  writeFileSync(join(ghostDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      scoped: { type: "stdio", command: process.execPath, args: [serverPath] },
    },
  }), "utf8");
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("OMP session-scoped internal resources", () => {
  it("routes real hosted Read, Bash, glob, and grep calls through only their session snapshot", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "unused" }] });
    const providerConfig = { baseUrl: provider.url, modelId: provider.modelId };
    const firstDir = seedGhost(temp.root, { name: "casper", provider: providerConfig });
    const secondDir = seedGhost(temp.root, { name: "wisp", provider: providerConfig });
    mkdirSync(join(firstDir, "rules"), { recursive: true });
    mkdirSync(join(secondDir, "rules"), { recursive: true });
    writeFileSync(join(firstDir, "rules", "shared.md"), "FIRST_RULE_SCOPE\n", "utf8");
    writeFileSync(join(secondDir, "rules", "shared.md"), "SECOND_RULE_SCOPE\n", "utf8");
    writeScopedMcp(firstDir, "FIRST_MCP_SCOPE");
    writeScopedMcp(secondDir, "SECOND_MCP_SCOPE");
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
    });

    const [first, second] = await Promise.all([
      host.open("casper", "scoped"),
      host.open("wisp", "scoped"),
    ]);
    const firstRead = first.session.getToolByName("read");
    const secondRead = second.session.getToolByName("read");
    const firstBash = first.session.getToolByName("bash");
    const secondBash = second.session.getToolByName("bash");
    const firstGlob = first.session.getToolByName("glob");
    const secondGlob = second.session.getToolByName("glob");
    const firstGrep = first.session.getToolByName("grep");
    const secondGrep = second.session.getToolByName("grep");
    for (const tool of [firstRead, secondRead, firstBash, secondBash, firstGlob, secondGlob, firstGrep, secondGrep]) {
      expect(tool).toBeDefined();
    }

    const [firstRule, secondRule, firstMcp, secondMcp] = await Promise.all([
      firstRead!.execute("first-rule", { path: "rule://shared" }),
      secondRead!.execute("second-rule", { path: "rule://shared" }),
      firstRead!.execute("first-mcp", { path: "mcp://fixture://shared" }),
      secondRead!.execute("second-mcp", { path: "mcp://fixture://shared" }),
    ]);
    expect(resultText(firstRule)).toContain("FIRST_RULE_SCOPE");
    expect(resultText(firstRule)).not.toContain("SECOND_RULE_SCOPE");
    expect(resultText(secondRule)).toContain("SECOND_RULE_SCOPE");
    expect(resultText(secondRule)).not.toContain("FIRST_RULE_SCOPE");
    expect(resultText(firstMcp)).toContain("FIRST_MCP_SCOPE");
    expect(resultText(firstMcp)).not.toContain("SECOND_MCP_SCOPE");
    expect(resultText(secondMcp)).toContain("SECOND_MCP_SCOPE");
    expect(resultText(secondMcp)).not.toContain("FIRST_MCP_SCOPE");

    const [firstBashRule, secondBashRule, firstGlobRule, secondGlobRule, firstGrepMcp, secondGrepMcp] =
      await Promise.all([
        firstBash!.execute("first-bash", { command: "cat rule://shared" }),
        secondBash!.execute("second-bash", { command: "cat rule://shared" }),
        firstGlob!.execute("first-glob", { path: "rule://shared" }),
        secondGlob!.execute("second-glob", { path: "rule://shared" }),
        firstGrep!.execute("first-grep", { pattern: "FIRST_MCP_SCOPE", path: "mcp://fixture://shared" }),
        secondGrep!.execute("second-grep", { pattern: "SECOND_MCP_SCOPE", path: "mcp://fixture://shared" }),
      ]);
    expect(resultText(firstBashRule)).toContain("FIRST_RULE_SCOPE");
    expect(resultText(secondBashRule)).toContain("SECOND_RULE_SCOPE");
    expect(resultText(firstGlobRule)).toContain(join(firstDir, "rules"));
    expect(resultText(firstGlobRule)).not.toContain(join(secondDir, "rules"));
    expect(resultText(secondGlobRule)).toContain(join(secondDir, "rules"));
    expect(resultText(secondGlobRule)).not.toContain(join(firstDir, "rules"));
    expect(resultText(firstGrepMcp)).toContain("FIRST_MCP_SCOPE");
    expect(resultText(secondGrepMcp)).toContain("SECOND_MCP_SCOPE");

    writeScopedMcp(firstDir, "FIRST_MCP_RELOADED");
    await host.reloadMcp("casper");
    const reloadedFirst = await firstRead!.execute("first-reloaded", {
      path: "mcp://fixture://shared",
    });
    const stillSecond = await secondRead!.execute("second-still-open", {
      path: "mcp://fixture://shared",
    });
    expect(resultText(reloadedFirst)).toContain("FIRST_MCP_RELOADED");
    expect(resultText(stillSecond)).toContain("SECOND_MCP_SCOPE");

    await host.close("casper", "scoped");
    const afterOtherClose = await secondRead!.execute("second-after-close", {
      path: "mcp://fixture://shared",
    });
    expect(resultText(afterOtherClose)).toContain("SECOND_MCP_SCOPE");
  }, 20_000);

  it("never gives Bash a live path for an immutable project skill", async () => {
    temp = makeTempGhosts();
    provider = await startMockProvider({ script: [{ kind: "text", text: "unused" }] });
    const ghostDir = seedGhost(temp.root, {
      name: "casper",
      provider: { baseUrl: provider.url, modelId: provider.modelId },
    });
    const project = join(temp.root, "snapshot-skill-project");
    const skillDir = join(project, ".omp", "skills", "pinned");
    const skillFile = join(skillDir, "SKILL.md");
    const script = join(skillDir, "run.sh");
    const sideEffect = join(project, "LIVE-SKILL-EXECUTED");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      skillFile,
      "---\nname: pinned\ndescription: pinned\n---\n\nADMITTED-SKILL-BYTES\n",
    );
    writeFileSync(script, "#!/bin/sh\nprintf ADMITTED-SUBRESOURCE\n", { mode: 0o700 });

    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      retention: { idleTtlMs: 0, maxSessions: 1 },
    });
    const preview = await host.previewProject("casper", "snapshot-skill", "pi", project);
    await host.bindProject("casper", "snapshot-skill", "pi", {
      root: project,
      trustToken: preview.trustToken,
      expectedGeneration: 0,
    });

    writeFileSync(
      skillFile,
      "---\nname: pinned\ndescription: changed\n---\n\nHOSTILE-LIVE-SKILL-BYTES\n",
    );
    writeFileSync(script, `#!/bin/sh\nprintf HOSTILE-LIVE-SUBRESOURCE\ntouch ${JSON.stringify(sideEffect)}\n`);
    chmodSync(script, 0o700);

    const expectSnapshotBashRefused = async (sessionId: string, commands: readonly string[]) => {
      const opened = await host!.open("casper", sessionId);
      const bash = opened.session.getToolByName("bash");
      expect(bash).toBeDefined();
      for (const [index, command] of commands.entries()) {
        await expect(bash!.execute(`snapshot-bash-${index}`, { command }))
          .rejects.toThrow("snapshot_skill_filesystem_unsupported");
      }
      expect(existsSync(sideEffect)).toBe(false);
      return opened;
    };

    const first = await expectSnapshotBashRefused("snapshot-skill", [
      "ls skill://pinned",
      "cat skill://pinned/SKILL.md",
      "cat < skill://pinned/run.sh",
      "skill://pinned/run.sh",
      "sh skill://pinned/run.sh argument",
    ]);
    const read = first.session.getToolByName("read");
    expect(read).toBeDefined();
    const snapshotRead = await read!.execute("snapshot-read", { path: "skill://pinned" });
    expect(resultText(snapshotRead)).toContain("ADMITTED-SKILL-BYTES");
    expect(resultText(snapshotRead)).not.toContain("HOSTILE-LIVE-SKILL-BYTES");

    await host.open("casper", "cache-evictor");
    expect(first.session.isDisposed).toBe(true);
    await expectSnapshotBashRefused("snapshot-skill", [
      "ls skill://pinned",
      "skill://pinned/run.sh",
    ]);

    await host.disposeAll();
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
      retention: { idleTtlMs: 0, maxSessions: 1 },
    });
    await expectSnapshotBashRefused("snapshot-skill", [
      "ls skill://pinned",
      "skill://pinned/run.sh",
    ]);

    let liveBaseDirReads = 0;
    const inaccessibleSnapshotSkill = {
      name: "inaccessible",
      description: "snapshot path tripwire",
      filePath: "/must-not-be-read/SKILL.md",
      get baseDir(): string {
        liveBaseDirReads += 1;
        throw new Error("snapshot baseDir was touched");
      },
      source: "test",
      snapshotContent: "PINNED",
    } satisfies Skill;
    for (const command of [
      "ls skill://inaccessible",
      "cat skill://inaccessible/resource.txt",
    ]) {
      await expect(expandInternalUrls(command, { skills: [inaccessibleSnapshotSkill] }))
        .rejects.toMatchObject({
          code: "snapshot_skill_filesystem_unsupported",
          message: "snapshot_skill_filesystem_unsupported",
        });
    }
    expect(liveBaseDirReads).toBe(0);

    const liveSkillDir = join(ghostDir, "ordinary-live-skill");
    mkdirSync(liveSkillDir);
    writeFileSync(join(liveSkillDir, "resource.txt"), "ORDINARY-LIVE-SKILL");
    const liveSkill: Skill = {
      name: "ordinary",
      description: "ordinary non-snapshot control",
      filePath: join(liveSkillDir, "SKILL.md"),
      baseDir: liveSkillDir,
      source: "test",
    };
    await expect(expandInternalUrls("cat skill://ordinary/resource.txt", {
      skills: [liveSkill],
    })).resolves.toBe(`cat '${join(liveSkillDir, "resource.txt")}'`);
  }, 20_000);
});
