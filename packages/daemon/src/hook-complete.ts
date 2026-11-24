/**
 * `ghostd hook-complete`: one completion for a trusted command hook (a
 * stop-hook reviewer, a classifier), asked of the daemon that owns the ghost
 * (`POST /api/complete`), so it completes on the daemon's own
 * loaded copy of the local model rather than a second one started here.
 */
import { homedir } from "node:os";
import { CliError, DaemonClient, EXIT_CODE } from "./cli/client.js";
import type { CliRuntime } from "./cli/types.js";
import { errorMessage } from "./errors.js";
import { isRecord } from "./record.js";

const HOOK_COMPLETE_MAX_STDIN_BYTES = 1024 * 1024;

interface HookCompleteInput {
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
  if (typeof input.prompt !== "string") throw new Error("stdin must contain a string prompt field.");
  return { prompt: input.prompt };
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
    const client = new DaemonClient(runtime);
    const { text } = await client.request<{ text: string }>(
      "POST", "/api/complete", { prompt: input.prompt },
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
