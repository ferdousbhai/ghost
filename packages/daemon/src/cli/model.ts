import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { resolveGhost } from "./common.js";
import {
  LOGIN_BOOLEAN_FLAGS,
  LOGIN_VALUE_FLAGS,
  loginCommand,
  logoutCommand,
  providersCommand,
} from "./login.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

const LOGIN_FLAGS = [...LOGIN_BOOLEAN_FLAGS, ...LOGIN_VALUE_FLAGS];

export async function modelCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const [first] = parsed.positionals;
  if (first === "login") return await loginCommand(parsed, ctx);
  if (first === "logout") return await logoutCommand(parsed, ctx);
  for (const flag of LOGIN_FLAGS) {
    if (parsed.flags[flag] !== undefined) {
      throw new ArgsError(`--${flag} applies to \`ghost model login\` and \`ghost model logout\` only`);
    }
  }
  if (parsed.positionals.length > 1) {
    throw new ArgsError("ghost model takes one model, or `login`/`logout` and a provider");
  }
  if (flagBoolean(parsed, "providers")) {
    if (first || flagBoolean(parsed, "list")) {
      throw new ArgsError("ghost model --providers takes no model positional and no --list");
    }
    return await providersCommand(parsed, ctx);
  }
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
  } else if (first) {
    const slash = first.indexOf("/");
    if (slash < 1 || slash === first.length - 1) {
      throw new ArgsError("A model must be written as provider/id.");
    }
    body = (await ctx.client.request("PUT", `${base}/model`, {
      provider: first.slice(0, slash),
      id: first.slice(slash + 1),
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
