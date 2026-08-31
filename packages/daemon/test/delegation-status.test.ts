import { describe, expect, it } from "vitest";
import {
  renderDelegationStatus,
  type DelegationStatusView,
} from "../src/delegation-status.js";

function view(): DelegationStatusView {
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

describe("delegation status rendering", () => {
  it("renders the native inventory and Omarchy reset windows compactly", () => {
    expect(renderDelegationStatus(view(), Date.parse("2026-08-31T06:41:30.000Z"))).toBe([
      "# Delegation",
      "harnesses claude-code=ready codex=ready pi=installed",
      "limits claude session=95%→2h38m weekly=37%→3d10h | codex weekly=96%→6d19h !stale",
      'claude-agents "advisor"@"opus", "reviewer"',
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

    expect(renderDelegationStatus(resources)).toContain(
      "limits claude=missing | codex=invalid",
    );
  });

});
