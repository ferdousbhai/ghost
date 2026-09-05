import { readFileSync } from "node:fs";
import { ArgsError, type ParsedCliArgs } from "./args.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

type HookStatus = { active: boolean; total: number; hooks: Array<{ event: string; source: string; name: string; description: string }> };

/** `ghost hooks [status|show|set <file>]` over the daemon's `hooks.json`. */
export async function hooksCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [action = "status", file] = parsed.positionals;
  let body: unknown;
  switch (action) {
    case "status":
      body = (await ctx.client.request("GET", "/api/hooks")).body;
      break;
    case "show":
      body = (await ctx.client.request("GET", "/api/hooks/config")).body;
      break;
    case "set": {
      if (!file) throw new ArgsError("ghost hooks set needs a JSON file path");
      const document: unknown = JSON.parse(readFileSync(file, "utf8"));
      body = (await ctx.client.request("PUT", "/api/hooks/config", document)).body;
      break;
    }
    default:
      throw new ArgsError(`ghost hooks does not know "${action}"; use status, show, or set.`);
  }
  emit(ctx, body, (result) => {
    if (action !== "status") return `${JSON.stringify(result, null, 2)}\n`;
    const status = result as HookStatus;
    return status.hooks.length > 0
      ? `${table(status.hooks.map((hook) => [hook.event, hook.source, hook.name, hook.description]), ["EVENT", "SOURCE", "NAME", "DESCRIPTION"])}\n`
      : "No hooks configured.\n";
  });
  return 0;
}
