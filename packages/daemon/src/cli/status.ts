import { existsSync } from "node:fs";
import { flagBoolean, parseArgs, requirePositionals } from "./args.js";
import type { DaemonClient } from "./client.js";
import { readDefaultGhost, type GhostRow } from "./common.js";
import { writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

export async function statusCommand(
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("status"));
    return 0;
  }
  requirePositionals(parsed, 0, 0, "ghost status [--json] [-q]");
  const ghosts = (await client.request<GhostRow[]>("GET", "/api/ghosts")).body;
  const [version, remote] = await Promise.all([
    client.optional<Record<string, unknown>>("GET", "/api/version"),
    client.optional<Record<string, unknown>>("GET", "/api/remote"),
  ]);
  const defaultGhost = readDefaultGhost(runtime) ?? null;
  const result = {
    daemon: client.baseUrl,
    reachable: true,
    authenticated: true,
    tokenFile: client.tokenPath,
    tokenFileExists: existsSync(client.tokenPath),
    ghostCount: ghosts.length,
    defaultGhost,
    ...(version ? { version: version.body } : {}),
    ...(remote ? { remote: remote.body } : { remote: { state: "unavailable" } }),
  };
  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, result);
  else if (flagBoolean(parsed, "quiet")) runtime.stdout.write("ok\n");
  else {
    runtime.stdout.write(`daemon         ${client.baseUrl}\n`);
    runtime.stdout.write("reachable      yes\n");
    runtime.stdout.write("authenticated  yes\n");
    runtime.stdout.write(`token file     ${client.tokenPath}\n`);
    runtime.stdout.write(`ghosts         ${ghosts.length}\n`);
    runtime.stdout.write(`default ghost  ${defaultGhost ?? "—"}\n`);
    if (version) {
      const value = version.body.version ?? version.body;
      runtime.stdout.write(`version        ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    }
    if (remote) {
      const state = remote.body.state ?? "unknown";
      const url = typeof remote.body.url === "string" ? ` ${remote.body.url}` : "";
      const rawProblem = remote.body.problem;
      const problemMessage = typeof rawProblem === "string"
        ? rawProblem
        : rawProblem && typeof rawProblem === "object" && typeof (rawProblem as { message?: unknown }).message === "string"
          ? (rawProblem as { message: string }).message
          : undefined;
      const problem = problemMessage ? ` (${problemMessage})` : "";
      runtime.stdout.write(`remote         ${String(state)}${url}${problem}\n`);
    } else runtime.stdout.write("remote         unavailable\n");
  }
  return 0;
}
