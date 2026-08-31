import { formatDuration, type GhostJobSnapshot } from "../jobs.js";
import { ArgsError, type ParsedCliArgs } from "./args.js";
import { notFound } from "./client.js";
import { resolveTarget } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

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
