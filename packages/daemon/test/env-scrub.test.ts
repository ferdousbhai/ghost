import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findProviderCredentialEnv,
  PI_OFFLINE_ENV_VAR,
  PROVIDER_CREDENTIAL_ENV_VARS,
  PROVIDER_ROUTING_ENV_VARS,
  scrubProviderEnv,
} from "../src/env-scrub.js";

// Catalog envVars are credentials today. If a future descriptor deliberately
// names a noncredential setting, it must be reviewed and listed here rather
// than weakening the coverage assertion.
const INTENTIONALLY_NON_CREDENTIAL_CATALOG_ENV_VARS: readonly string[] = [];

/**
 * Every credential variable pi's provider registry reads. pi keeps the table
 * private, so it is pinned by scanning its compiled module for variable names.
 */
function pinnedCatalogEnvVars(): string[] {
  const piAiPackage = createRequire(import.meta.url).resolve("@earendil-works/pi-ai/package.json");
  const source = readFileSync(join(dirname(piAiPackage), "dist", "env-api-keys.js"), "utf8");
  return [...new Set(
    [...source.matchAll(/"([A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_KEY|_CREDENTIALS))"/g)].map((match) => match[1]!),
  )].sort();
}

describe("scrubProviderEnv", () => {
  // One representative name per prefix the family rule covers, plus the three
  // bare names and the Vertex shape it special-cases. Proxy settings are the
  // documented exception: a scrubbed child still has to reach the network.
  const CLAUDE_FAMILY_SAMPLE = [
    "ANTHROPIC_BASE_URL", "AWS_PROFILE", "AZURE_CLIENT_ID", "CLAUDE_CONFIG_DIR",
    "GCLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS",
    "CLAUDECODE", "CLOUD_ML_REGION", "USE_VERTEX",
  ] as const;

  it("removes the whole Claude/cloud family, including names nobody enumerated", () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(CLAUDE_FAMILY_SAMPLE.map((name) => [name, `native-${name}`])),
      VERTEX_REGION_CLAUDE_4_8_OPUS: "europe-west1",
      ANTHROPIC_FUTURE_NATIVE_AUTH: "future-secret",
      CLAUDE_CODE_FUTURE_AUTH_MODE: "future",
      PATH: "/usr/bin",
      HTTP_PROXY: "http://proxy.invalid",
    };

    scrubProviderEnv(env);

    for (const name of CLAUDE_FAMILY_SAMPLE) expect(env[name]).toBeUndefined();
    expect(env.VERTEX_REGION_CLAUDE_4_8_OPUS).toBeUndefined();
    expect(env.ANTHROPIC_FUTURE_NATIVE_AUTH).toBeUndefined();
    expect(env.CLAUDE_CODE_FUTURE_AUTH_MODE).toBeUndefined();
    expect(env.HTTP_PROXY).toBe("http://proxy.invalid");
    expect(env.PATH).toBe("/usr/bin");
  });

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

  it("classifies and scrubs every pinned provider-catalog environment fallback", () => {
    const catalogEnvVars = pinnedCatalogEnvVars();
    const parent = Object.fromEntries(
      catalogEnvVars.map((name) => [name, `hostile-${name}`]),
    );
    const sessionEnv = { ...parent };

    const { removed } = scrubProviderEnv(sessionEnv);
    const intentionallyRetained = [...INTENTIONALLY_NON_CREDENTIAL_CATALOG_ENV_VARS].sort();

    expect(intentionallyRetained.filter((name) => !catalogEnvVars.includes(name))).toEqual([]);
    expect(removed).toEqual(
      catalogEnvVars.filter((name) => !intentionallyRetained.includes(name)),
    );
    expect(catalogEnvVars.filter((name) =>
      !removed.includes(name) && !intentionallyRetained.includes(name))).toEqual([]);
    expect(catalogEnvVars.filter((name) => sessionEnv[name] !== undefined))
      .toEqual(intentionallyRetained);
    expect(parent).toEqual(Object.fromEntries(
      catalogEnvVars.map((name) => [name, `hostile-${name}`]),
    ));
    expect(findProviderCredentialEnv(sessionEnv)).toEqual([]);
  });

  it("explicitly enumerates catalog token names that have no credential suffix", () => {
    for (const name of ["GITLAB_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"]) {
      expect(PROVIDER_CREDENTIAL_ENV_VARS).toContain(name);
      expect(findProviderCredentialEnv({ [name]: "hostile" })).toEqual([name]);
    }
  });

  it("removes Claude transport, profile, federation, and credential selectors", () => {
    const names = [
      "ANTHROPIC_CONFIG_DIR",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_IDENTITY_TOKEN",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_PROFILE",
      "ANTHROPIC_SCOPE",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
      "ANTHROPIC_UNIX_SOCKET",
      "ANTHROPIC_WORKSPACE_ID",
      "CLAUDE_CODE_CLIENT_CERT",
      "CLAUDE_CODE_CLIENT_KEY",
      "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
      "CLAUDE_CODE_OAUTH_CLIENT_ID",
      "CLAUDE_CODE_ORGANIZATION_UUID",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
      "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    ];
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      names.map((name) => [name, `hostile-${name}`]),
    );
    expect(scrubProviderEnv(env).removed).toEqual([...names].sort());
    expect(findProviderCredentialEnv(env)).toEqual([]);
    for (const name of names) expect(env[name]).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
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

  it("removes routing overrides that can redirect or change Claude turns", () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(PROVIDER_ROUTING_ENV_VARS.map((name) => [name, "ambient"])),
      VERTEX_REGION_CLAUDE_4_5_SONNET: "ambient-region",
      PATH: "/usr/bin",
    };

    const { removed } = scrubProviderEnv(env);

    expect(removed).toEqual(
      [...PROVIDER_ROUTING_ENV_VARS, "VERTEX_REGION_CLAUDE_4_5_SONNET"].sort(),
    );
    expect(findProviderCredentialEnv(env)).toEqual([]);
    expect(env.PATH).toBe("/usr/bin");
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
