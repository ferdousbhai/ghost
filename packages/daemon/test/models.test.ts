import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readUserProviders,
  userAuthPath,
  ghostModelsLockPath,
  ghostModelsPath,
  GhostModelsWriteConflictError,
  GhostModelsLockError,
  readGhostModels,
  resolveChatModelRef,
  resolveModelRoleRef,
  setGhostModelRole,
  withSerializedModelsWrite,
  writeGhostModels,
} from "../src/models.js";
import {
  builtinProviderPreset,
  openAiCompatiblePreset,
  openRouterPreset,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_FREE_MODEL,
} from "./helpers/models-presets.js";
import { createGhostPiRuntime } from "../src/pi-runtime.js";
import { MAX_PRIVATE_FILE_BYTES } from "../src/private-file.js";

let dir: string | null = null;

function makeAgentDir(): string {
  dir = mkdtempSync(join(tmpdir(), "ghostd-models-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("a home written before the Claude Code runtime was removed", () => {
  it("forgets every role naming the gone provider", () => {
    const dir = makeAgentDir();
    writeFileSync(ghostModelsPath(dir), JSON.stringify({
      providers: {},
      roles: {
        chat_model: { provider: "claude-code", modelId: "default" },
        smol_model: { provider: "claude-code", modelId: "sonnet" },
        advisor_model: { provider: "openrouter", modelId: "keep/me" },
      },
    }), { mode: 0o600 });

    const models = readGhostModels(dir);
    // The dead bindings are gone, so the chat role falls to pi's catalogue
    // default and the background roles resolve themselves again instead of
    // failing every title and greeting with unknown_model.
    expect(models?.roles?.chat_model).toBeUndefined();
    expect(models?.roles?.smol_model).toBeUndefined();
    expect(resolveChatModelRef(models)).toBeNull();
    expect(resolveModelRoleRef(models, "smol_model")).toBeNull();
    // Everything that still exists is untouched.
    expect(models?.roles?.advisor_model).toEqual({ provider: "openrouter", modelId: "keep/me" });
  });

  it("leaves a home that never named it byte-identical", () => {
    const dir = makeAgentDir();
    const file = {
      providers: {},
      roles: { chat_model: { provider: "openrouter", modelId: "a/b" } },
    };
    writeFileSync(ghostModelsPath(dir), JSON.stringify(file), { mode: 0o600 });
    expect(readGhostModels(dir)?.roles).toEqual(file.roles);
  });
});

describe("models.json round-trip", () => {
  it("returns null when the ghost has no models.json", () => {
    expect(readGhostModels(makeAgentDir())).toBeNull();
  });

  it("writes and reads pi's native shape plus our roles key", () => {
    const agentDir = makeAgentDir();
    writeGhostModels(agentDir, openRouterPreset({ apiKey: "sk-or-test" }));
    const file = readGhostModels(agentDir);
    expect(file?.providers.openrouter?.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(file?.providers.openrouter?.apiKey).toBe("sk-or-test");
    expect(file?.roles?.chat_model).toEqual({
      provider: "openrouter",
      modelId: OPENROUTER_DEFAULT_FREE_MODEL,
    });
  });

  it("preserves unknown top-level provider configuration while mutating routing", () => {
    const agentDir = makeAgentDir();
    writeFileSync(ghostModelsPath(agentDir), `${JSON.stringify({
      providers: {},
      futureSetting: { enabled: true },
    })}\n`, "utf8");
    setGhostModelRole(agentDir, "advisor_model", "openai-codex", "gpt-5.6");
    expect(readGhostModels(agentDir)).toMatchObject({
      futureSetting: { enabled: true },
      roles: { advisor_model: { provider: "openai-codex", modelId: "gpt-5.6" } },
    });
  });

  it("recovers an interrupted portable CAS before an ordinary role mutation", () => {
    const agentDir = makeAgentDir();
    const path = ghostModelsPath(agentDir);
    writeFileSync(path, `${JSON.stringify({
      providers: { retained: { apiKey: "retained-key" } },
      futureSetting: { retained: true },
    })}\n`, { mode: 0o600 });
    renameSync(path, `${path}.ghost-migration-cas`);

    setGhostModelRole(agentDir, "chat_model", "retained", "model-after-recovery");

    expect(readGhostModels(agentDir)).toMatchObject({
      providers: { retained: { apiKey: "retained-key" } },
      futureSetting: { retained: true },
      roles: { chat_model: { provider: "retained", modelId: "model-after-recovery" } },
    });
    expect(existsSync(`${path}.ghost-migration-cas`)).toBe(false);
  });

  it("replaces a permissive models.json atomically with mode 0600", () => {
    const agentDir = makeAgentDir();
    const path = ghostModelsPath(agentDir);
    writeFileSync(path, '{"providers":{}}\n', { encoding: "utf8", mode: 0o644 });
    chmodSync(path, 0o644);
    const originalInode = statSync(path).ino;

    writeGhostModels(agentDir, openRouterPreset({ apiKey: "sk-private" }));

    const replaced = statSync(path);
    expect(replaced.mode & 0o777).toBe(0o600);
    // A direct truncating write keeps the inode; a same-directory atomic
    // replacement publishes the fully-written temporary inode in one rename.
    expect(replaced.ino).not.toBe(originalInode);
    expect(readGhostModels(agentDir)?.providers.openrouter?.apiKey).toBe("sk-private");
  });

  it("bounds the complete pretty-printed models.json before publication", () => {
    const agentDir = makeAgentDir();
    const path = ghostModelsPath(agentDir);
    const empty = { providers: {}, padding: "" };
    const baseBytes = Buffer.byteLength(`${JSON.stringify(empty, null, 2)}\n`);
    const exact = {
      providers: {},
      padding: "x".repeat(MAX_PRIVATE_FILE_BYTES - baseBytes),
    };

    writeGhostModels(agentDir, exact);
    expect(readFileSync(path)).toHaveLength(MAX_PRIVATE_FILE_BYTES);
    const before = readFileSync(path);

    const prettyExpansion = { providers: {}, future: Array(150_000).fill(0) };
    expect(Buffer.byteLength(JSON.stringify(prettyExpansion))).toBeLessThan(MAX_PRIVATE_FILE_BYTES);
    expect(Buffer.byteLength(`${JSON.stringify(prettyExpansion, null, 2)}\n`))
      .toBeGreaterThan(MAX_PRIVATE_FILE_BYTES);
    expect(() => writeGhostModels(agentDir, prettyExpansion)).toThrow(/1 MiB/);
    expect(readFileSync(path)).toEqual(before);
  });

  function lockHoldingChild(lockPath: string, holdMs: number) {
    return spawn(process.execPath, [
      "-e",
      [
        "const fs = require('node:fs');",
        "const lockPath = process.argv[1];",
        "const holdMs = Number(process.argv[2]);",
        "const raw = fs.readFileSync('/proc/self/stat', 'utf8');",
        "const startTicks = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\\s+/)[19];",
        "fs.writeFileSync(lockPath, JSON.stringify({",
        "  token: 'child-owner', pid: process.pid, startTicks,",
        "}) + '\\n', { mode: 0o600 });",
        "process.stdout.write('ready\\n');",
        "setTimeout(() => {",
        "  fs.unlinkSync(lockPath);",
        "}, holdMs);",
      ].join("\n"),
      lockPath,
      String(holdMs),
    ], { stdio: ["ignore", "pipe", "pipe"] });
  }

  it("waits for a cross-process writer and then commits without losing its update", async () => {
    const agentDir = makeAgentDir();
    const lockPath = ghostModelsLockPath(agentDir);
    const child = lockHoldingChild(lockPath, 100);
    await once(child.stdout, "data");
    const childExited = once(child, "exit");

    setGhostModelRole(agentDir, "chat_model", "local", "after-wait");
    await childExited;
    expect(existsSync(lockPath)).toBe(false);
    expect(readGhostModels(agentDir)?.roles?.chat_model?.modelId).toBe("after-wait");
  });

  it("times out with a typed conflict without breaking another process's lock", async () => {
    const agentDir = makeAgentDir();
    const lockPath = ghostModelsLockPath(agentDir);
    const child = lockHoldingChild(lockPath, 2_000);
    await once(child.stdout, "data");

    let conflict: unknown;
    try {
      setGhostModelRole(agentDir, "chat_model", "local", "blocked");
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(GhostModelsWriteConflictError);
    expect(conflict).toMatchObject({
      code: "ghost_models_write_conflict",
      lockPath,
      ownerPid: child.pid,
      retryable: true,
    });
    expect(existsSync(lockPath)).toBe(true);

    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect(existsSync(lockPath)).toBe(true);

    setGhostModelRole(agentDir, "chat_model", "local", "after-crash");
    expect(existsSync(lockPath)).toBe(false);
    expect(readGhostModels(agentDir)?.roles?.chat_model?.modelId).toBe("after-crash");
  });

  it("reports a re-entrant same-process lock without breaking it", () => {
    const agentDir = makeAgentDir();
    const lockPath = ghostModelsLockPath(agentDir);
    withSerializedModelsWrite(ghostModelsPath(agentDir), () => {
      expect(() => setGhostModelRole(agentDir, "chat_model", "local", "blocked")).toThrowError(
        expect.objectContaining({
          code: "ghost_models_write_conflict",
          ownerPid: process.pid,
          retryable: false,
        }),
      );
      expect(existsSync(lockPath)).toBe(true);
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a reused PID only when its process-start identity differs", () => {
    const agentDir = makeAgentDir();
    const lockPath = ghostModelsLockPath(agentDir);
    writeFileSync(lockPath, `${JSON.stringify({
      token: "old-incarnation",
      pid: process.pid,
      startTicks: "1",
    })}\n`, { mode: 0o600 });

    setGhostModelRole(agentDir, "chat_model", "local", "after-pid-reuse");

    expect(existsSync(lockPath)).toBe(false);
    expect(readGhostModels(agentDir)?.roles?.chat_model?.modelId).toBe("after-pid-reuse");
  });

  it("finishes a dead owner's interrupted reclaim before acquiring", () => {
    const agentDir = makeAgentDir();
    const lockPath = ghostModelsLockPath(agentDir);
    const claim = `${lockPath}.reclaim-dead-fixture`;
    writeFileSync(claim, `${JSON.stringify({
      token: "dead-reclaimer",
      pid: process.pid,
      startTicks: "1",
    })}\n`, { mode: 0o600 });

    setGhostModelRole(agentDir, "chat_model", "local", "after-reclaim");

    expect(existsSync(claim)).toBe(false);
    expect(readGhostModels(agentDir)?.roles?.chat_model?.modelId).toBe("after-reclaim");
  });

  it("leaves ambiguous owner evidence for explicit manual cleanup", () => {
    const agentDir = makeAgentDir();
    const lockPath = ghostModelsLockPath(agentDir);
    writeFileSync(lockPath, `${JSON.stringify({
      token: "legacy-owner-without-start-identity",
      pid: 999_999,
    })}\n`, { mode: 0o600 });

    let failure: unknown;
    try {
      setGhostModelRole(agentDir, "chat_model", "local", "blocked");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GhostModelsLockError);
    expect((failure as Error).message).toContain("remove it manually");
    expect(existsSync(lockPath)).toBe(true);
  });

  it("refuses a malformed file rather than running on a default", () => {
    const agentDir = makeAgentDir();
    writeFileSync(ghostModelsPath(agentDir), "{ nope", "utf8");
    expect(() => readGhostModels(agentDir)).toThrowError(/not valid JSON/);
  });
});

describe("resolveChatModelRef", () => {
  it("prefers the explicit role binding", () => {
    const file = openAiCompatiblePreset({
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen3:8b",
    });
    expect(resolveChatModelRef(file)).toEqual({ provider: "ollama", modelId: "qwen3:8b" });
  });

  it("falls back to the first declared model when there are no roles", () => {
    const file = openAiCompatiblePreset({
      providerId: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-1",
    });
    delete file.roles;
    expect(resolveChatModelRef(file)).toEqual({ provider: "vllm", modelId: "local-1" });
  });

  it("returns null when nothing is configured, so pi's own default applies", () => {
    expect(resolveChatModelRef(null)).toBeNull();
    expect(resolveChatModelRef({ providers: {} })).toBeNull();
  });

  it("binds a provider pi already knows without declaring an endpoint", () => {
    const file = builtinProviderPreset("openai-codex", "gpt-5-codex");
    expect(file.providers).toEqual({});
    expect(resolveChatModelRef(file)).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5-codex",
    });
  });
});

describe("the legacy title_model role", () => {
  function writeRaw(agentDir: string, file: unknown): void {
    writeFileSync(ghostModelsPath(agentDir), `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }

  function readRaw(agentDir: string): { roles?: Record<string, unknown> } {
    return JSON.parse(readFileSync(ghostModelsPath(agentDir), "utf8"));
  }

  it("reads a legacy-only file as smol_model", () => {
    const agentDir = makeAgentDir();
    writeRaw(agentDir, {
      providers: {},
      roles: { title_model: { provider: "anthropic", modelId: "claude-haiku-4-5" } },
    });
    const file = readGhostModels(agentDir);
    expect(file?.roles).toEqual({
      smol_model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    });
    expect(resolveModelRoleRef(file, "smol_model")).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
  });

  it("prefers smol_model when a file carries both keys", () => {
    const agentDir = makeAgentDir();
    writeRaw(agentDir, {
      providers: {},
      roles: {
        title_model: { provider: "stale", modelId: "old" },
        smol_model: { provider: "fresh", modelId: "new" },
      },
    });
    const file = readGhostModels(agentDir);
    expect(file?.roles).toEqual({ smol_model: { provider: "fresh", modelId: "new" } });
  });

  it("drops the stale key from disk the next time a role is written", () => {
    const agentDir = makeAgentDir();
    writeRaw(agentDir, {
      providers: {},
      roles: {
        chat_model: { provider: "openai-codex", modelId: "gpt-5.6" },
        title_model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      },
    });
    setGhostModelRole(agentDir, "smol_model", "openrouter", "cheap-1");
    const raw = readRaw(agentDir);
    expect(raw.roles).toEqual({
      chat_model: { provider: "openai-codex", modelId: "gpt-5.6" },
      smol_model: { provider: "openrouter", modelId: "cheap-1" },
    });
    expect("title_model" in (raw.roles ?? {})).toBe(false);
  });

  it("migrates the stale key even when another role is the one being written", () => {
    const agentDir = makeAgentDir();
    writeRaw(agentDir, {
      providers: {},
      roles: { title_model: { provider: "anthropic", modelId: "claude-haiku-4-5" } },
    });
    setGhostModelRole(agentDir, "chat_model", "openai-codex", "gpt-5.6");
    expect(readRaw(agentDir).roles).toEqual({
      smol_model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      chat_model: { provider: "openai-codex", modelId: "gpt-5.6" },
    });
  });
});

describe("Pi runtime compatibility", () => {
  it("loads our models.json after projecting Ghost-only routing keys", async () => {
    const agentDir = makeAgentDir();
    writeGhostModels(
      agentDir,
      openAiCompatiblePreset({
        providerId: "ghost-local",
        baseUrl: "http://127.0.0.1:1/v1",
        modelId: "mock-ghost-1",
        apiKey: "not-needed",
      }),
    );
    const runtime = await createGhostPiRuntime({
      authPath: join(agentDir, "auth.json"),
      modelsPath: ghostModelsPath(agentDir),
      allowModelNetwork: false,
    });
    // A schema rejection would surface here rather than as a missing model.
    expect(runtime.runtime.getError()).toBeUndefined();
    const model = runtime.getModel("ghost-local", "mock-ghost-1");
    expect(model?.baseUrl).toBe("http://127.0.0.1:1/v1");
    runtime.close();
  });

  it("reads provider declarations the owner keeps for the machine", () => {
    // An endpoint and how to reach it is a fact about this machine. Kept per
    // ghost, the same local server had to be described once per ghost, with any
    // device-local key copied beside each description.
    const previous = process.env.PI_CODING_AGENT_DIR;
    const agentDir = mkdtempSync(join(tmpdir(), "ghostd-user-providers-"));
    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      expect(readUserProviders()).toEqual({});

      writeFileSync(join(agentDir, "models.json"), JSON.stringify({
        providers: { "ghost-local": { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions" } },
      }));
      expect(readUserProviders()["ghost-local"]).toMatchObject({ baseUrl: "http://127.0.0.1:1/v1" });

      // Unreadable or wrongly shaped means the machine declares nothing; a
      // ghost's own file must still be read.
      writeFileSync(join(agentDir, "models.json"), "{ not json");
      expect(readUserProviders()).toEqual({});
      writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { bad: "nope" } }));
      expect(readUserProviders()).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("takes credentials from pi's user-level store, not from inside the ghost", () => {
    // A credential belongs to the person. Every ghost resolving to the same
    // store is what makes "sign in once" true; the per-ghost file is why a
    // second ghost could name a provider it had no key for.
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-fixture";
      expect(userAuthPath()).toBe("/tmp/pi-agent-fixture/auth.json");
      expect(userAuthPath()).not.toContain("ghosts");
      delete process.env.PI_CODING_AGENT_DIR;
      expect(userAuthPath()).toBe(join(homedir(), ".pi", "agent", "auth.json"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("reads pi's auth.json as the credential store", async () => {
    const agentDir = makeAgentDir();
    const authPath = join(agentDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      openrouter: { type: "api_key", key: "stored-secret" },
    }), { encoding: "utf8", mode: 0o600 });

    const runtime = await createGhostPiRuntime({
      authPath,
      modelsPath: ghostModelsPath(agentDir),
      allowModelNetwork: false,
    });
    await expect(runtime.runtime.getAuth("openrouter")).resolves.toMatchObject({
      auth: { apiKey: "stored-secret" },
    });
    // pi's file is the only credential store: nothing copies it anywhere else.
    expect(existsSync(authPath)).toBe(true);
    expect(existsSync(join(agentDir, "agent.db"))).toBe(false);
    expect(readGhostModels(agentDir)).toBeNull();
    runtime.close();
  });

  it("is provider-agnostic: any OpenAI-compatible endpoint is one preset call", () => {
    for (const [providerId, baseUrl] of [
      ["ollama", "http://127.0.0.1:11434/v1"],
      ["lmstudio", "http://127.0.0.1:1234/v1"],
      ["relay", "https://relay.example/v1"],
    ] as const) {
      const file = openAiCompatiblePreset({ providerId, baseUrl, modelId: "m" });
      expect(file.providers[providerId]?.baseUrl).toBe(baseUrl);
      expect(file.providers[providerId]?.api).toBe("openai-completions");
    }
    // pi-messages is a first-class API value, so a relay backend is declared
    // the same way as any other provider.
    const relay = openAiCompatiblePreset({
      providerId: "relay",
      baseUrl: "https://relay.example",
      modelId: "ghost/ferdousbhai",
      api: "pi-messages",
    });
    expect(relay.providers.relay?.api).toBe("pi-messages");
  });
});
