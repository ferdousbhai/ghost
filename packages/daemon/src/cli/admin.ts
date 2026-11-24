import { ArgsError, flagBoolean } from "./args.js";
import { readArgumentFile, resolveTarget } from "./common.js";
import { emit, primary, writeJson } from "./output.js";
import { EXIT_CODE } from "./client.js";
import type { CliContext } from "./types.js";
import type { RemoteStatus } from "../remote-serve.js";

/** `ghost character [set <file>]`: print or replace `character.md` through the daemon's validating writer. */
export async function characterCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const [action = "show", file] = parsed.positionals;
  if (action === "show") {
    if (file) throw new ArgsError("ghost character show takes no further arguments");
    const body = await ctx.client.request<{ body: string }>("GET", "/api/character");
    emit(ctx, body, (result) => primary(result.body));
    return 0;
  }
  if (action !== "set" || !file) throw new ArgsError("ghost character takes `show` or `set <file>`");
  const text = readArgumentFile(file);
  const body = await ctx.client.request("PUT", "/api/character", { body: text });
  emit(ctx, body, () => "Character replaced.\n");
  return 0;
}


/** `ghost read -s <id>`: mark a conversation read. */
export async function readCommand(ctx: CliContext): Promise<number> {
  const { path, session } = await resolveTarget(ctx);
  const body = await ctx.client.request("PUT", `${path}/read`, {});
  emit(ctx, body, () => `Marked ${session.id} read.\n`);
  return 0;
}

/** `ghost remote [status|on|off]`: a change that leaves the state other than asked exits 1, saying why. */
export async function remoteCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const [action = "status"] = parsed.positionals;
  if (!["status", "on", "off"].includes(action)) throw new ArgsError(`ghost remote does not know "${action}"; use status, on, or off.`);
  const status = action === "status"
    ? await ctx.client.request<RemoteStatus>("GET", "/api/remote")
    : await ctx.client.request<RemoteStatus>("POST", "/api/remote", { enabled: action === "on" });
  const appLines = status.state !== "on" ? ""
    : !status.app ? "no app: remote.apps is empty, so nothing can reach Ghost remotely\n"
    : status.app.url ? `app ${status.app.url}\n` : "";
  if (action === "status") {
    emit(ctx, status, () => ({
      human: `${status.state === "on" ? `on ${status.hostname}` : status.state}${status.problem ? ` (${status.problem.message})` : ""}\n${appLines}`,
      quiet: `${status.state}\n`,
    }));
    return 0;
  }
  if (status.problem || status.state !== action) {
    if (flagBoolean(parsed, "json")) writeJson(ctx.runtime.stdout, status);
    const why = status.problem ? `${status.problem.message}${status.problem.action ? ` (${status.problem.action})` : ""}` : `ghostd did not turn it ${action}`;
    ctx.runtime.stderr.write(`ghost: remote access is ${status.state}: ${why}\n`);
    return EXIT_CODE.failure;
  }
  emit(ctx, status, () => `Remote access is ${action === "on" ? `on at ${status.hostname}` : "off"}.\n${appLines}`);
  return 0;
}
