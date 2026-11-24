import type { RemoteStatus } from "../remote-serve.js";
import type { RunningSource } from "../running-source.js";
import { ghostName } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";

interface DaemonStatus {
  version: RunningSource["version"];
  source: { commit: RunningSource["commit"]; root: RunningSource["root"] };
  /** When the running daemon started, and whether the code on disk has changed since. */
  startedAt: string;
  restartNeeded: boolean;
}

export async function statusCommand(ctx: CliContext): Promise<number> {
  const [ghost, remote, daemon] = await Promise.all([
    ghostName(ctx.client),
    ctx.client.request<RemoteStatus>("GET", "/api/remote"),
    ctx.client.request<DaemonStatus>("GET", "/api/status"),
  ]);
  const result = {
    daemon: ctx.client.baseUrl,
    tokenFile: ctx.client.tokenPath,
    ghost,
    version: ctx.version,
    daemonVersion: daemon.version,
    source: daemon.source,
    daemonStartedAt: daemon.startedAt,
    restartNeeded: daemon.restartNeeded,
    remote,
  };
  emit(ctx, result, () => {
    const lines = [
      `daemon         ${ctx.client.baseUrl}`,
      `token file     ${ctx.client.tokenPath}`,
      `ghost          ${ghost ?? "—"}`,
      `version        ${ctx.version}`,
    ];
    lines.push(`daemon version ${daemon.version}`);
    lines.push(`daemon commit  ${daemon.source.commit ?? "unknown"}`);
    lines.push(`daemon source  ${daemon.source.root ?? "packaged install"}`);
    lines.push(`daemon started ${daemon.startedAt}`);
    // The code changed under a running daemon: what is on disk is not what answers.
    if (daemon.restartNeeded) lines.push("restart needed code on disk is newer than this daemon (ghost help self)");
    const url = remote.state === "on" && remote.hostname ? ` ${remote.hostname}` : "";
    const problem = remote.problem ? ` (${remote.problem.message})` : "";
    lines.push(`remote         ${remote.state}${url}${problem}`);
    return { human: `${lines.join("\n")}\n`, quiet: "ok\n" };
  });
  return 0;
}
