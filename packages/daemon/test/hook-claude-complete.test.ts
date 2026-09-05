import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAgentSdkModule } from "../src/claude-agent-sdk-loader.js";
import type { ClaudeCodeAuthStatus, ClaudeCodeProbeResult } from "../src/claude-code.js";
import { ghostPaths } from "../src/ghosts.js";
import { completeHookSmol, type HookSmolRuntime } from "../src/hook-smol-complete.js";
import type { HookClaudeOptions } from "../src/hook-claude-complete.js";
import { makeTempGhosts } from "./helpers/fixtures.js";

const environment = Object.freeze({ PATH: "/usr/bin", HOME: "/home/owner" });

function probed(authStatus: ClaudeCodeAuthStatus): ClaudeCodeProbeResult {
  return {
    binaryPath: "/usr/bin/claude",
    executableIdentity: "identity",
    cliVersion: "2.1.251",
    authStatus,
  };
}

function resultMessage(text: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
  } as SDKMessage;
}

function fakeSdk(
  messages: readonly SDKMessage[],
  seen: { prompt?: unknown; options?: ClaudeQueryOptions },
): ClaudeAgentSdkModule {
  return {
    query: (args: { prompt: unknown; options: ClaudeQueryOptions }) => {
      seen.prompt = args.prompt;
      seen.options = args.options;
      return (async function* () {
        for (const message of messages) yield message;
      })();
    },
  } as unknown as ClaudeAgentSdkModule;
}

/** A pi runtime here is a test failure: the Claude path must never build one. */
const noPiRuntime = async (): Promise<HookSmolRuntime> => {
  throw new Error("the Claude advisor path must not construct a pi runtime");
};

function claudeGhost(root: string, role: "advisor_model" | "smol_model"): string {
  const home = join(root, "casper");
  mkdirSync(ghostPaths(home).sessionDir, { recursive: true });
  writeFileSync(join(home, "character.md"), "# Casper\n", "utf8");
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      providers: {},
      roles: { [role]: { provider: "claude-code", modelId: "default" } },
    }),
    "utf8",
  );
  return home;
}

async function review(home: string, claude: HookClaudeOptions): Promise<string> {
  return completeHookSmol(
    { ghost_home: home, prompt: "review this turn", role: "advisor_model" },
    { runtimeFactory: noPiRuntime, claude },
  );
}

describe("Claude Code answering a background role", () => {
  it("answers the review with one toolless query and no project discovery", async () => {
    const temp = makeTempGhosts();
    try {
      const home = claudeGhost(temp.root, "advisor_model");
      const seen: { prompt?: unknown; options?: ClaudeQueryOptions } = {};
      const notes = '{"notes":[{"severity":"concern","text":"The test never fails."}]}';

      await expect(review(home, {
        probe: { read: async () => probed({ loggedIn: true, authMethod: "subscription" }) },
        loadSdk: async () => fakeSdk([resultMessage(`${notes}\n`)], seen),
        environment,
      })).resolves.toBe(notes);

      expect(seen.prompt).toBe("review this turn");
      expect(seen.options).toEqual({
        cwd: ghostPaths(realpathSync(home)).sessionDir,
        pathToClaudeCodeExecutable: "/usr/bin/claude",
        // A one-line stub only: the role's prompt itself heads the user message.
        systemPrompt: "Follow the instructions in the user message exactly.",
        settingSources: [],
        skills: [],
        plugins: [],
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        maxTurns: 1,
        persistSession: false,
        abortController: expect.any(AbortController),
        env: environment,
      });
    } finally {
      temp.cleanup();
    }
  });

  it("fails loudly when Claude Code is not installed", async () => {
    const temp = makeTempGhosts();
    try {
      const home = claudeGhost(temp.root, "advisor_model");
      await expect(review(home, {
        probe: {
          read: async () => {
            throw new Error("No `claude` executable on PATH.");
          },
        },
        loadSdk: async () => {
          throw new Error("the SDK must not load without an executable");
        },
        environment,
      })).rejects.toMatchObject({
        code: "smol_model_unavailable",
        reason: "unknown_model",
      });
    } finally {
      temp.cleanup();
    }
  });

  it("fails loudly when Claude Code is signed out", async () => {
    const temp = makeTempGhosts();
    try {
      const home = claudeGhost(temp.root, "advisor_model");
      await expect(review(home, {
        probe: { read: async () => probed({ loggedIn: false }) },
        loadSdk: async () => {
          throw new Error("the SDK must not load for a signed-out executable");
        },
        environment,
      })).rejects.toMatchObject({
        code: "smol_model_unavailable",
        reason: "no_credentials",
      });
    } finally {
      temp.cleanup();
    }
  });

  it("answers the smol role too, with the model the binding names", async () => {
    const temp = makeTempGhosts();
    try {
      const home = claudeGhost(temp.root, "smol_model");
      const seen: { prompt?: unknown; options?: ClaudeQueryOptions } = {};
      await expect(completeHookSmol(
        { ghost_home: home, prompt: "title this conversation" },
        {
          runtimeFactory: noPiRuntime,
          claude: {
            probe: { read: async () => probed({ loggedIn: true }) },
            loadSdk: async () => fakeSdk([resultMessage("Weekend plans\n")], seen),
            environment,
          },
        },
      )).resolves.toBe("Weekend plans");
      // `default` is the owner's own Claude Code default: no model is named.
      expect(seen.options).not.toHaveProperty("model");
    } finally {
      temp.cleanup();
    }
  });

  it("follows a Claude Code driver: an unset smol role is Sonnet, an unset advisor is Fable", async () => {
    const temp = makeTempGhosts();
    try {
      const home = join(temp.root, "casper");
      mkdirSync(ghostPaths(home).sessionDir, { recursive: true });
      writeFileSync(join(home, "character.md"), "# Casper\n", "utf8");
      writeFileSync(join(home, "models.json"), JSON.stringify({
        providers: {},
        roles: { chat_model: { provider: "claude-code", modelId: "default" } },
      }), "utf8");
      for (const [role, model] of [["smol_model", "sonnet"], ["advisor_model", "fable"]] as const) {
        const seen: { prompt?: unknown; options?: ClaudeQueryOptions } = {};
        await expect(completeHookSmol(
          { ghost_home: home, prompt: "go", role },
          {
            runtimeFactory: noPiRuntime,
            claude: {
              probe: { read: async () => probed({ loggedIn: true }) },
              loadSdk: async () => fakeSdk([resultMessage("ok\n")], seen),
              environment,
            },
          },
        )).resolves.toBe("ok");
        expect(seen.options?.model).toBe(model);
      }
    } finally {
      temp.cleanup();
    }
  });

  it("hands a named Claude Code model to the query", async () => {
    const temp = makeTempGhosts();
    try {
      const home = join(temp.root, "casper");
      mkdirSync(ghostPaths(home).sessionDir, { recursive: true });
      writeFileSync(join(home, "character.md"), "# Casper\n", "utf8");
      writeFileSync(
        join(home, "models.json"),
        JSON.stringify({
          providers: {},
          roles: { advisor_model: { provider: "claude-code", modelId: "opus" } },
        }),
        "utf8",
      );
      const seen: { prompt?: unknown; options?: ClaudeQueryOptions } = {};
      await expect(review(home, {
        probe: { read: async () => probed({ loggedIn: true }) },
        loadSdk: async () => fakeSdk([resultMessage("notes\n")], seen),
        environment,
      })).resolves.toBe("notes");
      expect(seen.options?.model).toBe("opus");
    } finally {
      temp.cleanup();
    }
  });

  it("treats an errored Claude result as a provider failure", async () => {
    const temp = makeTempGhosts();
    try {
      const home = claudeGhost(temp.root, "advisor_model");
      const failure = {
        type: "result",
        subtype: "error_during_execution",
        errors: ["the model hit its turn limit"],
      } as SDKMessage;
      await expect(review(home, {
        probe: { read: async () => probed({ loggedIn: true }) },
        loadSdk: async () => fakeSdk([failure], {}),
        environment,
      })).rejects.toMatchObject({
        code: "smol_model_unavailable",
        reason: "provider_error",
        message: expect.stringContaining("the model hit its turn limit"),
      });
    } finally {
      temp.cleanup();
    }
  });
});
