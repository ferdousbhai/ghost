import { ArgsError, flagBoolean, flagString } from "./args.js";
import { conversationId, followDefaultGhost, readArgumentFile, stdinText, ghostPath, preferredSessionId, resolveGhost, resolveSession, resolveTarget, sessionPath } from "./common.js";
import { emit, primary, writeJson } from "./output.js";
import { EXIT_CODE } from "./client.js";
import type { CliContext } from "./types.js";
import type { RemoteStatus } from "../remote-serve.js";
import { acceptedEventLine } from "../external-events.js";
import type { HarnessChoices } from "../session-host.js";


/** `ghost rename <new-name>`: move the whole ghost home under the new spelling. */
export async function renameCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const next = parsed.positionals[0];
  if (!next) throw new ArgsError("ghost rename needs the new name");
  const name = await resolveGhost(ctx);
  const body = await ctx.client.request("PUT", ghostPath(name, "/name"), { name: next });
  await followDefaultGhost(ctx.runtime, name, next);
  emit(ctx, body, () => `Renamed ${name} to ${next}.\n`);
  return 0;
}

/** `ghost character [set <file>]`: print or replace `character.md` through the daemon's validating writer. */
export async function characterCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const [action = "show", file] = parsed.positionals;
  if (action === "show") {
    if (file) throw new ArgsError("ghost character show takes no further arguments");
    const body = await ctx.client.request<{ body: string }>("GET", ghostPath(await resolveGhost(ctx), "/character"));
    emit(ctx, body, (result) => primary(result.body));
    return 0;
  }
  if (action !== "set" || !file) throw new ArgsError("ghost character takes `show` or `set <file>`");
  const text = readArgumentFile(file);
  const name = await resolveGhost(ctx);
  const body = await ctx.client.request("PUT", ghostPath(name, "/character"), { body: text });
  emit(ctx, body, () => `Character replaced for ${name}.\n`);
  return 0;
}


/** `ghost read -s <id>`: mark a conversation read, as opening it in the HUD does. */
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

/**
 * The preference, and any agent a recent failure keeps at the back;
 * `ghost harnesses` lists installed agents and usage.
 */
function harnessChoicesText(name: string, body: HarnessChoices, changed: boolean): string {
  const preferred = body.ghostDefault ?? (body.automatic ? `automatic (now ${body.automatic})` : "automatic");
  const resting = body.harnesses.flatMap((harness) => harness.resting
    ? [`${harness.id} is tried last until ${new Date(harness.resting.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${harness.resting.reason}\n`]
    : []);
  return `${changed ? `Ghost ${name} now runs on ${preferred}.` : `${name} runs on ${preferred}`}\n${resting.join("")}`;
}

/** `ghost harness [<id>|--none]`: show or set the agent a ghost prefers. */
export async function harnessCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const id = parsed.positionals[0];
  if (id && flagBoolean(parsed, "none")) throw new ArgsError("ghost harness takes an agent or --none, not both");
  const name = await resolveGhost(ctx);
  const body = id || flagBoolean(parsed, "none")
    ? await ctx.client.request("PUT", ghostPath(name, "/harness"), { harness: id ?? null })
    : await ctx.client.request("GET", ghostPath(name, "/harness"));
  emit(ctx, body, (result) => {
    const changed = Boolean(id) || flagBoolean(parsed, "none");
    const text = harnessChoicesText(name, result as HarnessChoices, changed);
    return changed ? text : primary(text);
  });
  return 0;
}

/** `ghost switch <id>`: run this conversation's next turn on another agent. */
export async function switchCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const id = parsed.positionals[0];
  if (!id) throw new ArgsError("ghost switch needs the agent to switch to");
  const name = await resolveGhost(ctx);
  const requested = preferredSessionId(ctx);
  const path = sessionPath(name, requested ? await conversationId(ctx.client, name, requested)
    : (await resolveSession(ctx.client, name, undefined)).id);
  const body = await ctx.client.request<{ id: string; harness: string }>("PUT", `${path}/harness`, { harness: id });
  emit(ctx, body, () => `Conversation ${body.id} now runs on ${body.harness}.\n`);
  return 0;
}

export async function eventCommand(ctx: CliContext): Promise<number> {
  const { parsed } = ctx;
  const [source, id, input] = parsed.positionals;
  const instructions = flagString(parsed, "instructions");
  if (!source || !id || !instructions) throw new ArgsError("ghost event needs source, id, and --instructions");
  const payload = input && input !== "-" ? input : await stdinText(ctx.runtime.stdin);
  const ghost = await resolveGhost(ctx);
  const thread = flagString(parsed, "thread");
  const result = await ctx.client.request<{ sessionId: string; duplicate: boolean }>("POST", ghostPath(ghost, "/events"), { source, id, ...(thread === undefined ? {} : { thread }), instructions, payload });
  emit(ctx, result, () => `${acceptedEventLine(ghost, result.sessionId, result.duplicate)}\n`);
  return 0;
}
