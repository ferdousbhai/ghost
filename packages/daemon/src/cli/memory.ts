import { ArgsError, flagString, type ParsedCliArgs } from "./args.js";
import { notFound } from "./client.js";
import { resolveGhost } from "./common.js";
import { emit, relativeTime, table, truncate } from "./output.js";
import type { CliContext } from "./types.js";

interface MemoryRow {
  path: string;
  slug: string;
  content: string;
  updated: string;
}

interface MemoryBody {
  memory: MemoryRow[];
  skipped: Array<{ path: string; reason: string }>;
}

export async function memoryCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const action = parsed.positionals[0] === "show" ? "show" : undefined;
  if ((parsed.positionals.length > 0 && !action) || (action && parsed.positionals.length !== 2)) {
    throw new ArgsError("memory expects `show <name>` or no arguments");
  }
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const body = (await ctx.client.request<MemoryBody>("GET", `/api/ghosts/${encodeURIComponent(name)}/memory`)).body;
  if (action) {
    const requested = parsed.positionals[1] as string;
    const memory = body.memory.find((row) => row.slug === requested || row.path === requested || row.path === `memory/${requested}.md`);
    if (!memory) throw notFound(`memory ${JSON.stringify(requested)}`);
    emit(ctx, body, () => `${memory.content}${memory.content.endsWith("\n") ? "" : "\n"}`);
  } else {
    emit(ctx, body, () => ({
      human: body.memory.length > 0
        ? `${table(body.memory.map((row) => [
            row.slug,
            relativeTime(row.updated),
            truncate((row.content.split("\n")[0] ?? "").trim(), 60),
          ]), ["MEMORY", "UPDATED", "FACT"])}\n`
        : "",
      quiet: body.memory.map((row) => row.slug).join("\n") + (body.memory.length ? "\n" : ""),
    }));
  }
  return 0;
}
