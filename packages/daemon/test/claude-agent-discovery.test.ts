import { describe, expect, it, vi } from "vitest";
import {
  ClaudeAgentDiscovery,
  type ClaudeAgentDiscoveryQueryInput,
} from "../src/claude-agent-discovery.js";

describe("ClaudeAgentDiscovery", () => {
  it("asks the installed native SDK session for cwd-scoped agent names without a prompt", async () => {
    const close = vi.fn();
    const supportedAgents = vi.fn(async () => [
      { name: "reviewer", description: "Review code", model: "sonnet" },
      { name: "Explore", description: "Explore the repository" },
      { name: "reviewer", description: "Duplicate", model: "opus" },
      { name: "bad\nname", description: "Unsafe name" },
    ]);
    let queryInput: ClaudeAgentDiscoveryQueryInput | undefined;
    const createQuery = vi.fn((input: ClaudeAgentDiscoveryQueryInput) => {
      queryInput = input;
      return { supportedAgents, close };
    });
    const discovery = new ClaudeAgentDiscovery({
      env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/owner/.claude" },
      probe: {
        read: async () => ({
          binaryPath: "/owner/bin/claude",
          authStatus: { loggedIn: true, authMethod: "claude.ai" },
        }),
      },
      createQuery,
    });

    await expect(discovery.list("/repo")).resolves.toEqual({
      state: "ready",
      agents: [
        { name: "reviewer", model: "sonnet" },
        { name: "Explore", model: null },
      ],
      truncated: false,
    });
    expect(queryInput?.options).toMatchObject({
      cwd: "/repo",
      env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/owner/.claude" },
      pathToClaudeCodeExecutable: "/owner/bin/claude",
      persistSession: false,
    });
    expect(queryInput?.options).not.toHaveProperty("settingSources");
    expect(queryInput?.options).not.toHaveProperty("agent");
    expect(close).toHaveBeenCalledOnce();
  });

  it("caches each cwd, refreshes explicitly, and degrades native failures", async () => {
    let now = 0;
    const supportedAgents = vi.fn(async () => [
      { name: "advisor", description: "Advise" },
    ]);
    const createQuery = vi.fn(() => ({ supportedAgents, close: vi.fn() }));
    const discovery = new ClaudeAgentDiscovery({
      now: () => now,
      ttlMs: 100,
      probe: {
        read: async () => ({ binaryPath: "/claude", authStatus: { loggedIn: true } }),
      },
      createQuery,
    });

    await discovery.list("/repo");
    await discovery.list("/repo");
    expect(createQuery).toHaveBeenCalledOnce();
    await discovery.list("/repo", true);
    expect(createQuery).toHaveBeenCalledTimes(2);
    now = 101;
    await discovery.list("/repo");
    expect(createQuery).toHaveBeenCalledTimes(3);

    const failed = new ClaudeAgentDiscovery({
      probe: { read: async () => { throw new Error("private path and token"); } },
    });
    await expect(failed.list("/repo")).resolves.toEqual({
      state: "unavailable",
      agents: [],
      truncated: false,
    });
    await expect(failed.list("relative")).resolves.toEqual({
      state: "unavailable",
      agents: [],
      truncated: false,
    });
  });

  it("makes the compact inventory bound explicit", async () => {
    const discovery = new ClaudeAgentDiscovery({
      probe: {
        read: async () => ({ binaryPath: "/claude", authStatus: { loggedIn: true } }),
      },
      createQuery: () => ({
        supportedAgents: async () => Array.from({ length: 65 }, (_value, index) => ({
          name: `agent-${index + 1}`,
          description: "Agent",
        })),
        close: () => {},
      }),
    });

    const inventory = await discovery.list("/repo");
    expect(inventory.agents).toHaveLength(64);
    expect(inventory.truncated).toBe(true);
  });

  it("bounds the complete discovery and does not start a query after a slow probe", async () => {
    vi.useFakeTimers();
    try {
      const probe = Promise.withResolvers<{
        binaryPath: string;
        authStatus: { loggedIn: boolean };
      }>();
      const createQuery = vi.fn(() => ({
        supportedAgents: vi.fn(async () => []),
        close: vi.fn(),
      }));
      const discovery = new ClaudeAgentDiscovery({
        timeoutMs: 100,
        probe: { read: () => probe.promise },
        createQuery,
      });

      const result = discovery.list("/repo");
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toEqual({
        state: "unavailable",
        agents: [],
        truncated: false,
      });

      probe.resolve({ binaryPath: "/claude", authStatus: { loggedIn: true } });
      await vi.runAllTimersAsync();
      expect(createQuery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
