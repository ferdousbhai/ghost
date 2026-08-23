import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtinProviderPreset,
  ghostAuthPath,
  ghostModelsLockPath,
  ghostModelsPath,
  GhostModelsWriteConflictError,
  openAiCompatiblePreset,
  openRouterPreset,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_FREE_MODEL,
  readGhostModels,
  resolveChatModelRef,
  setChatModelRole,
  writeGhostModels,
} from "../src/models.js";

let dir: string | null = null;

function makeAgentDir(): string {
  dir = mkdtempSync(join(tmpdir(), "ghostd-models-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
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

  function lockHoldingChild(lockPath: string, holdMs: number) {
    return spawn(process.execPath, [
      "-e",
      [
        "const fs = require('node:fs');",
        "const lockPath = process.argv[1];",
        "const holdMs = Number(process.argv[2]);",
        "fs.writeFileSync(lockPath, JSON.stringify({",
        "  token: 'child-owner', pid: process.pid,",
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

    setChatModelRole(agentDir, "local", "after-wait");
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
      setChatModelRole(agentDir, "local", "blocked");
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
    // Crash leftovers are deliberately fail-closed and require explicit
    // operator inspection/removal; tests clean up their own fixture.
    expect(existsSync(lockPath)).toBe(true);
  });

  it("reports a re-entrant same-process lock without breaking it", () => {
    const agentDir = makeAgentDir();
    const lockPath = ghostModelsLockPath(agentDir);
    writeFileSync(lockPath, `${JSON.stringify({
      token: "same-process-owner",
      pid: process.pid,
    })}\n`, { mode: 0o600 });

    expect(() => setChatModelRole(agentDir, "local", "blocked")).toThrowError(
      expect.objectContaining({
        code: "ghost_models_write_conflict",
        ownerPid: process.pid,
        retryable: false,
      }),
    );
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

describe("pi compatibility", () => {
  it("loads our models.json — including the roles key pi does not know", async () => {
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
    const runtime = await ModelRuntime.create({
      authPath: ghostAuthPath(agentDir),
      modelsPath: ghostModelsPath(agentDir),
      allowModelNetwork: false,
    });
    // A schema rejection would surface here rather than as a missing model.
    expect(runtime.getError()).toBeUndefined();
    const model = runtime.getModel("ghost-local", "mock-ghost-1");
    expect(model?.baseUrl).toBe("http://127.0.0.1:1/v1");
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
    // pi-messages is a first-class api value, so a relay backend is declared
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
