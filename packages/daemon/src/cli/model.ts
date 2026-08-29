import { ArgsError, flagBoolean, flagString, parseArgs, requirePositionals } from "./args.js";
import type { DaemonClient } from "./client.js";
import { resolveGhost } from "./common.js";
import { table, writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

export async function modelCommand(
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv, { boolean: ["list"], value: ["ghost", "q"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("model"));
    return 0;
  }
  requirePositionals(parsed, 0, 1, "ghost model [provider/id] [-g <name>] | ghost model --list [--q <text>]");
  if (flagBoolean(parsed, "list") && parsed.positionals.length > 0) {
    throw new ArgsError("ghost model --list does not take a model positional");
  }
  if (!flagBoolean(parsed, "list") && flagString(parsed, "q") !== undefined) {
    throw new ArgsError("--q requires --list");
  }
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  const base = `/api/ghosts/${encodeURIComponent(name)}`;
  let body: unknown;
  if (flagBoolean(parsed, "list")) {
    const query = new URLSearchParams({ scope: "available" });
    const search = flagString(parsed, "q");
    if (search) query.set("q", search);
    body = (await client.request("GET", `${base}/models?${query}`)).body;
  } else if (parsed.positionals[0]) {
    const slash = parsed.positionals[0].indexOf("/");
    if (slash < 1 || slash === parsed.positionals[0].length - 1) {
      throw new ArgsError("A model must be written as provider/id.");
    }
    body = (await client.request("PUT", `${base}/model`, {
      provider: parsed.positionals[0].slice(0, slash),
      id: parsed.positionals[0].slice(slash + 1),
    })).body;
  } else body = (await client.request("GET", `${base}/model`)).body;

  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, body);
  else if (!flagBoolean(parsed, "quiet")) {
    if (flagBoolean(parsed, "list")) {
      const models = (body as { models?: Array<Record<string, unknown>> }).models ?? [];
      if (models.length > 0) runtime.stdout.write(`${table(models.map((model) => [
        `${String(model.provider)}/${String(model.id)}`,
        typeof model.name === "string" ? model.name : "—",
        model.current === true ? "current" : "",
      ]), ["MODEL", "NAME", "STATE"])}\n`);
    } else {
      const current = (body as { current?: { provider?: unknown; id?: unknown } | null }).current;
      runtime.stdout.write(current ? `${String(current.provider)}/${String(current.id)}\n` : "No model selected.\n");
    }
  }
  return 0;
}
