import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeGhostModels } from "../src/models.js";
import { openAiCompatiblePreset } from "./helpers/models-presets.js";
import { GhostPiRuntime } from "../src/pi-runtime.js";
import { makeTempGhosts, useCleanups } from "./helpers/fixtures.js";
import { startMockProvider, type MockProvider } from "./helpers/mock-provider.js";

const cleanups = useCleanups();

function tempRoot(): string {
  const temp = makeTempGhosts();
  cleanups.push(() => temp.cleanup());
  return temp.root;
}

describe("GhostPiRuntime", () => {
  async function runtimeFixture(): Promise<{
    runtime: GhostPiRuntime;
    home: string;
    agentDir: string;
    provider: MockProvider;
  }> {
    const machine = tempRoot();
    const provider = await startMockProvider({ script: [{ kind: "text", text: "pong" }], modelId: "fake-1" });
    cleanups.push(() => provider.close());
    const home = join(machine, "ghost");
    mkdirSync(home);
    writeGhostModels(home, openAiCompatiblePreset({
      providerId: "fake",
      name: "Fake",
      baseUrl: provider.url,
      modelId: "fake-1",
      apiKey: "literal-secret",
    }));
    const agentDir = join(home, ".pi");
    const runtime = await GhostPiRuntime.create({
      home,
      agentDir,
      allowModelNetwork: false,
    });
    cleanups.push(() => runtime.close());
    return { runtime, home, agentDir, provider };
  }

  function models(home: string): { providers: { fake: { apiKey: string } } } {
    return JSON.parse(readFileSync(join(home, "models.json"), "utf8"));
  }

  it("completes through pi with the literal key models.json names", async () => {
    const { runtime, home, agentDir, provider } = await runtimeFixture();
    expect(models(home).providers.fake.apiKey).toBe("literal-secret");
    expect(readFileSync(join(agentDir, "models.pi.json"), "utf8")).toContain("literal-secret");

    const model = runtime.getModel("fake", "fake-1");
    expect(model).toBeDefined();
    expect(runtime.getProviderAuthStatus("fake")).toMatchObject({ configured: true });
    expect(runtime.isUsingOAuth("fake")).toBe(false);
    expect(runtime.getProviders().find((entry) => entry.id === "openai-codex")).toMatchObject({
      auth: { oauth: { isSubscription: true } },
    });

    const reply = await runtime.complete(model!, {
      messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
    });
    expect(reply.content).toEqual([{ type: "text", text: "pong " }]);
    expect(provider.requests).toMatchObject([{ authorization: "Bearer literal-secret", model: "fake-1" }]);
  });

  it("logs an API key into pi's auth.json and logs it out again", async () => {
    const { runtime, agentDir } = await runtimeFixture();
    const credential = await runtime.login("anthropic", "api_key", {
      notify: () => {},
      prompt: async (prompt) => {
        expect(prompt.type).toBe("secret");
        return "sk-ant-test";
      },
    });
    expect(credential).toEqual({ type: "api_key", key: "sk-ant-test" });
    const authPath = join(agentDir, "auth.json");
    expect(existsSync(authPath)).toBe(true);
    expect(readFileSync(authPath, "utf8")).toContain("sk-ant-test");
    expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);

    await runtime.logout("anthropic");
    expect(readFileSync(authPath, "utf8")).not.toContain("sk-ant-test");
    expect(runtime.hasConfiguredAuth("anthropic")).toBe(false);
  });
});
