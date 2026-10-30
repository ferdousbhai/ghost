import { flagBoolean } from "./args.js";
import { ghostPath, resolveGhost } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";

export async function watchCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const name = await resolveGhost(ctx);
  await ctx.client.stream(ghostPath(name, "/events"), undefined, (event) => {
    emit(ctx, event);
    return flagBoolean(parsed, "exit-on-first") ? false : undefined;
  });
  return 0;
}
