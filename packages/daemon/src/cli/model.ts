import { ArgsError, flagString, type ParsedCliArgs } from "./args.js";
import { resolveGhost } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";

type CurrentModel = { current: { provider: string; id: string; runtime: string } | null; source: string };

/** `ghost model [provider/id]`: show or set the chat model; pi owns the catalog. */
export async function modelCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const base = `/api/ghosts/${encodeURIComponent(name)}/model`;
  let body: unknown;
  if (parsed.positionals[0]) {
    const slash = parsed.positionals[0].indexOf("/");
    if (slash < 1 || slash === parsed.positionals[0].length - 1) {
      throw new ArgsError("A model must be written as provider/id.");
    }
    body = (await ctx.client.request("PUT", base, {
      provider: parsed.positionals[0].slice(0, slash),
      id: parsed.positionals[0].slice(slash + 1),
    })).body;
  } else body = (await ctx.client.request("GET", base)).body;
  emit(ctx, body, (result) => {
    const { current } = result as CurrentModel;
    return current
      ? `${current.provider}/${current.id} (${current.runtime})\n`
      : "No chat model bound; pi picks its default. Set one with ghost model <provider>/<id>.\n";
  });
  return 0;
}
