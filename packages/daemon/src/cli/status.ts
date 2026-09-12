import { existsSync } from "node:fs";
import type { Ghost } from "../ghosts.js";
import type { RemoteStatus } from "../remote-serve.js";
import type { RunningSource } from "../running-source.js";
import type { UpdateAvailable } from "../update-check.js";
import type { ParsedCliArgs } from "./args.js";
import { readDefaultGhost } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";

interface DaemonStatus {
  version: RunningSource["version"] | null;
  source?: { commit: RunningSource["commit"]; root: RunningSource["root"] };
  update?: UpdateAvailable | null;
}

export async function statusCommand(
  _parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const [ghostsResponse, remote, daemon] = await Promise.all([
    ctx.client.request<Ghost[]>("GET", "/api/ghosts"),
    ctx.client.optional<RemoteStatus>("GET", "/api/remote"),
    // A daemon older than this route 404s; the rest of status still prints.
    ctx.client.optional<DaemonStatus>("GET", "/api/status"),
  ]);
  const ghosts = ghostsResponse.body;
  const defaultGhost = readDefaultGhost(ctx.runtime) ?? null;
  const result = {
    daemon: ctx.client.baseUrl,
    reachable: true,
    authenticated: true,
    tokenFile: ctx.client.tokenPath,
    tokenFileExists: existsSync(ctx.client.tokenPath),
    ghostCount: ghosts.length,
    defaultGhost,
    version: ctx.version,
    ...(daemon
      ? { daemonVersion: daemon.body.version, source: daemon.body.source ?? null, update: daemon.body.update ?? null }
      : {}),
    ...(remote ? { remote: remote.body } : { remote: { state: "unavailable" } }),
  };
  emit(ctx, result, () => {
    const lines = [
      `daemon         ${ctx.client.baseUrl}`,
      "reachable      yes",
      "authenticated  yes",
      `token file     ${ctx.client.tokenPath}`,
      `ghosts         ${ghosts.length}`,
      `default ghost  ${defaultGhost ?? "—"}`,
      `version        ${ctx.version}`,
    ];
    if (daemon) {
      lines.push(`daemon version ${daemon.body.version ?? "unknown"}`);
      lines.push(`daemon commit  ${daemon.body.source?.commit ?? "unknown"}`);
      lines.push(`daemon source  ${daemon.body.source?.root ?? "packaged install"}`);
      if (daemon.body.update) {
        lines.push(`update         ${daemon.body.update.latest} is available · run: ${daemon.body.update.command}`);
      }
    }
    if (remote) {
      const url = remote.body.url ? ` ${remote.body.url}` : "";
      const problem = remote.body.problem ? ` (${remote.body.problem.message})` : "";
      lines.push(`remote         ${remote.body.state}${url}${problem}`);
    } else lines.push("remote         unavailable");
    return { human: `${lines.join("\n")}\n`, quiet: "ok\n" };
  });
  return 0;
}
