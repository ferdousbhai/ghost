import { describe, expect, it } from "vitest";
import type { EffectiveMcpRead } from "../src/mcp-catalog.js";
import {
  buildSessionResourceView,
  type SessionSkillGroup,
} from "../src/session-resources.js";

const OBSIDIAN = "/home/owner/.agents/skills/obsidian-cli/SKILL.md";

function skills(
  source: SessionSkillGroup["source"],
  precedence: number,
  rows: SessionSkillGroup["skills"],
): SessionSkillGroup {
  return { source, precedence, skills: rows };
}

function mcp(
  input: {
    claimedNames: string[];
    servers?: Array<{ name: string; path: string; enabled?: boolean; errors?: string[] }>;
    skipped?: Array<{ path: string; reason: string }>;
  },
): EffectiveMcpRead {
  const configured = (input.servers ?? []).map((server) => ({
    name: server.name,
    source: {
      kind: "canonical" as const,
      absolutePath: server.path,
      relativePath: ".omp/mcp.json" as const,
    },
    config: { command: "server", ...(server.enabled === false ? { enabled: false } : {}) },
    errors: server.errors ?? [],
  }));
  return {
    claimedNames: input.claimedNames,
    disabled: configured.filter((server) => "enabled" in server.config
      && server.config.enabled === false).map((server) => ({
        name: server.name,
        source: server.source,
      })),
    servers: configured.filter((server) => server.errors.length === 0
      && !("enabled" in server.config && server.config.enabled === false)),
    skipped: input.skipped ?? [],
  };
}

describe("session resource admission", () => {
  it("shows skill precedence, optional Obsidian readiness, and every MCP claim outcome", () => {
    const ghostMcp = "/home/owner/ghosts/casper/mcp.json";
    const view = buildSessionResourceView({
      runtime: "pi",
      skillGroups: [
        skills("machine", 0, [
          { name: "obsidian-cli", path: OBSIDIAN, description: "Use Obsidian." },
          { name: "shared", path: "/home/owner/.agents/skills/shared/SKILL.md" },
        ]),
        skills("ghost", 1, [
          { name: "shared", path: "/home/owner/ghosts/casper/skills/shared/SKILL.md" },
        ]),
      ],
      mcpGroups: [
        {
          source: "ghost",
          precedence: 1,
          root: "/home/owner/ghosts/casper",
          effective: mcp({
            claimedNames: ["alpha", "shared", "off", "broken"],
            servers: [
              { name: "alpha", path: ghostMcp },
              { name: "shared", path: ghostMcp },
              { name: "off", path: ghostMcp, enabled: false },
              { name: "broken", path: ghostMcp, errors: ["command is required"] },
            ],
            skipped: [{
              path: "mcp.json#mcpServers.broken",
              reason: "command is required",
            }, {
              path: ".mcp.json",
              reason: "MCP config is invalid JSON",
            }],
          }),
        },
      ],
    });

    expect(view.skills).toContainEqual(expect.objectContaining({
      name: "shared",
      source: "machine",
      precedence: 0,
      status: "shadowed",
      shadowedBy: "/home/owner/ghosts/casper/skills/shared/SKILL.md",
    }));
    expect(view.skills).toContainEqual(expect.objectContaining({
      name: "shared",
      source: "ghost",
      status: "admitted",
    }));
    expect(view.mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "alpha", source: "ghost", enabled: true, status: "admitted" }),
      expect.objectContaining({ name: "shared", source: "ghost", enabled: true, status: "admitted" }),
      expect.objectContaining({ name: "off", source: "ghost", enabled: false, status: "disabled" }),
      expect.objectContaining({ name: "broken", source: "ghost", enabled: false, status: "skipped", reason: "command is required" }),
    ]));
    expect(view.mcpDiagnostics).toEqual([{
      source: "ghost",
      path: "/home/owner/ghosts/casper/.mcp.json",
      reason: "MCP config is invalid JSON",
    }]);
  });


});
