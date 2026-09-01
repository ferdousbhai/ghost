import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureClaudeCodeEnvironment,
  CLAUDE_CODE_CREDENTIAL_VALUE_ENV_PATTERN,
  CLAUDE_CODE_SAFE_ENV_VARS,
  findProviderCredentialEnv,
  PI_NO_TITLE_ENV_VAR,
  PI_OFFLINE_ENV_VAR,
  PROVIDER_CREDENTIAL_ENV_VARS,
  PROVIDER_ROUTING_ENV_VARS,
  scrubProviderEnv,
} from "../src/env-scrub.js";

// Catalog envVars are credentials today. If a future descriptor deliberately
// names a noncredential setting, it must be reviewed and listed here rather
// than weakening the coverage assertion.
const INTENTIONALLY_NON_CREDENTIAL_CATALOG_ENV_VARS: readonly string[] = [];

const CURRENT_CLAUDE_SAFE_ENV_BY_ROUTE = {
  direct: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CONFIG_DIR",
  ],
  profile: [
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_WORKSPACE_ID",
  ],
  bedrock: [
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_REGION",
  ],
  vertex: [
    "CLAUDE_CODE_USE_VERTEX",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "CLOUD_ML_REGION",
    "ANTHROPIC_VERTEX_BASE_URL",
  ],
  foundry: [
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
  ],
  anthropicAws: [
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_AWS_WORKSPACE_ID",
  ],
  gateway: [
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
    "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
  ],
  transport: [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "CLAUDE_CODE_CLIENT_CERT",
    "CLAUDE_CODE_CLIENT_KEY",
  ],
} as const;

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
  it("keeps the reviewed official non-secret Claude selector inventory explicit", () => {
    expect(new Set(CLAUDE_CODE_SAFE_ENV_VARS).size).toBe(CLAUDE_CODE_SAFE_ENV_VARS.length);
    for (const name of CLAUDE_CODE_SAFE_ENV_VARS) {
      expect(CLAUDE_CODE_CREDENTIAL_VALUE_ENV_PATTERN.test(name)).toBe(false);
    }
    for (const names of Object.values(CURRENT_CLAUDE_SAFE_ENV_BY_ROUTE)) {
      for (const name of names) expect(CLAUDE_CODE_SAFE_ENV_VARS).toContain(name);
    }
  });

  it.each([
    "VERTEX_REGION_CLAUDE_ACCESS_TOKEN_BACKUP",
    "VERTEX_REGION_CLAUDE_4_8_OPUS_ACCESS_TOKEN",
    "VERTEX_REGION_CLAUDE_4_8_OPUS_ACCESS_TOKEN_BACKUP",
    "VERTEX_REGION_CLAUDE_SECRET_4_8_OPUS",
    "VERTEX_REGION_CLAUDE_4_8_OPUS_SECRET_BACKUP",
    "ACCESS_TOKEN_VERTEX_REGION_CLAUDE_4_8_OPUS",
    "VERTEX_REGION_CLAUDE_4_8_OPUS_EXTRA",
    "VERTEX_REGION_CLAUDE__4_8_OPUS",
    "VERTEX_REGION_CLAUDE_4_8_opus",
    "NOT_VERTEX_REGION_CLAUDE_4_8_OPUS",
  ])("rejects adversarial Vertex selector %s", (name) => {
    const captured = captureClaudeCodeEnvironment({
      HOME: "/home/owner",
      PATH: "/usr/bin",
      [name]: "must-not-cross",
      VERTEX_REGION_CLAUDE_4_8_OPUS: "europe-west1",
    });

    expect(captured[name]).toBeUndefined();
    expect(captured.VERTEX_REGION_CLAUDE_4_8_OPUS).toBe("europe-west1");
  });

  it("derives one Claude-only environment without mutating its source", () => {
    const source: NodeJS.ProcessEnv = {
      HOME: "/home/owner",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "fi_FI.UTF-8",
      LC_OWNER_SECRET: "locale-shaped-secret",
      ANTHROPIC_API_KEY: "claude-secret",
      ANTHROPIC_AUTH_TOKEN: "claude-auth-secret",
      ANTHROPIC_BASE_URL: "https://router.invalid",
      ANTHROPIC_CUSTOM_HEADERS: "authorization: secret",
      ANTHROPIC_EXTRA_BODY: '{"credential":"secret"}',
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_EXTRA_BODY: '{"secret":"value"}',
      CLAUDE_CODE_ACCESS_TOKEN: "access-secret",
      CLAUDE_CODE_REFRESH_TOKEN: "refresh-secret",
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: "session-secret",
      AWS_PROFILE: "owner-profile",
      AWS_CONFIG_FILE: "/home/owner/.aws/config",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "container-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/owner/google.json",
      CLAUDE_CODE_CLIENT_CERT: "/home/owner/client.pem",
      AZURE_CLIENT_SECRET: "azure-secret",
      VERTEX_REGION_CLAUDE_4_8_OPUS: "europe-west1",
      VERTEX_REGION_CLAUDE_OWNER_SECRET: "vertex-secret",
      OPENAI_API_KEY: "pi-provider-secret",
      GHOSTD_API_TOKEN: "ghost-secret",
      OMP_PRIVATE_TOKEN: "omp-secret",
      PI_CONFIG_FILES: "/tmp/pi-config",
      CODEX_HOME: "/tmp/codex",
      NODE_OPTIONS: "--require=/tmp/inject.cjs",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=telemetry-secret",
      TRACEPARENT: "00-daemon-trace",
      GIT_CONFIG_KEY_0: "core.sshCommand",
      GIT_CONFIG_VALUE_0: "/tmp/inject",
      NPM_TOKEN: "npm-secret",
      GITHUB_TOKEN: "github-secret",
      DATABASE_URL: "postgres://owner:secret@localhost/ghost",
      DOCKER_CONFIG: "/home/owner/.docker",
      SERVICE_PASSWORD: "service-secret",
      FUTURE_SECRET: "future-secret",
      FUTURE_TOKEN: "future-token",
      APP_THEME: "dark",
    };
    const original = { ...source };

    const captured = captureClaudeCodeEnvironment(source);

    expect(source).toEqual(original);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captureClaudeCodeEnvironment(captured)).toBe(captured);
    expect(captured).toMatchObject({
      HOME: "/home/owner",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "fi_FI.UTF-8",
      ANTHROPIC_BASE_URL: "https://router.invalid",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      AWS_PROFILE: "owner-profile",
      AWS_CONFIG_FILE: "/home/owner/.aws/config",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/owner/google.json",
      CLAUDE_CODE_CLIENT_CERT: "/home/owner/client.pem",
      VERTEX_REGION_CLAUDE_4_8_OPUS: "europe-west1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: "ghostd/0.0.1",
    });
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_EXTRA_BODY",
      "CLAUDE_CODE_EXTRA_BODY",
      "CLAUDE_CODE_ACCESS_TOKEN",
      "CLAUDE_CODE_REFRESH_TOKEN",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN",
      "AZURE_CLIENT_SECRET",
      "GHOSTD_API_TOKEN",
      "OMP_PRIVATE_TOKEN",
      "PI_CONFIG_FILES",
      "CODEX_HOME",
      "NODE_OPTIONS",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "TRACEPARENT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "NPM_TOKEN",
      "GITHUB_TOKEN",
      "DATABASE_URL",
      "DOCKER_CONFIG",
      "SERVICE_PASSWORD",
      "FUTURE_SECRET",
      "FUTURE_TOKEN",
      "APP_THEME",
      "LC_OWNER_SECRET",
      "VERTEX_REGION_CLAUDE_OWNER_SECRET",
    ]) {
      expect(captured[name]).toBeUndefined();
    }
  });

  it("removes every Claude/cloud family from Pi after the private capture", () => {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(CLAUDE_CODE_SAFE_ENV_VARS.map((name) => [name, `native-${name}`])),
      VERTEX_REGION_CLAUDE_4_8_OPUS: "europe-west1",
      ANTHROPIC_FUTURE_NATIVE_AUTH: "future-secret",
      CLAUDE_CODE_FUTURE_AUTH_MODE: "future",
      PATH: "/usr/bin",
      HTTP_PROXY: "http://proxy.invalid",
    };

    scrubProviderEnv(env);

    for (const name of CLAUDE_CODE_SAFE_ENV_VARS) {
      if (["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
        "http_proxy", "https_proxy", "no_proxy"].includes(name)) continue;
      expect(env[name]).toBeUndefined();
    }
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

  it("retains the historical PI_NO_TITLE no-op without relying on it for titling", () => {
    const env: NodeJS.ProcessEnv = {};
    scrubProviderEnv(env);
    expect(env[PI_NO_TITLE_ENV_VAR]).toBe("1");
  });
});
