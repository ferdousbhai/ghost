import { readHarnessReport, type Harness } from "../harnesses.js";
import type { ParsedCliArgs } from "./args.js";
import { CliError, EXIT_CODE } from "./client.js";
import { emit, relativeTime, table } from "./output.js";
import type { CliContext } from "./types.js";

function windows(harness: Harness): string {
  if (!harness.usage) return "no usage record";
  const parts = harness.usage.windows.map((window) => `${window.label} ${Math.round(window.percent * 100)}%`);
  if (parts.length === 0) parts.push(harness.usage.status ?? "no windows reported");
  if (harness.usage.stale) parts.push(`stale, updated ${relativeTime(harness.usage.updatedAt ?? "")} ago`);
  return parts.join(" · ");
}

/** Read locally, like `ghost help`: Omarchy's records, not the daemon, own this data. */
export async function harnessesCommand(_parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  let report: Awaited<ReturnType<typeof readHarnessReport>>;
  try {
    report = await readHarnessReport(ctx.runtime.env, ctx.runtime.home);
  } catch (error) {
    throw new CliError(EXIT_CODE.failure, `cannot list harnesses: ${(error as Error).message}`);
  }
  emit(ctx, report, (body) => {
    const rows = body.harnesses.map((harness) => [
      harness.id,
      harness.eligible ? "eligible" : `no: ${harness.reason}`,
      windows(harness),
    ]);
    const human = rows.length === 0
      ? "No agent CLI Omarchy knows is installed.\n"
      : `${table(rows)}\nrefresh: ${body.refresh}\n`;
    const quiet = body.harnesses.filter((harness) => harness.eligible).map((harness) => `${harness.id}\n`).join("");
    return { human, quiet };
  });
  return EXIT_CODE.success;
}
