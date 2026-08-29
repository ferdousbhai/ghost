import { formatDuration, type GhostJobSnapshot } from "../jobs.js";
import type { TodoItem, TodoPhase } from "../plan-mode.js";
import type { PlanStateView } from "../session-host.js";
import { ArgsError, type ParsedCliArgs } from "./args.js";
import { notFound } from "./client.js";
import { resolveTarget } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

function todoText(phases: readonly TodoPhase[]): string {
  // Keep this byte-for-byte aligned with packages/shell/qml/components/WorkStrip.qml's taskGlyph mapping.
  const glyph: Record<TodoItem["status"], string> = {
    completed: "✓",
    in_progress: "▸",
    abandoned: "−",
    blocked: "⊘",
    pending: "·",
  };
  const lines: string[] = [];
  for (const phase of phases) {
    if (phases.length > 1) lines.push(phase.name);
    for (const task of phase.tasks) {
      lines.push(`${glyph[task.status]} ${task.content}${task.blocker ? ` — ${task.blocker}` : ""}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export async function todoCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const { path } = await resolveTarget(ctx.client, ctx, parsed);
  const body = (await ctx.client.request<{ todo: TodoPhase[] }>("GET", `${path}/todo`)).body;
  emit(ctx, body, ({ todo }) => todoText(todo));
  return 0;
}

export async function planCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const candidate = parsed.positionals[0];
  const action = candidate === "start" || candidate === "stop" || candidate === "clear"
    ? candidate
    : undefined;
  if (candidate && !action) {
    throw new ArgsError("plan expects `start`, `stop`, `clear`, or no argument");
  }
  const { path } = await resolveTarget(ctx.client, ctx, parsed);
  const body = (await ctx.client.request<PlanStateView>(
    action ? "POST" : "GET",
    `${path}/plan`,
    action ? { action } : undefined,
  )).body;
  emit(ctx, body, (plan) =>
    `planning ${plan.planning ? "on" : "off"}\n`
      + (plan.plan ? `plan     ${plan.plan.title ?? "—"} (${plan.plan.path})\n` : "")
      + todoText(plan.todo));
  return 0;
}

export async function jobsCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const [candidate, jobId] = parsed.positionals;
  const action = candidate === "cancel" || candidate === "show" ? candidate : undefined;
  if ((candidate && !action) || (action && !jobId)) {
    throw new ArgsError("jobs expects `show <jobId>`, `cancel <jobId>`, or no arguments");
  }
  const { path } = await resolveTarget(ctx.client, ctx, parsed);
  if (action === "cancel") {
    const body = (await ctx.client.request("POST", `${path}/jobs/${encodeURIComponent(jobId as string)}/cancel`, {})).body;
    emit(ctx, body, () => {
      const outcome = (body as { outcome?: unknown }).outcome;
      return `${typeof outcome === "string" ? outcome.replaceAll("_", " ") : "cancelled"} ${jobId}\n`;
    });
    return 0;
  }
  const body = (await ctx.client.request<{ jobs: GhostJobSnapshot[] }>("GET", `${path}/jobs`)).body;
  if (action === "show") {
    const job = body.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw notFound(`job ${JSON.stringify(jobId)}`);
    emit(ctx, job, (value) => `${value.output}${value.output.endsWith("\n") ? "" : "\n"}`);
  } else {
    emit(ctx, body, ({ jobs }) => jobs.length > 0
      ? `${table(jobs.map((job) => [
          job.id,
          job.status,
          formatDuration(job.durationMs),
          job.label || job.command,
        ]), ["ID", "STATUS", "DURATION", "LABEL"])}\n`
      : "");
  }
  return 0;
}
