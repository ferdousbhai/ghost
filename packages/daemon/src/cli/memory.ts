import { CliError, type DaemonClient } from "./client.js";
import { flagBoolean, flagString, parseArgs, requirePositionals } from "./args.js";
import { resolveGhost } from "./common.js";
import { relativeTime, table, truncate, writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

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
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const action = argv[0] === "show" ? "show" : undefined;
  const parsed = parseArgs(action ? argv.slice(1) : argv, { value: ["ghost"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("memory"));
    return 0;
  }
  requirePositionals(parsed, action ? 1 : 0, action ? 1 : 0, "ghost memory [show <name>] [-g <name>]");
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  const body = (await client.request<MemoryBody>("GET", `/api/ghosts/${encodeURIComponent(name)}/memory`)).body;
  if (flagBoolean(parsed, "json")) {
    writeJson(runtime.stdout, body);
    return 0;
  }
  if (action) {
    const requested = parsed.positionals[0] as string;
    const memory = body.memory.find((row) => row.slug === requested || row.path === requested || row.path === `memory/${requested}.md`);
    if (!memory) throw new CliError(5, `memory ${JSON.stringify(requested)} was not found`);
    if (!flagBoolean(parsed, "quiet")) runtime.stdout.write(`${memory.content}${memory.content.endsWith("\n") ? "" : "\n"}`);
  } else if (flagBoolean(parsed, "quiet")) {
    runtime.stdout.write(body.memory.map((row) => row.slug).join("\n") + (body.memory.length ? "\n" : ""));
  } else if (body.memory.length > 0) {
    runtime.stdout.write(`${table(body.memory.map((row) => [
      row.slug,
      relativeTime(row.updated),
      truncate((row.content.split("\n")[0] ?? "").trim(), 60),
    ]), ["MEMORY", "UPDATED", "FACT"])}\n`);
  }
  return 0;
}
