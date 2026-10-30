import { ArgsError, flagBoolean, flagString } from "./args.js";
import { cliConfigPath, ghostPath, listGhosts, readDefaultGhost, resolveTarget, writeDefaultGhost } from "./common.js";
import { notFound } from "./client.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

export async function ghostsCommand(verb: "list" | "new" | "rm" | "use", ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
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
    emit(ctx, response, () => `created ${parsed.positionals[0]}\n`);
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
    const name = requested.trim();
    if (!(await listGhosts(ctx.client)).some((ghost) => ghost.name === name)) throw notFound(`ghost ${JSON.stringify(name)}`);
    const path = await writeDefaultGhost(ctx.runtime, name);
    emit(ctx, { ghost: name, path }, () => `${name}\n`);
    return 0;
  }

  if (!flagBoolean(parsed, "yes")) throw new ArgsError("ghost rm requires --yes");
  const sessionId = flagString(parsed, "session");
  if (sessionId) {
    if (parsed.positionals.length > 0) throw new ArgsError("ghost rm -s does not take a ghost name positional");
    const { path, session } = await resolveTarget(ctx);
    const response = await ctx.client.request("DELETE", path);
    emit(ctx, response, () => `trashed ${session.id}\n`);
    return 0;
  }
  if (parsed.positionals.length !== 1) throw new ArgsError("ghost rm needs a ghost name or -s <id>");
  const name = parsed.positionals[0] as string;
  const response = await ctx.client.request(
    "DELETE",
    ghostPath(name, `?confirm=${encodeURIComponent(name)}`),
  );
  emit(ctx, response, () => `trashed ${name}; \`gio trash --list\` shows it\n`);
  return 0;
}
