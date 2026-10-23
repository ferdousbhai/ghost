import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseCommandResult, parseHooksDocument,
  runBeforePromptHooks, runSessionStopHooks,
  type CommandHook, type CommandResult, type GhostBeforePromptEvent,
  type GhostBeforePromptResult, type GhostHookCommandConfig, type GhostHookEvent,
  type GhostHookResult, type GhostSessionStopEvent,
  type GhostSessionStopResult, type GhostTurnEndEvent,
} from "./hook-policy.js";
import { runHarness } from "./harness-process.js";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";
import { writePrivateJsonAtomic } from "./private-file.js";
import { serializeByKey } from "./promise-chain.js";
import { errorMessage } from "./errors.js";

const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

/** Told a handler's display name and event when it starts (`running`) and when it returns. */
export type HookObserver = (name: string, event: GhostHookEvent["type"], running: boolean) => void;

interface GhostHookRunnerOptions {
  logger?: Logger;
  /** Test seam for a rejected command execution boundary. */
  commandRunner?: (hook: CommandHook, event: GhostHookEvent) => Promise<CommandResult>;
}

/** The parsed file, unvalidated: `parseHooksDocument` admits it. */
function readCommandHooksDocument(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load Ghost hooks from ${path}: ${errorMessage(error)}`);
  }
}

/**
 * One hook command in bash, as its own process group: the event as JSON on
 * stdin, ended on abort, timeout, or more than 1 MB of stdout.
 */
async function runCommandHook(hook: CommandHook, event: GhostHookEvent): Promise<CommandResult> {
  const timeout = AbortSignal.timeout(hook.timeoutMs);
  const overflow = new AbortController();
  let stdout = "";
  let bytes = 0;
  const exit = await runHarness({
    launch: { argv: ["/bin/bash", "-c", hook.command] },
    cwd: event.cwd,
    env: process.env,
    signal: AbortSignal.any([event.signal, timeout, overflow.signal]),
    stdin: JSON.stringify({ ...event, signal: undefined }),
    onStdout: (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_HOOK_OUTPUT_BYTES) overflow.abort();
      else stdout += chunk;
    },
  });
  return {
    exitCode: exit.code,
    stdout,
    stderr: exit.stderr,
    aborted: event.signal.aborted,
    timedOut: timeout.aborted,
    overflowed: overflow.signal.aborted,
    executionFailed: exit.spawnError !== undefined,
  };
}

export class GhostHookRunner {
  private readonly logger: Logger;
  private commands: CommandHook[];
  private readonly commandRunner: NonNullable<GhostHookRunnerOptions["commandRunner"]>;
  private commandConfig?: GhostHookCommandConfig;
  private readonly configWrites = new Map<string, Promise<unknown>>();

  constructor(
    options: GhostHookRunnerOptions & {
      commands?: CommandHook[];
      commandConfig?: GhostHookCommandConfig;
    } = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.commands = options.commands ?? [];
    this.commandConfig = options.commandConfig;
    this.commandRunner = options.commandRunner ?? runCommandHook;
  }

  static fromConfig(path: string, options: GhostHookRunnerOptions = {}): GhostHookRunner {
    const document = readCommandHooksDocument(path);
    return new GhostHookRunner({
      ...options,
      ...parseHooksDocument(document, path),
      commandConfig: { path, document: document as Record<string, unknown> },
    });
  }

  /** The admitted `hooks.json`, or undefined for a runner built without one. */
  config(): GhostHookCommandConfig | undefined {
    return this.commandConfig;
  }

  /**
   * Admit `document` as the new `hooks.json`, write it through a temporary
   * file and one rename, then swap the live command hooks; the new commands
   * apply at the next boundary.
   * Replacements are serialized so two writers cannot interleave the file and
   * the live set.
   */
  async replaceConfig(document: unknown): Promise<GhostHookCommandConfig> {
    const config = this.commandConfig;
    if (!config) throw new Error("This hook runner has no configuration file.");
    const { commands } = parseHooksDocument(document, config.path);
    const admitted = document as Record<string, unknown>;
    return serializeByKey(this.configWrites, config.path, async () => {
      await mkdir(dirname(config.path), { recursive: true });
      await writePrivateJsonAtomic(config.path, admitted);
      this.commands = commands;
      this.commandConfig = { path: config.path, document: admitted };
      return this.commandConfig;
    });
  }

  private async runCommandFailOpen(
    hook: CommandHook,
    event: GhostHookEvent,
  ): Promise<GhostHookResult | undefined> {
    const logger = this.logger.child({
      ghost: event.ghost_name,
      conversation: event.conversation_id,
    });
    try {
      return parseCommandResult(hook, await this.commandRunner(hook, event), (message, details) => logger.warn(message, details));
    } catch {
      logger.warn(`${hook.eventName} hook failed open`, {
        source: hook.source,
        error: "command execution failed",
      });
      return undefined;
    }
  }

  private observed(onHook?: HookObserver) {
    return async (hook: CommandHook, event: GhostHookEvent): Promise<GhostHookResult | undefined> => {
      onHook?.(hook.name, event.type, true);
      try {
        return await this.runCommandFailOpen(hook, event);
      } finally {
        onHook?.(hook.name, event.type, false);
      }
    };
  }

  hasHandlers(event: GhostHookEvent["type"]): boolean {
    return this.commands.some((hook) => hook.eventName === event);
  }

  async emitTurnEnd(event: GhostTurnEndEvent): Promise<void> {
    for (const hook of this.commands.filter(hook => hook.eventName === "turn_end")) await this.runCommandFailOpen(hook, event);
  }

  async emitBeforePrompt(
    event: GhostBeforePromptEvent,
    onHook?: HookObserver,
  ): Promise<GhostBeforePromptResult | undefined> {
    return runBeforePromptHooks(this.commands, event, this.observed(onHook));
  }

  async emitSessionStop(
    event: GhostSessionStopEvent,
    onHook?: HookObserver,
  ): Promise<GhostSessionStopResult | undefined> {
    return runSessionStopHooks(this.commands, event, this.observed(onHook));
  }

}
