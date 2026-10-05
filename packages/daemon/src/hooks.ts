import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  hookStatus, parseCommandResult, parseHooksDocument,
  runBeforePromptHooks, runSessionStopHooks,
  type CommandHook, type CommandResult, type GhostBeforePromptEvent,
  type GhostBeforePromptResult, type GhostHookCommandConfig, type GhostHookEvent,
  type GhostHookResult, type GhostHookStatus, type GhostSessionStopEvent,
  type GhostSessionStopResult,
} from "./hook-policy.js";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";
import { writePrivateJsonAtomic } from "./private-file.js";
import { serializeByKey } from "./promise-chain.js";

const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

/** ghostd always has a filesystem ghost home, so its events always carry it (docs/hooks.md). */
export type LocalHookEvent<Event> = Event & { ghost_home: string; storage?: never };

/** Told a handler's display name when it starts (`running`) and when it returns. */
export type HookObserver = (name: string, running: boolean) => void;

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
    throw new Error(`Cannot load Ghost hooks from ${path}: ${(error as Error).message}`);
  }
}

function runCommandHook(
  hook: CommandHook,
  event: GhostHookEvent,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (event.signal.aborted) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        aborted: true,
        timedOut: false,
        overflowed: false,
        executionFailed: false,
      });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(hook.command, {
        cwd: event.cwd,
        env: process.env,
        shell: "/bin/bash",
        // A separate POSIX process group lets cancellation own the shell and
        // every descendant which inherited its stdout/stderr pipes.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        aborted: false,
        timedOut: false,
        overflowed: false,
        executionFailed: true,
      });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let aborted = false;
    let executionFailed = false;
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;

    const append = (chunks: Buffer[], chunk: Buffer, used: number): number => {
      const remaining = Math.max(0, MAX_HOOK_OUTPUT_BYTES - used);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return used + chunk.length;
    };
    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          try {
            child.kill(signal);
          } catch {
            // The close/error event remains the authoritative drain boundary.
          }
        }
      }
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      event.signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        aborted,
        timedOut,
        overflowed,
        executionFailed,
      });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) signalTree("SIGKILL");
      }, 2_000);
      killTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, hook.timeoutMs);
    timer.unref();
    event.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdoutChunks, chunk, stdoutBytes);
      if (stdoutBytes > MAX_HOOK_OUTPUT_BYTES) {
        overflowed = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderrChunks, chunk, stderrBytes);
      if (stderrBytes > MAX_HOOK_OUTPUT_BYTES) {
        overflowed = true;
        stop();
      }
    });
    child.on("error", () => {
      executionFailed = true;
      stderrChunks.length = 0;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {
      // A hook may exit without reading stdin; its process exit still decides
      // whether this is a block or a non-blocking failure.
    });
    try {
      child.stdin.end(JSON.stringify({ ...event, signal: undefined }));
    } catch {
      executionFailed = true;
      stop();
    }
  });
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
    const commands = parseHooksDocument(document, path);
    return new GhostHookRunner({
      ...options,
      commands,
      commandConfig: { path, document: document as Record<string, unknown> },
    });
  }

  /** The admitted `hooks.json`, or undefined for a runner built without one. */
  config(): GhostHookCommandConfig | undefined {
    return this.commandConfig;
  }

  /**
   * Admit `document` as the new `hooks.json`, write it through a temporary
   * file and one rename, then swap the live command hooks. Handlers registered
   * in-process are untouched, and the new commands apply at the next boundary.
   * Replacements are serialized so two writers cannot interleave the file and
   * the live set.
   */
  async replaceConfig(document: unknown): Promise<GhostHookCommandConfig> {
    const config = this.commandConfig;
    if (!config) throw new Error("This hook runner has no configuration file.");
    const commands = parseHooksDocument(document, config.path);
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
      onHook?.(hook.name, true);
      try {
        return await this.runCommandFailOpen(hook, event);
      } finally {
        onHook?.(hook.name, false);
      }
    };
  }

  hasHandlers(event: GhostHookEvent["type"]): boolean {
    return this.commands.some((hook) => hook.eventName === event);
  }

  status(): GhostHookStatus {
    return hookStatus(this.commands);
  }

  async emitBeforePrompt(
    event: LocalHookEvent<GhostBeforePromptEvent>,
    onHook?: HookObserver,
  ): Promise<GhostBeforePromptResult | undefined> {
    return runBeforePromptHooks(this.commands, event, this.observed(onHook));
  }

  async emitSessionStop(
    event: LocalHookEvent<GhostSessionStopEvent>,
    onHook?: HookObserver,
  ): Promise<GhostSessionStopResult | undefined> {
    return runSessionStopHooks(this.commands, event, this.observed(onHook));
  }

}
