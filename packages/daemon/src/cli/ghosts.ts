import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import {
  cliConfigPath,
  listGhosts,
  listSessions,
  readDefaultGhost,
  resolveGhost,
  resolveTarget,
  writeDefaultGhost,
} from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

export async function ghostsCommand(
  verb: "list" | "new" | "rm" | "use",
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  if (verb === "list") {
    const ghosts = await listGhosts(ctx.client);
    emit(ctx, ghosts, () => ({
      human: ghosts.length > 0
        ? `${table(ghosts.map((ghost) => [ghost.name, ghost.dir]), ["NAME", "DIR"])}\n`
        : "",
      quiet: ghosts.map((ghost) => ghost.name).join("\n") + (ghosts.length ? "\n" : ""),
    }));
    return 0;
  }

  if (verb === "new") {
    const response = await ctx.client.request("POST", "/api/ghosts", { name: parsed.positionals[0] });
    emit(ctx, response.body, () => `created ${parsed.positionals[0]}\n`);
    return 0;
  }

  if (verb === "use") {
    const requested = parsed.positionals[0];
    if (!requested) {
      const ghost = readDefaultGhost(ctx.runtime);
      if (!ghost) throw new ArgsError(`No default ghost is stored in ${cliConfigPath(ctx.runtime)}.`);
      emit(ctx, { ghost }, () => ({ human: `${ghost}\n`, quiet: `${ghost}\n` }));
      return 0;
    }
    const { name } = await resolveGhost(ctx.client, ctx.runtime, requested);
    await listSessions(ctx.client, name);
    const path = writeDefaultGhost(ctx.runtime, name);
    emit(ctx, { ghost: name, path }, () => `${name}\n`);
    return 0;
  }

  if (!flagBoolean(parsed, "yes")) throw new ArgsError("ghost rm requires --yes");
  const sessionId = flagString(parsed, "session");
  if (sessionId) {
    if (parsed.positionals.length > 0) throw new ArgsError("ghost rm -s does not take a ghost name positional");
    const { path, session } = await resolveTarget(ctx.client, ctx, parsed);
    const response = await ctx.client.request("DELETE", path);
    emit(ctx, response.body, () => `trashed ${session.id}\n`);
    return 0;
  }
  if (parsed.positionals.length !== 1) throw new ArgsError("ghost rm needs a ghost name or -s <id>");
  const name = parsed.positionals[0] as string;
  const response = await ctx.client.request(
    "DELETE",
    `/api/ghosts/${encodeURIComponent(name)}?confirm=${encodeURIComponent(name)}`,
  );
  emit(ctx, response.body, (body) => {
    const trash = (body as { trash?: unknown })?.trash;
    return `trashed ${name}${typeof trash === "string" ? ` → ${trash}` : ""}\n`;
  });
  return 0;
}
