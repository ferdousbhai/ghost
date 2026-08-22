import { describe, expect, it } from "vitest";
import {
  findProviderCredentialEnv,
  PI_OFFLINE_ENV_VAR,
  scrubProviderEnv,
} from "../src/env-scrub.js";

describe("scrubProviderEnv", () => {
  it("removes the credentials the spike proved leak into a ghost's model list", () => {
    const env: NodeJS.ProcessEnv = {
      GEMINI_API_KEY: "leaked",
      ANTHROPIC_API_KEY: "leaked",
      OPENAI_API_KEY: "leaked",
      OPENROUTER_API_KEY: "leaked",
      AWS_SECRET_ACCESS_KEY: "leaked",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/u/adc.json",
      PATH: "/usr/bin",
      HOME: "/home/u",
    };
    const { removed } = scrubProviderEnv(env);
    expect(removed).toContain("GEMINI_API_KEY");
    expect(removed).toContain("AWS_SECRET_ACCESS_KEY");
    expect(removed).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    // Ordinary environment is untouched.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(findProviderCredentialEnv(env)).toEqual([]);
  });

  it("catches provider variables no one enumerated, by name shape", () => {
    const env: NodeJS.ProcessEnv = {
      SOME_FUTURE_PROVIDER_API_KEY: "leaked",
      ANOTHER_AUTH_TOKEN: "leaked",
      A_THIRD_ACCESS_TOKEN: "leaked",
      NOT_A_CREDENTIAL: "fine",
    };
    scrubProviderEnv(env);
    expect(env.SOME_FUTURE_PROVIDER_API_KEY).toBeUndefined();
    expect(env.ANOTHER_AUTH_TOKEN).toBeUndefined();
    expect(env.A_THIRD_ACCESS_TOKEN).toBeUndefined();
    expect(env.NOT_A_CREDENTIAL).toBe("fine");
  });

  it("is idempotent", () => {
    const env: NodeJS.ProcessEnv = { XAI_API_KEY: "leaked" };
    expect(scrubProviderEnv(env).removed).toEqual(["XAI_API_KEY"]);
    expect(scrubProviderEnv(env).removed).toEqual([]);
  });

  it("owns the PI_OFFLINE policy in both directions", () => {
    const env: NodeJS.ProcessEnv = { PI_OFFLINE: "1" };
    scrubProviderEnv(env, { offline: false });
    expect(env[PI_OFFLINE_ENV_VAR]).toBeUndefined();
    scrubProviderEnv(env, { offline: true });
    expect(env[PI_OFFLINE_ENV_VAR]).toBe("1");
    // Unspecified leaves whatever policy was last applied.
    scrubProviderEnv(env);
    expect(env[PI_OFFLINE_ENV_VAR]).toBe("1");
  });
});
