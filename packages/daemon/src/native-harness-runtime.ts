import { CLAUDE_CODE_BINARY_ENV } from "./claude-code.js";
import type { ClaudeAgentSdkLoader } from "./claude-agent-sdk-loader.js";
import { captureNativeHarnessEnvironment } from "./env-scrub.js";
import {
  ClaudeNativeHarnessProbe,
  CODEX_BINARY_ENV,
  CodexNativeHarnessProbe,
  NativeHarnessCatalog,
  PI_BINARY_ENV,
  PiNativeHarnessProbe,
} from "./native-harness-catalog.js";

export interface NativeHarnessEnvironments {
  readonly claude: Readonly<NodeJS.ProcessEnv>;
  readonly codex: Readonly<NodeJS.ProcessEnv>;
  readonly pi: Readonly<NodeJS.ProcessEnv>;
  readonly claudeBinary?: string;
  readonly codexBinary?: string;
  readonly piBinary?: string;
}

/** Capture only reviewed worker launch inputs before any provider scrub. */
export function captureNativeHarnessEnvironments(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NativeHarnessEnvironments {
  return Object.freeze({
    claude: captureNativeHarnessEnvironment("claude-native", source),
    codex: captureNativeHarnessEnvironment("codex-native", source),
    pi: captureNativeHarnessEnvironment("pi-native", source),
    ...(source[CLAUDE_CODE_BINARY_ENV] === undefined
      ? {}
      : { claudeBinary: source[CLAUDE_CODE_BINARY_ENV] }),
    ...(source[CODEX_BINARY_ENV] === undefined
      ? {}
      : { codexBinary: source[CODEX_BINARY_ENV] }),
    ...(source[PI_BINARY_ENV] === undefined
      ? {}
      : { piBinary: source[PI_BINARY_ENV] }),
  });
}

/** Build the one read-only catalogue shared by daemon and local CLI status. */
export function createNativeHarnessCatalog(
  claudeAgentSdkLoader: ClaudeAgentSdkLoader,
  environments: NativeHarnessEnvironments,
): NativeHarnessCatalog {
  return new NativeHarnessCatalog({
    claudeAgentSdkLoader,
    probes: {
      "claude-code": new ClaudeNativeHarnessProbe({
        sdkLoader: claudeAgentSdkLoader,
        environment: environments.claude,
        binaryPath: environments.claudeBinary ?? null,
      }),
      codex: new CodexNativeHarnessProbe({
        environment: environments.codex,
        binaryPath: environments.codexBinary ?? null,
      }),
      pi: new PiNativeHarnessProbe({
        environment: environments.pi,
        binaryPath: environments.piBinary ?? null,
      }),
    },
  });
}
