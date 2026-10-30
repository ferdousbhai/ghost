import { existsSync } from "node:fs";
import type { Ghost } from "../ghosts.js";
import type { RemoteStatus } from "../remote-serve.js";
import type { RunningSource } from "../running-source.js";
import type { ParsedCliArgs } from "./args.js";
import { readDefaultGhost } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";

interface DaemonStatus {
  version: RunningSource["version"] | null;
  source?: { commit: RunningSource["commit"]; root: RunningSource["root"] };
  /** When the running daemon started, and whether the code on disk has changed since. */
  startedAt?: string | null;
  restartNeeded?: boolean;
}

export async function statusCommand(
  _parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const [ghosts, remote, daemon] = await Promise.all([
    ctx.client.request<Ghost[]>("GET", "/api/ghosts"),
    ctx.client.optional<RemoteStatus>("GET", "/api/remote"),
    // A daemon older than this route 404s; the rest of status still prints.
    ctx.client.optional<DaemonStatus>("GET", "/api/status"),
  ]);
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
      ? {
        daemonVersion: daemon.version,
        source: daemon.source ?? null,
        daemonStartedAt: daemon.startedAt ?? null,
        restartNeeded: daemon.restartNeeded === true,
      }
      : {}),
    remote: remote ?? { state: "unavailable" },
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
      lines.push(`daemon version ${daemon.version ?? "unknown"}`);
      lines.push(`daemon commit  ${daemon.source?.commit ?? "unknown"}`);
      lines.push(`daemon source  ${daemon.source?.root ?? "packaged install"}`);
      if (daemon.startedAt) lines.push(`daemon started ${daemon.startedAt}`);
      // The code changed under a running daemon: what is on disk is not what answers.
      if (daemon.restartNeeded === true)
        lines.push("restart needed code on disk is newer than this daemon (ghost help self)");
    }
    if (remote) {
      const url = remote.url ? ` ${remote.url}` : "";
      const problem = remote.problem ? ` (${remote.problem.message})` : "";
      lines.push(`remote         ${remote.state}${url}${problem}`);
    } else lines.push("remote         unavailable");
    return { human: `${lines.join("\n")}\n`, quiet: "ok\n" };
  });
  return 0;
}
