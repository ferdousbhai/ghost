import { readFileSync } from "node:fs";
import { parseHooksDocument, type GhostHookCommandConfig } from "../hook-policy.js";
import { ArgsError, type ParsedCliArgs } from "./args.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

/** `ghost hooks [status|show|set <file>]` over the daemon's `hooks.json`. */
export async function hooksCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [action = "status", file] = parsed.positionals;
  let body: unknown;
  switch (action) {
    case "status":
    case "show":
      body = await ctx.client.request("GET", "/api/hooks/config");
      break;
    case "set": {
      if (!file) throw new ArgsError("ghost hooks set needs a JSON file path");
      const document: unknown = JSON.parse(readFileSync(file, "utf8"));
      body = await ctx.client.request("PUT", "/api/hooks/config", document);
      break;
    }
    default:
      throw new ArgsError(`ghost hooks does not know "${action}"; use status, show, or set.`);
  }
  emit(ctx, body, (result) => {
    if (action !== "status") return `${JSON.stringify(result, null, 2)}\n`;
    const { path, document } = result as GhostHookCommandConfig;
    const hooks = parseHooksDocument(document, path).commands;
    return hooks.length > 0
      ? `${table(hooks.map((hook) => [hook.eventName, hook.name, hook.description]), ["EVENT", "NAME", "DESCRIPTION"])}\n`
      : "No hooks configured.\n";
  });
  return 0;
}
