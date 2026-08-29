import { flagBoolean, flagString, parseArgs, requirePositionals } from "./args.js";
import type { DaemonClient } from "./client.js";
import { resolveGhost } from "./common.js";
import { writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

export async function watchCommand(
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv, { boolean: ["exit-on-first"], value: ["ghost"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("watch"));
    return 0;
  }
  requirePositionals(parsed, 0, 0, "ghost watch [-g <name>] [--exit-on-first]");
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  await client.stream(`/api/ghosts/${encodeURIComponent(name)}/events`, undefined, (event) => {
    if (!flagBoolean(parsed, "quiet")) writeJson(runtime.stdout, event);
    return flagBoolean(parsed, "exit-on-first") ? false : undefined;
  }, { method: "GET" });
  return 0;
}
