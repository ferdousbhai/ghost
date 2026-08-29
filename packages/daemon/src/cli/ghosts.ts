import { ArgsError, flagBoolean, parseArgs, requirePositionals } from "./args.js";
import type { DaemonClient } from "./client.js";
import {
  cliConfigPath,
  listGhosts,
  readDefaultGhost,
  resolveGhost,
  resolveSession,
  sessionPath,
  writeDefaultGhost,
} from "./common.js";
import { table, writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

export async function ghostsCommand(
  verb: "list" | "new" | "rm" | "use",
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv, {
    ...(verb === "rm" ? { boolean: ["yes"], value: ["ghost", "session"] } : {}),
  });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp(verb));
    return 0;
  }
  const json = flagBoolean(parsed, "json");
  const quiet = flagBoolean(parsed, "quiet");

  if (verb === "list") {
    requirePositionals(parsed, 0, 0, "ghost list [--json] [-q]");
    const ghosts = await listGhosts(client);
    if (json) writeJson(runtime.stdout, ghosts);
    else if (quiet) runtime.stdout.write(ghosts.map((ghost) => ghost.name).join("\n") + (ghosts.length ? "\n" : ""));
    else if (ghosts.length > 0) runtime.stdout.write(`${table(ghosts.map((ghost) => [ghost.name, ghost.dir]), ["NAME", "DIR"])}\n`);
    return 0;
  }

  if (verb === "new") {
    requirePositionals(parsed, 1, 1, "ghost new <name> [--json] [-q]");
    const response = await client.request("POST", "/api/ghosts", { name: parsed.positionals[0] });
    if (json) writeJson(runtime.stdout, response.body);
    else if (!quiet) runtime.stdout.write(`created ${parsed.positionals[0]}\n`);
    return 0;
  }

  if (verb === "use") {
    requirePositionals(parsed, 0, 1, "ghost use [<name>] [--json] [-q]");
    const requested = parsed.positionals[0];
    if (!requested) {
      const ghost = readDefaultGhost(runtime);
      if (!ghost) throw new ArgsError(`No default ghost is stored in ${cliConfigPath(runtime)}.`);
      if (json) writeJson(runtime.stdout, { ghost });
      else runtime.stdout.write(`${ghost}\n`);
      return 0;
    }
    await resolveGhost(client, runtime, requested);
    const path = writeDefaultGhost(runtime, requested);
    if (json) writeJson(runtime.stdout, { ghost: requested, path });
    else if (!quiet) runtime.stdout.write(`${requested}\n`);
    return 0;
  }

  requirePositionals(parsed, 0, 1, "ghost rm <name> --yes | ghost rm -s <id> --yes [-g <name>]");
  if (!flagBoolean(parsed, "yes")) throw new ArgsError("ghost rm requires --yes");
  const sessionId = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  if (sessionId) {
    if (parsed.positionals.length > 0) throw new ArgsError("ghost rm -s does not take a ghost name positional");
    const requestedGhost = typeof parsed.flags.ghost === "string" ? parsed.flags.ghost : undefined;
    const { name } = await resolveGhost(client, runtime, requestedGhost);
    const { session } = await resolveSession(client, name, sessionId);
    const response = await client.request("DELETE", sessionPath(name, session.id));
    if (json) writeJson(runtime.stdout, response.body);
    else if (!quiet) runtime.stdout.write(`trashed ${session.id}\n`);
    return 0;
  }
  requirePositionals(parsed, 1, 1, "ghost rm <name> --yes");
  const name = parsed.positionals[0] as string;
  const response = await client.request(
    "DELETE",
    `/api/ghosts/${encodeURIComponent(name)}?confirm=${encodeURIComponent(name)}`,
  );
  if (json) writeJson(runtime.stdout, response.body);
  else if (!quiet) {
    const trash = (response.body as { trash?: unknown })?.trash;
    runtime.stdout.write(`trashed ${name}${typeof trash === "string" ? ` → ${trash}` : ""}\n`);
  }
  return 0;
}
