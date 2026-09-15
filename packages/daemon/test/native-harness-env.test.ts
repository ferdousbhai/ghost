import { describe, expect, it } from "vitest";
import {
  captureNativeHarnessEnvironment,
  type NativeHarnessEnvironmentProfile,
} from "../src/env-scrub.js";

const adversarialEnvironment: NodeJS.ProcessEnv = {
  HOME: "/home/owner",
  PATH: "/usr/bin",
  LANG: "en_US.UTF-8",
  LC_CTYPE: "fi_FI.UTF-8",
  LC_OWNER_SECRET: "locale-shaped-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  OPENAI_API_KEY: "openai-secret",
  CODEX_API_KEY: "codex-secret",
  PI_API_KEY: "pi-secret",
  AWS_ACCESS_KEY_ID: "access-id",
  AWS_SECRET_ACCESS_KEY: "secret-key",
  SERVICE_ACCESS_TOKEN_BACKUP: "token-backup",
  SERVICE_PASSWORD_HINT: "password-hint",
  SERVICE_SECRET_SUFFIX: "secret-suffix",
  GHOST_CLAUDE_BINARY: "/tmp/credential-wrapper",
  GHOST_CODEX_BINARY: "/tmp/credential-wrapper",
  GHOST_PI_BINARY: "/tmp/credential-wrapper",
  GHOST_PRIVATE_TOKEN: "ghost-secret",
  NODE_OPTIONS: "--require=/tmp/inject.cjs",
  BUN_OPTIONS: "--preload=/tmp/inject.ts",
  LD_PRELOAD: "/tmp/inject.so",
  PI_CONFIG_FILES: "/tmp/pi-config",
  PI_SHELL_PREFIX: "inject",
  CODEX_UNSAFE_ALLOW_NO_SANDBOX: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/tmp/hooks",
  NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
  NPM_TOKEN: "npm-secret",
  GITHUB_TOKEN: "github-secret",
  DATABASE_URL: "postgres://owner:secret@localhost/ghost",
  DOCKER_CONFIG: "/tmp/docker",
};

const excludedNames = Object.keys(adversarialEnvironment).filter(
  (name) => !["HOME", "PATH", "LANG", "LC_CTYPE"].includes(name),
);

describe("native harness environment capture", () => {
  it("splits the shared Claude base from the principal auto-memory policy", () => {
    const source = {
      ...adversarialEnvironment,
      ANTHROPIC_BASE_URL: "https://router.invalid",
      AWS_PROFILE: "owner-profile",
      VERTEX_REGION_CLAUDE_4_8_OPUS: "europe-west1",
    };
    const original = { ...source };
    const native = captureNativeHarnessEnvironment("claude-native", source);

    expect(source).toEqual(original);
    expect(Object.isFrozen(native)).toBe(true);
    expect(native).toMatchObject({
      HOME: "/home/owner",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "fi_FI.UTF-8",
      ANTHROPIC_BASE_URL: "https://router.invalid",
      AWS_PROFILE: "owner-profile",
      VERTEX_REGION_CLAUDE_4_8_OPUS: "europe-west1",
    });
    for (const name of excludedNames) {
      expect(native[name], name).toBeUndefined();
    }
  });

  it.each<{
    profile: NativeHarnessEnvironmentProfile;
    retained: Readonly<Record<string, string>>;
  }>([
    {
      profile: "codex-native",
      retained: { CODEX_HOME: "/home/owner/.codex" },
    },
    {
      profile: "pi-native",
      retained: {
        PI_CODING_AGENT_DIR: "/home/owner/.pi/agent",
        PI_PACKAGE_DIR: "/home/owner/.pi/package",
      },
    },
  ])("captures only positive selectors for $profile", ({ profile, retained }) => {
    const captured = captureNativeHarnessEnvironment(profile, {
      ...adversarialEnvironment,
      ...retained,
      CODEX_HOME: retained.CODEX_HOME ?? "/must/not/cross",
      PI_CODING_AGENT_DIR: retained.PI_CODING_AGENT_DIR ?? "/must/not/cross",
      PI_PACKAGE_DIR: retained.PI_PACKAGE_DIR ?? "/must/not/cross",
      ANTHROPIC_BASE_URL: "https://must-not-cross.invalid",
    });

    expect(captured).toMatchObject({
      HOME: "/home/owner",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "fi_FI.UTF-8",
      ...retained,
    });
    for (const name of excludedNames) expect(captured[name], name).toBeUndefined();
    expect(captured.ANTHROPIC_BASE_URL).toBeUndefined();
    if (profile === "codex-native") {
      expect(captured.PI_CODING_AGENT_DIR).toBeUndefined();
      expect(captured.PI_PACKAGE_DIR).toBeUndefined();
    } else {
      expect(captured.CODEX_HOME).toBeUndefined();
    }
  });

  it("returns the same immutable snapshot only for the same profile", () => {
    const native = captureNativeHarnessEnvironment("claude-native", {
      HOME: "/home/owner",
      PATH: "/usr/bin",
    });
    expect(captureNativeHarnessEnvironment("claude-native", native)).toBe(native);
    const codex = captureNativeHarnessEnvironment("codex-native", native);
    expect(codex).not.toBe(native);
    expect(() => {
      (native as NodeJS.ProcessEnv).OPENAI_API_KEY = "late-secret";
    }).toThrow();
  });
});
