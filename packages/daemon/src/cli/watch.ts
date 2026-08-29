import { flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { resolveGhost } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";

export async function watchCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  await ctx.client.stream(`/api/ghosts/${encodeURIComponent(name)}/events`, undefined, (event) => {
    emit(ctx, event);
    return flagBoolean(parsed, "exit-on-first") ? false : undefined;
  }, { method: "GET" });
  return 0;
}
