import { flagBoolean, flagString, parseArgs, requirePositionals } from "./args.js";
import { CliError, type DaemonClient } from "./client.js";
import { durationTime, table, writeJson } from "./output.js";
import { resolveGhost, resolveSession, sessionPath } from "./common.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
  blocker?: string;
}

interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

interface PlanBody {
  planning: boolean;
  plan: null | { title: string | null; path: string };
  todo: TodoPhase[];
}

interface JobBody {
  id: string;
  status: string;
  label: string;
  command: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
}

function printTodo(runtime: CliRuntime, phases: readonly TodoPhase[]): void {
  const glyph: Record<TodoItem["status"], string> = {
    completed: "✓",
    in_progress: "▸",
    abandoned: "⊘",
    blocked: "⊘",
    pending: "·",
  };
  for (const phase of phases) {
    if (phases.length > 1) runtime.stdout.write(`${phase.name}\n`);
    for (const task of phase.tasks) {
      runtime.stdout.write(`${glyph[task.status]} ${task.content}${task.blocker ? ` — ${task.blocker}` : ""}\n`);
    }
  }
}

async function workTarget(
  parsed: ReturnType<typeof parseArgs>,
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<{ name: string; path: string }> {
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  const { session } = await resolveSession(client, name, flagString(parsed, "session"));
  return { name, path: sessionPath(name, session.id) };
}

export async function todoCommand(
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv, { value: ["ghost", "session"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("todo"));
    return 0;
  }
  requirePositionals(parsed, 0, 0, "ghost todo [-g <name>] [-s <id>] [--json]");
  const { path } = await workTarget(parsed, client, runtime);
  const body = (await client.request<{ todo: TodoPhase[] }>("GET", `${path}/todo`)).body;
  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, body);
  else if (!flagBoolean(parsed, "quiet")) printTodo(runtime, body.todo);
  return 0;
}

export async function planCommand(
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const action = ["start", "stop", "clear"].includes(argv[0] ?? "") ? argv[0] as "start" | "stop" | "clear" : undefined;
  const parsed = parseArgs(action ? argv.slice(1) : argv, { value: ["ghost", "session"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("plan"));
    return 0;
  }
  requirePositionals(parsed, 0, 0, "ghost plan [start|stop|clear] [-s <id>] [--json]");
  const { path } = await workTarget(parsed, client, runtime);
  const body = (await client.request<PlanBody>(action ? "POST" : "GET", `${path}/plan`, action ? { action } : undefined)).body;
  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, body);
  else if (!flagBoolean(parsed, "quiet")) {
    runtime.stdout.write(`planning ${body.planning ? "on" : "off"}\n`);
    if (body.plan) runtime.stdout.write(`plan     ${body.plan.title ?? "—"} (${body.plan.path})\n`);
    printTodo(runtime, body.todo);
  }
  return 0;
}

export async function jobsCommand(
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const action = argv[0] === "cancel" || argv[0] === "show" ? argv[0] : undefined;
  const parsed = parseArgs(action ? argv.slice(1) : argv, { value: ["ghost", "session"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("jobs"));
    return 0;
  }
  requirePositionals(parsed, action ? 1 : 0, action ? 1 : 0, "ghost jobs [show|cancel <jobId>] [-s <id>]");
  const { path } = await workTarget(parsed, client, runtime);
  const jobId = parsed.positionals[0];
  if (action === "cancel") {
    const body = (await client.request("POST", `${path}/jobs/${encodeURIComponent(jobId as string)}/cancel`, {})).body;
    if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, body);
    else if (!flagBoolean(parsed, "quiet")) {
      const outcome = (body as { outcome?: unknown }).outcome;
      runtime.stdout.write(`${typeof outcome === "string" ? outcome.replaceAll("_", " ") : "cancelled"} ${jobId}\n`);
    }
    return 0;
  }
  const body = (await client.request<{ jobs: JobBody[] }>("GET", `${path}/jobs`)).body;
  if (action === "show") {
    const job = body.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new CliError(5, `job ${JSON.stringify(jobId)} was not found`);
    if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, job);
    else if (!flagBoolean(parsed, "quiet")) runtime.stdout.write(`${job.output}${job.output.endsWith("\n") ? "" : "\n"}`);
  } else if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, body);
  else if (!flagBoolean(parsed, "quiet") && body.jobs.length > 0) {
    runtime.stdout.write(`${table(body.jobs.map((job) => [
      job.id,
      job.status,
      durationTime(job.durationMs),
      job.label || job.command,
    ]), ["ID", "STATUS", "DURATION", "LABEL"])}\n`);
  }
  return 0;
}
