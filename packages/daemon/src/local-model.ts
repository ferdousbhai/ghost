/**
 * The local model ghostd runs itself (CONTRACTS.md "Local model"): one
 * llama-server child on a loopback port chosen at spawn, with a fresh API key,
 * started by the first local turn and stopped after it has gone unused.
 * ghostd kills only the process it spawned.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { Logger } from "./log.js";
import { freePort } from "./loopback.js";

export interface LocalModelConfig {
  /** The GGUF file, used in place. */
  readonly model: string;
  /** The llama-server executable. */
  readonly server: string;
  readonly contextSize: number;
  /** Unused this long, the server stops and its memory returns. */
  readonly idleMs: number;
  /** How deeply the model reasons before it answers, as its chat template names the depths. */
  readonly reasoningEffort: string;
}

export const LOCAL_HARNESS = "local";
export const DEFAULT_LOCAL_CONTEXT = 32_768;
export const DEFAULT_LOCAL_IDLE_MS = 5 * 60_000;
/** A model's own default can be its deepest: Inkling 2 Mini's took six minutes over three commands. */
export const DEFAULT_LOCAL_REASONING_EFFORT = "low";
/** A 26B model from a cold disk takes about a minute; this bounds a hung load. */
const LOAD_TIMEOUT_MS = 10 * 60_000;
const STDERR_TAIL = 4_096;
const STOP_GRACE_MS = 5_000;

interface LocalEndpoint {
  readonly url: string;
  readonly key: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LocalModel {
  private child: ChildProcess | null = null;
  private loading: Promise<LocalEndpoint> | null = null;
  private endpoint: LocalEndpoint | null = null;
  private users = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderr = "";

  constructor(
    readonly config: LocalModelConfig,
    private readonly logger: Pick<Logger, "info" | "warn">,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** The model's name as turns report it: its file name without `.gguf`. */
  get name(): string {
    return basename(this.config.model).replace(/\.gguf$/iu, "");
  }

  /**
   * Hold the server for one turn, starting it if needed. `release` must
   * follow; the idle clock starts when the last holder lets go.
   */
  async acquire(onLoading?: () => void): Promise<LocalEndpoint> {
    this.users += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      if (this.endpoint) return this.endpoint;
      onLoading?.();
      this.loading ??= this.start().finally(() => { this.loading = null; });
      return await this.loading;
    } catch (error) {
      this.release();
      throw error;
    }
  }

  release(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0 || !this.child) return;
    this.idleTimer = setTimeout(() => void this.stop("idle"), this.config.idleMs);
    this.idleTimer.unref?.();
  }

  private async start(): Promise<LocalEndpoint> {
    const port = await freePort();
    const key = randomBytes(24).toString("base64url");
    const url = `http://127.0.0.1:${port}`;
    this.stderr = "";
    const child = spawn(this.config.server, [
      "--model", this.config.model, "--alias", this.name,
      "--host", "127.0.0.1", "--port", String(port), "--api-key", key,
      "--n-gpu-layers", "99", "--ctx-size", String(this.config.contextSize), "--parallel", "1",
      "--batch-size", "2048", "--ubatch-size", "2048", "--jinja", "--no-webui",
    ], { stdio: ["ignore", "ignore", "pipe"], env: this.env });
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL); });
    let exited: string | null = null;
    // Under Bun a spawn that fails (ENOENT) emits `error` and never `exit`, so
    // either one ends this child.
    const ended = (why: string) => {
      exited ??= why;
      if (this.child === child) {
        this.child = null;
        this.endpoint = null;
      }
    };
    child.once("error", (error) => ended(error.message));
    child.once("exit", (code, signal) => ended(`exited with ${code === null ? `signal ${signal}` : `status ${code}`}`));
    this.logger.info("local model starting", { model: this.config.model, pid: child.pid });
    const started = Date.now();
    while (Date.now() - started < LOAD_TIMEOUT_MS) {
      if (exited !== null) {
        const tail = this.stderr.trim().split("\n").slice(-4).join("\n");
        throw new Error(`The local model could not start: ${exited}${tail ? `\n${tail}` : ""}`);
      }
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          this.endpoint = { url, key };
          this.logger.info("local model ready", { seconds: Math.round((Date.now() - started) / 1000) });
          return this.endpoint;
        }
      } catch { /* not listening yet */ }
      await delay(500);
    }
    await this.stop("load timed out");
    throw new Error("The local model took too long to load.");
  }

  /** Stop the server now; the next local turn starts it again. */
  async stop(why: string): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    // No pid: the spawn itself failed, and no `exit` will ever come.
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    this.logger.info("local model stopping", { why, pid: child.pid });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }
}
