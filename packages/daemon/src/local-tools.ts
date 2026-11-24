/**
 * The local model's one tool (CONTRACTS.md "Local model"): `bash`, a command
 * line run as the owner, with no sandbox and no confirmation. Everything the
 * owner's products do is behind their command lines, so a shell is the whole
 * tool set: searching is `recall` and `rg`, mail is `cloudmail`, a coding
 * agent is its own one-shot command.
 */
import { spawn } from "node:child_process";

/**
 * The most characters of one command's output the model is given: its start
 * and its end, with what was cut between them counted. A bound on one result,
 * not on the conversation, so that a command which prints without end cannot
 * outgrow the request.
 */
export const TOOL_RESULT_CHARS = 200_000;
const OUTPUT_UPDATE_MS = 100;
/** The latest output a running command shows: more than any card displays. */
const LATEST_CHARS = 4_000;

interface ToolSpec {
  readonly type: "function";
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> };
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export const LOCAL_TOOLS: readonly ToolSpec[] = [{
  type: "function",
  function: {
    name: "bash",
    description: "Run a command line in bash on the owner's computer, as the owner. Returns what it printed (stdout and stderr together) and its exit status when that is not 0. Nothing can be typed into it while it runs.",
    parameters: { type: "object", properties: { command: { type: "string", description: "The command line." } }, required: ["command"] },
  },
}];

/**
 * Run `command` in bash, in `cwd`, until it ends or `signal` stops the turn,
 * which ends the command and everything it started. While it runs, `onOutput`
 * is given the latest of what it has printed, at most every
 * `OUTPUT_UPDATE_MS`: a coding agent's steps, seen as they happen.
 */
export function bash(
  command: string,
  context: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onOutput?: (latest: string) => void },
): Promise<ToolResult> {
  return new Promise((done) => {
    // Its own process group, so that stopping the turn stops what the command started too.
    const child = spawn("bash", ["-c", command], { cwd: context.cwd, env: context.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    // The start and the latest end are kept, half of the bound each; the middle of a longer output is only counted.
    const half = TOOL_RESULT_CHARS / 2;
    let head = "";
    let tail = "";
    let total = 0;
    let latest = "";
    let update: ReturnType<typeof setTimeout> | undefined;
    const sendUpdate = () => {
      update = undefined;
      context.onOutput?.(latest);
    };
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      total += text.length;
      if (context.onOutput) {
        latest = (latest + text).slice(-LATEST_CHARS);
        update ??= setTimeout(sendUpdate, OUTPUT_UPDATE_MS);
      }
      const room = half - head.length;
      head += text.slice(0, Math.max(room, 0));
      if (text.length > room) tail = (tail + text.slice(Math.max(room, 0))).slice(-half);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const stop = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    };
    context.signal.addEventListener("abort", stop, { once: true });
    const finish = (status: string, isError: boolean) => {
      clearTimeout(update);
      context.signal.removeEventListener("abort", stop);
      const kept = head.length + tail.length;
      const output = kept < total ? `${head}\n… (${total - kept} characters left out) …\n${tail}` : head + tail;
      done({ text: `${output.trimEnd()}${status ? `\n(${status})` : ""}`.trim() || "(no output)", isError });
    };
    child.on("error", (error) => finish(`bash could not start: ${error.message}`, true));
    child.on("close", (code, killedBy) => {
      if (context.signal.aborted) finish("stopped", true);
      else if (killedBy) finish(`ended by ${killedBy}`, true);
      else finish(code === 0 ? "" : `exit ${code}`, code !== 0);
    });
  });
}
