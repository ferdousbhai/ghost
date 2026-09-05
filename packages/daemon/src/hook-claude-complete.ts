/**
 * Claude Code answering a background role.
 *
 * A `claude-code/<model>` binding on `smol_model` or `advisor_model` (or the
 * driver-following default, Sonnet and Fable) runs one non-interactive Agent
 * SDK query on the owner's installed, authenticated Claude Code: one user
 * message in, the reply text out, and nothing else — no tools, no MCP, no
 * skills, no plugins, no filesystem settings, no session persistence. It is
 * independent of the principal runtime; a Pi-driven ghost reaches it too.
 *
 * The SDK loader, executable probe, and reviewed child environment are the
 * principal runtime's; the daemon injects its own instances so a review reuses
 * the already-validated install instead of re-deriving one.
 */
import { mkdir } from "node:fs/promises";
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAgentSdkLoader,
  type ClaudeAgentSdkModule,
} from "./claude-agent-sdk-loader.js";
import {
  CLAUDE_CODE_DEFAULT_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeProbe,
  isClaudeCodeAuthenticated,
  type ClaudeCodeProbeResult,
} from "./claude-code.js";
import { resultErrorMessage } from "./claude-pi-messages.js";
import { captureClaudeCodeEnvironment } from "./env-scrub.js";
import { silentLogger, type Logger } from "./log.js";
import type { GhostModelRoleBinding } from "./models.js";
import { SmolModelUnavailableError, type HookModelRole } from "./smol.js";

/** The daemon's shared Claude Code plumbing; each default is stand-alone. */
export interface HookClaudeOptions {
  probe?: Pick<ClaudeCodeProbe, "read">;
  loadSdk?: (signal?: AbortSignal) => Promise<ClaudeAgentSdkModule>;
  /** Captured before the process-global provider scrub where one exists. */
  environment?: Readonly<NodeJS.ProcessEnv>;
  logger?: Logger;
}

export interface HookClaudeInput {
  ref: GhostModelRoleBinding;
  role: HookModelRole;
  prompt: string;
  /** Session directory of the ghost being reviewed; nothing there is read. */
  cwd: string;
  signal?: AbortSignal;
}

/** The daemon injects its own loader; a stand-alone hook process builds one. */
function loadOwnerSdk(signal?: AbortSignal): Promise<ClaudeAgentSdkModule> {
  return new ClaudeAgentSdkLoader().load(signal);
}

/** True when a role binding names the Claude Code harness at all. */
export function isClaudeCodeRoleRef(
  ref: GhostModelRoleBinding | null | undefined,
): ref is GhostModelRoleBinding {
  return ref?.provider === CLAUDE_CODE_PROVIDER_ID;
}

/**
 * A system prompt is set only to keep the `claude_code` coding-agent preset
 * from loading; the role's own instructions head the user message.
 */
const ROLE_SYSTEM_STUB = "Follow the instructions in the user message exactly.";

/**
 * The complete query the teacher runs. Everything that would let Claude act on,
 * or read from, the machine is switched off explicitly rather than left to a
 * default: `settingSources: []` keeps CLAUDE.md, project settings, and
 * filesystem hooks out, and `tools: []` with no MCP server leaves the model
 * nothing to call.
 */
function roleQueryOptions(input: {
  binaryPath: string;
  cwd: string;
  modelId: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  abortController: AbortController;
}): ClaudeQueryOptions {
  return {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.binaryPath,
    // `default` is whatever the owner's Claude Code defaults to; any other id
    // is handed to Claude Code as-is (an alias like `sonnet` or a full name).
    ...(input.modelId === CLAUDE_CODE_DEFAULT_MODEL_ID ? {} : { model: input.modelId }),
    // A custom string, so Claude Code's coding-agent preset never loads.
    systemPrompt: ROLE_SYSTEM_STUB,
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
    abortController: input.abortController,
    env: input.environment,
  };
}

function unusable(
  ref: GhostModelRoleBinding,
  role: HookModelRole,
  detail: string,
  reason: string,
): SmolModelUnavailableError {
  return new SmolModelUnavailableError(
    `This ghost's ${role} role names ${CLAUDE_CODE_PROVIDER_ID}/${ref.modelId}, but ${detail}`,
    reason,
  );
}

/** One completion answered by Claude Code. Returns the reply text verbatim. */
export async function completeHookClaude(
  input: HookClaudeInput,
  options: HookClaudeOptions = {},
): Promise<string> {
  if (input.ref.provider !== CLAUDE_CODE_PROVIDER_ID || !input.ref.modelId.trim()) {
    throw new SmolModelUnavailableError(
      `This ghost's ${input.role} role names ${input.ref.provider}/${input.ref.modelId}, `
      + `which is not a Claude Code model.`,
      "unknown_model",
    );
  }
  if (input.signal?.aborted) throw input.signal.reason ?? new Error("Completion aborted.");

  const environment = options.environment ?? captureClaudeCodeEnvironment();
  const probe = options.probe ?? new ClaudeCodeProbe({ environment });
  let probed: ClaudeCodeProbeResult;
  try {
    probed = await probe.read();
  } catch (cause) {
    throw unusable(
      input.ref,
      input.role,
      `the installed \`claude\` executable could not be used: ${(cause as Error).message}`,
      "unknown_model",
    );
  }
  if (!isClaudeCodeAuthenticated(probed.authStatus)) {
    throw unusable(
      input.ref,
      input.role,
      "Claude Code reports no usable native authentication. Sign in to the installed "
      + `\`claude\` executable, or point roles.${input.role} at an authenticated model.`,
      "no_credentials",
    );
  }

  const sdk = await (options.loadSdk ?? loadOwnerSdk)(input.signal);
  await mkdir(input.cwd, { recursive: true });
  (options.logger ?? silentLogger).debug?.(`${input.role} completion served by Claude Code`);

  const abortController = new AbortController();
  const abort = () => abortController.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  let text: string | undefined;
  try {
    const query = sdk.query({
      prompt: input.prompt,
      options: roleQueryOptions({
        binaryPath: probed.binaryPath,
        cwd: input.cwd,
        modelId: input.ref.modelId,
        environment,
        abortController,
      }),
    });
    for await (const message of query as AsyncIterable<SDKMessage>) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success" || message.is_error) {
        throw new SmolModelUnavailableError(
          `Claude Code failed the ${input.role} completion: `
          + (resultErrorMessage(message) || `the query ended with ${message.subtype}.`),
          "provider_error",
        );
      }
      text = message.result;
      break;
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
    abortController.abort();
  }

  const reply = text?.trim();
  if (!reply) {
    throw new SmolModelUnavailableError(
      `Claude Code returned no ${input.role} text.`,
      "empty_response",
    );
  }
  return reply;
}
