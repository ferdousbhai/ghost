import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { resolveGhost } from "./common.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

export async function modelCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  if (flagBoolean(parsed, "list") && parsed.positionals.length > 0) {
    throw new ArgsError("ghost model --list does not take a model positional");
  }
  if (!flagBoolean(parsed, "list") && flagString(parsed, "q") !== undefined) {
    throw new ArgsError("--q requires --list");
  }
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const base = `/api/ghosts/${encodeURIComponent(name)}`;
  let body: unknown;
  if (flagBoolean(parsed, "list")) {
    const query = new URLSearchParams({ scope: "available" });
    const search = flagString(parsed, "q");
    if (search) query.set("q", search);
    body = (await ctx.client.request("GET", `${base}/models?${query}`)).body;
  } else if (parsed.positionals[0]) {
    const slash = parsed.positionals[0].indexOf("/");
    if (slash < 1 || slash === parsed.positionals[0].length - 1) {
      throw new ArgsError("A model must be written as provider/id.");
    }
    body = (await ctx.client.request("PUT", `${base}/model`, {
      provider: parsed.positionals[0].slice(0, slash),
      id: parsed.positionals[0].slice(slash + 1),
    })).body;
  } else body = (await ctx.client.request("GET", `${base}/model`)).body;

  emit(ctx, body, () => {
    if (flagBoolean(parsed, "list")) {
      const models = (body as { models?: Array<Record<string, unknown>> }).models ?? [];
      return models.length > 0
        ? `${table(models.map((model) => [
            `${String(model.provider)}/${String(model.id)}`,
            typeof model.name === "string" ? model.name : "—",
            model.current === true ? "current" : "",
          ]), ["MODEL", "NAME", "STATE"])}\n`
        : "";
    }
    const current = (body as { current?: { provider?: unknown; id?: unknown } | null }).current;
    return current ? `${String(current.provider)}/${String(current.id)}\n` : "No model selected.\n";
  });
  return 0;
}
