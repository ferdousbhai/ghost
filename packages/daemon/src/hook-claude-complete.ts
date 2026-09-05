/**
 * Claude Code as the review advisor.
 *
 * `roles.advisor_model: claude-code/default` binds the teacher that judges
 * every settled turn to the owner's installed, authenticated Claude Code
 * rather than to a Pi provider model. One review is one non-interactive Agent
 * SDK query whose only user message is the batch prompt the review already
 * assembled — advisor system prompt included — and nothing else: no tools, no
 * MCP, no skills, no plugins, no filesystem settings, and no session
 * persistence. It is independent of the principal runtime — a Pi-driven and a
 * Claude-driven ghost both reach it.
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
import { ADVISOR_MODEL_ROLE, SmolModelUnavailableError, type HookModelRole } from "./smol.js";

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
 * from loading. The advisor's own instructions already head the batch prompt,
 * so repeating them here would send that text twice on every reviewed turn.
 */
const ADVISOR_SYSTEM_STUB =
  "Follow the review instructions in the user message exactly "
  + "and reply with the JSON they specify.";

/**
 * The complete query the teacher runs. Everything that would let Claude act on,
 * or read from, the machine is switched off explicitly rather than left to a
 * default: `settingSources: []` keeps CLAUDE.md, project settings, and
 * filesystem hooks out, and `tools: []` with no MCP server leaves the model
 * nothing to call.
 */
function advisorQueryOptions(input: {
  binaryPath: string;
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  abortController: AbortController;
}): ClaudeQueryOptions {
  return {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.binaryPath,
    // A custom string, so Claude Code's coding-agent preset never loads.
    systemPrompt: ADVISOR_SYSTEM_STUB,
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

function unusable(role: HookModelRole, detail: string, reason: string): SmolModelUnavailableError {
  return new SmolModelUnavailableError(
    `This ghost's ${role} role names `
    + `${CLAUDE_CODE_PROVIDER_ID}/${CLAUDE_CODE_DEFAULT_MODEL_ID}, but ${detail}`,
    reason,
  );
}

/** One review pass answered by Claude Code. Returns the reply text verbatim. */
export async function completeHookClaude(
  input: HookClaudeInput,
  options: HookClaudeOptions = {},
): Promise<string> {
  if (input.ref.modelId !== CLAUDE_CODE_DEFAULT_MODEL_ID) {
    throw new SmolModelUnavailableError(
      `This ghost's ${input.role} role names `
      + `${CLAUDE_CODE_PROVIDER_ID}/${input.ref.modelId}, which is not a model: the only `
      + `Claude Code binding is ${CLAUDE_CODE_PROVIDER_ID}/${CLAUDE_CODE_DEFAULT_MODEL_ID}.`,
      "unknown_model",
    );
  }
  if (input.role !== ADVISOR_MODEL_ROLE) {
    throw new SmolModelUnavailableError(
      `${CLAUDE_CODE_PROVIDER_ID}/${CLAUDE_CODE_DEFAULT_MODEL_ID} cannot serve the `
      + `${input.role} role: the review advisor is the only hook role it answers. Point `
      + `roles.${input.role} in models.json at a provider model.`,
      "unsupported_role",
    );
  }
  if (input.signal?.aborted) throw input.signal.reason ?? new Error("Review aborted.");

  const environment = options.environment ?? captureClaudeCodeEnvironment();
  const probe = options.probe ?? new ClaudeCodeProbe({ environment });
  let probed: ClaudeCodeProbeResult;
  try {
    probed = await probe.read();
  } catch (cause) {
    throw unusable(
      input.role,
      `the installed \`claude\` executable could not be used: ${(cause as Error).message}`,
      "unknown_model",
    );
  }
  if (!isClaudeCodeAuthenticated(probed.authStatus)) {
    throw unusable(
      input.role,
      "Claude Code reports no usable native authentication. Sign in to the installed "
      + `\`claude\` executable, or point roles.${input.role} at an authenticated model.`,
      "no_credentials",
    );
  }

  const sdk = await (options.loadSdk ?? loadOwnerSdk)(input.signal);
  await mkdir(input.cwd, { recursive: true });
  (options.logger ?? silentLogger).debug?.("advisor review served by Claude Code");

  const abortController = new AbortController();
  const abort = () => abortController.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  let text: string | undefined;
  try {
    const query = sdk.query({
      prompt: input.prompt,
      options: advisorQueryOptions({
        binaryPath: probed.binaryPath,
        cwd: input.cwd,
        environment,
        abortController,
      }),
    });
    for await (const message of query as AsyncIterable<SDKMessage>) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success" || message.is_error) {
        throw new SmolModelUnavailableError(
          "Claude Code failed the advisor review: "
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
      "Claude Code returned no advisor review text.",
      "empty_response",
    );
  }
  return reply;
}
