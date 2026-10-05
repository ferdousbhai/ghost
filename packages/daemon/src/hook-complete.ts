/**
 * `ghostd hook-smol-complete`: one completion for a trusted command hook (a
 * stop-hook reviewer, a classifier), run headlessly on the ghost's preferred
 * harness in a scratch directory — no persona, no conversation, no Ghost
 * tools. The name is kept for the hooks already calling it.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadGhostSettings } from "./ghost-settings.js";
import { isGhostHome } from "./ghosts.js";
import { eligibleIds, omarchyDefaultAgent, orderHarnesses, readHarnessReport } from "./harnesses.js";
import { runHarness, writeLaunchFiles } from "./harness-process.js";
import { harnessRow, SUPPORTED_HARNESSES, type HarnessRow } from "./harness-table.js";

export const HOOK_COMPLETE_MAX_STDIN_BYTES = 1024 * 1024;
export const HOOK_COMPLETE_TIMEOUT_MS = 180_000;

export interface HookCompleteInput {
  readonly ghost_home: string;
  readonly prompt: string;
}

export interface HookCompleteOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Test seams over harness choice. */
  readonly harnesses?: () => Promise<readonly string[]>;
  readonly rows?: (id: string) => HarnessRow | null;
}

async function candidates(home: string, env: NodeJS.ProcessEnv, options: HookCompleteOptions): Promise<string[]> {
  const rows = options.rows ?? harnessRow;
  const eligible = options.harnesses
    ? await options.harnesses()
    : await readHarnessReport(env, homedir())
      .then(eligibleIds)
      .catch(() => SUPPORTED_HARNESSES);
  const preferred = [loadGhostSettings(home).getString("harness") ?? null, options.harnesses ? null : await omarchyDefaultAgent(env)];
  return orderHarnesses(eligible.filter((id) => rows(id) !== null), preferred);
}

export async function completeForHook(input: HookCompleteInput, options: HookCompleteOptions = {}): Promise<string> {
  if (!isAbsolute(input.ghost_home)) throw new Error("ghost_home must be an absolute path.");
  if (!input.prompt.trim()) throw new Error("prompt must be a non-empty string.");
  const home = await realpath(resolve(input.ghost_home));
  if (!isGhostHome(home)) throw new Error(`${home} is not a Ghost home.`);
  const env = options.env ?? process.env;
  const rows = options.rows ?? harnessRow;
  const signal = options.signal ?? new AbortController().signal;
  const failures: string[] = [];
  for (const id of await candidates(home, env, options)) {
    const row = rows(id) as HarnessRow;
    const dir = await mkdtemp(join(tmpdir(), "ghost-hook-"));
    try {
      const launch = row.launch({ prompt: input.prompt, resume: false, sessionId: null, persona: "", dir, mcp: [] });
      await writeLaunchFiles(dir, launch.files);
      let text = "";
      let error: string | null = null;
      const exit = await runHarness({
        launch,
        cwd: dir,
        env,
        parse: row.parser(),
        onEvent: (event) => {
          if (event.type === "text") text += event.delta;
          if (event.type === "error") error = event.message;
        },
        signal,
      });
      if (signal.aborted) throw new Error("The hook completion timed out.");
      if (text.trim() && exit.code === 0 && error === null) return text.trim();
      failures.push(`${id}: ${error ?? exit.spawnError ?? (exit.stderr.trim().split("\n").at(-1) || `exit ${exit.code}`)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  throw new Error(failures.length > 0 ? `No harness completed the hook prompt (${failures.join("; ")}).` : "No harness is eligible to complete the hook prompt.");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
    throw new Error(`stdin is not valid JSON: ${(error as Error).message}`);
  }
  const input = value as Partial<HookCompleteInput> | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("stdin must contain a JSON object.");
  if (typeof input.ghost_home !== "string" || typeof input.prompt !== "string") {
    throw new Error("stdin must contain string ghost_home and prompt fields.");
  }
  return { ghost_home: input.ghost_home, prompt: input.prompt };
}

export async function hookCompleteCommand(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write("hook-smol-complete accepts JSON on stdin and no arguments.\n");
    return 2;
  }
  try {
    const input = parseHookCompleteInput(await readStdin());
    const text = await completeForHook(input, { signal: AbortSignal.timeout(HOOK_COMPLETE_TIMEOUT_MS) });
    process.stdout.write(`${JSON.stringify({ text })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
