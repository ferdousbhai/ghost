/**
 * `ghostd hook-complete`: one completion for a trusted command hook (a
 * stop-hook reviewer, a classifier), asked of the daemon that owns the ghost
 * (`POST /api/ghosts/:name/complete`). The daemon picks the harness as a new
 * conversation's turn would, and a ghost on the local model completes on the
 * daemon's own loaded copy rather than a second one started here.
 */
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { CliError, DaemonClient, EXIT_CODE } from "./cli/client.js";
import type { CliRuntime } from "./cli/types.js";
import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { isGhostHome } from "./ghosts.js";
import { isRecord } from "./record.js";

const HOOK_COMPLETE_MAX_STDIN_BYTES = 1024 * 1024;

interface HookCompleteInput {
  readonly ghost_home: string;
  readonly prompt: string;
}

async function readStdin(stdin: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > HOOK_COMPLETE_MAX_STDIN_BYTES) throw new Error(`stdin exceeds ${HOOK_COMPLETE_MAX_STDIN_BYTES} bytes.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseHookCompleteInput(raw: string): HookCompleteInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`stdin is not valid JSON: ${errorMessage(error)}`);
  }
  const input = value as Partial<HookCompleteInput> | null;
  if (!isRecord(input)) throw new Error("stdin must contain a JSON object.");
  if (typeof input.ghost_home !== "string" || typeof input.prompt !== "string") {
    throw new Error("stdin must contain string ghost_home and prompt fields.");
  }
  return { ghost_home: input.ghost_home, prompt: input.prompt };
}

/** The ghost `ghost_home` names among the daemon's ghosts. */
function ghostName(ghostHome: string, ghostsRoot: string): string {
  if (!isAbsolute(ghostHome)) throw new Error("ghost_home must be an absolute path.");
  let home: string;
  let root: string;
  try {
    home = realpathSync(resolve(ghostHome));
    root = realpathSync(ghostsRoot);
  } catch {
    throw new Error(`${ghostHome} is not a Ghost home under ${ghostsRoot}.`);
  }
  if (dirname(home) !== root || !isGhostHome(home)) throw new Error(`${ghostHome} is not a Ghost home under ${ghostsRoot}.`);
  return basename(home);
}

export async function hookCompleteCommand(argv: string[], options: Partial<CliRuntime> = {}): Promise<number> {
  const runtime: CliRuntime = {
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    fetch: options.fetch ?? fetch,
    stdin: options.stdin ?? process.stdin,
  };
  if (argv.length > 0) {
    runtime.stderr.write("hook-complete accepts JSON on stdin and no arguments.\n");
    return 2;
  }
  try {
    const input = parseHookCompleteInput(typeof runtime.stdin === "string" ? runtime.stdin : await readStdin(runtime.stdin));
    if (!input.prompt.trim()) throw new Error("prompt must be a non-empty string.");
    const name = ghostName(input.ghost_home, loadConfig({ env: runtime.env, home: runtime.home }).ghostsRoot);
    const client = new DaemonClient(runtime);
    const { text } = await client.request<{ text: string }>(
      "POST", `/api/ghosts/${encodeURIComponent(name)}/complete`, { prompt: input.prompt },
      // No deadline of its own: the hook's `timeout` kills this process group,
      // which closes the request and stops the completion.
      null,
    ).catch((error: unknown) => {
      if (error instanceof CliError && error.exitCode === EXIT_CODE.unreachable) {
        throw new Error(`${error.message} at ${client.baseUrl}; is it running? (systemctl --user status ghostd)`);
      }
      throw error;
    });
    runtime.stdout.write(`${JSON.stringify({ text })}\n`);
    return 0;
  } catch (error) {
    runtime.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}
