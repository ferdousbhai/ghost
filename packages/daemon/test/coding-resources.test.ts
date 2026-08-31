import { describe, expect, it, vi } from "vitest";
import {
  CodingResources,
  renderCodingResources,
  type CodingResourcesView,
} from "../src/coding-resources.js";

function view(): CodingResourcesView {
  return {
    claudeAgents: {
      state: "ready",
      agents: [
        { name: "advisor", model: "opus" },
        { name: "reviewer", model: null },
      ],
      truncated: false,
    },
    harnesses: [
      {
        id: "claude-code",
        name: "Claude Code",
        kind: "native",
        nativeConfiguration: true,
        installation: "installed",
        authentication: "authenticated",
        reason: null,
        usage: {
          source: "omarchy",
          state: "ready",
          updatedAt: "2026-08-31T05:35:36.000Z",
          stale: false,
          tier: "Max",
          status: null,
          help: null,
          limits: [
            {
              label: "Session (5-hour)",
              usedFraction: 0.05,
              resetsAt: "2026-08-31T09:20:00.000Z",
            },
            {
              label: "Weekly (7-day)",
              usedFraction: 0.63,
              resetsAt: "2026-09-03T17:00:00.000Z",
            },
          ],
          today: null,
        },
      },
      {
        id: "codex",
        name: "Codex",
        kind: "native",
        nativeConfiguration: true,
        installation: "installed",
        authentication: "authenticated",
        reason: null,
        usage: {
          source: "omarchy",
          state: "ready",
          updatedAt: "2026-08-31T05:35:36.000Z",
          stale: true,
          tier: "Pro",
          status: null,
          help: null,
          limits: [{
            label: "Weekly (7-day)",
            usedFraction: 0.04,
            resetsAt: "2026-09-07T02:25:33.000Z",
          }],
          today: null,
        },
      },
      {
        id: "pi",
        name: "Pi",
        kind: "native",
        nativeConfiguration: true,
        installation: "installed",
        authentication: "unknown",
        reason: null,
        usage: null,
      },
    ],
  };
}

describe("coding resources", () => {
  it("renders the native inventory and Omarchy reset windows compactly", () => {
    expect(renderCodingResources(view())).toBe([
      "# Coding resources",
      "Harnesses: claude-code=ready, codex=ready, pi=installed",
      'Claude agents here: "advisor"@"opus", "reviewer"',
      "Limits: claude-code Session (5-hour) 95% left→2026-08-31T09:20:00Z; Weekly (7-day) 37% left→2026-09-03T17:00:00Z | codex Weekly (7-day) 96% left→2026-09-07T02:25:33Z [stale]",
    ].join("\n"));
  });

  it("keeps missing and invalid Omarchy records explicit", () => {
    const resources = view();
    const [claude, codex] = resources.harnesses;
    if (!claude?.usage || !codex?.usage) {
      throw new Error("Expected Claude and Codex usage fixtures.");
    }
    claude.usage = { ...claude.usage, state: "missing", limits: [] };
    codex.usage = { ...codex.usage, state: "invalid", limits: [] };

    expect(renderCodingResources(resources)).toContain(
      "Limits: claude-code=missing | codex=invalid",
    );
  });

  it("caches per cwd and lets harness_status force a refresh", async () => {
    let now = 0;
    const harnesses = { list: vi.fn(async () => ({ harnesses: view().harnesses })) };
    const claudeAgents = { list: vi.fn(async () => view().claudeAgents) };
    const resources = new CodingResources({
      harnesses,
      claudeAgents,
      now: () => now,
      ttlMs: 100,
    });

    await resources.view("/repo");
    await resources.view("/repo");
    expect(harnesses.list).toHaveBeenCalledOnce();
    expect(claudeAgents.list).toHaveBeenCalledOnce();
    await resources.view("/repo", true);
    expect(harnesses.list).toHaveBeenCalledTimes(2);
    expect(claudeAgents.list).toHaveBeenLastCalledWith("/repo", true);
    now = 101;
    await resources.view("/repo");
    expect(harnesses.list).toHaveBeenCalledTimes(3);
    expect(() => resources.view("relative")).toThrow(/absolute/);
  });
});
