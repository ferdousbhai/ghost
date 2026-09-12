import { randomBytes } from "node:crypto";
import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { CliError, EXIT_CODE } from "./client.js";
import {
  latestSession,
  listSessions,
  preferredSessionId,
  resolveGhost,
  resolveSessionPrefix,
  resolveTarget,
  stdinIsTty,
  stdinText,
} from "./common.js";
import { dim, emit, truncate, type RenderedOutput } from "./output.js";
import type { CliContext, CliStdin } from "./types.js";

interface StreamEvent {
  type?: unknown;
  [key: string]: unknown;
}

export function newConversationId(now = Date.now()): string {
  return `cli-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

async function messageText(
  positionals: readonly string[],
  explicit: string | undefined,
  stdin: CliStdin,
): Promise<string> {
  if (explicit !== undefined) return explicit;
  if (positionals.length === 1 && positionals[0] === "-") return stdinText(stdin);
  if (positionals.length > 0) return positionals.join(" ");
  if (!stdinIsTty(stdin)) return stdinText(stdin);
  return "";
}

function toolDescription(event: StreamEvent): string {
  const name = typeof event.toolName === "string" ? event.toolName : "tool";
  const args = event.arguments;
  let detail: string;
  if (args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string") {
    detail = ((args as { command: string }).command.split("\n")[0] ?? "").trim();
  } else {
    try {
      detail = JSON.stringify(args ?? {});
    } catch {
      detail = String(args);
    }
  }
  return `${name}: ${truncate(detail, 80)}`;
}

/** Which conversation a fresh turn joins: `--new`, then `-s`/`$GHOST_SESSION`, then the latest. */
async function turnConversationId(
  ctx: CliContext,
  name: string,
  startNew: boolean,
  requestedSession: string | undefined,
): Promise<string> {
  if (startNew) return newConversationId();
  const sessions = await listSessions(ctx.client, name);
  if (requestedSession) return resolveSessionPrefix(sessions, requestedSession).conversationId;
  return latestSession(sessions)?.conversationId ?? newConversationId();
}

export async function sayCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const steering = flagBoolean(parsed, "steer");
  const followUp = flagBoolean(parsed, "follow-up");
  const startNew = flagBoolean(parsed, "new");
  if ([steering, followUp, startNew].filter(Boolean).length > 1) {
    throw new ArgsError("--new, --steer, and --follow-up are mutually exclusive");
  }
  const text = await messageText(parsed.positionals, flagString(parsed, "message"), ctx.runtime.stdin);
  if (!text.trim()) throw new ArgsError("Message text cannot be empty.");
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const requestedSession = preferredSessionId(ctx.runtime, flagString(parsed, "session"));

  // The conversation an idle --follow-up turns into a fresh turn of.
  let idleFollowUp: string | undefined;
  if (steering || followUp) {
    const { session, path } = await resolveTarget(ctx.client, ctx, parsed);
    try {
      const response = await ctx.client.request("POST", `${path}/queue`, {
        mode: steering ? "steer" : "followUp",
        text,
      });
      emit(ctx, response.body);
      return 0;
    } catch (error) {
      // A follow-up to an idle conversation is its next turn: this is how a
      // background command wakes the ghost that started it.
      if (!followUp || !(error instanceof CliError) || error.code !== "session_not_streaming") throw error;
      idleFollowUp = session.conversationId;
    }
  }
  const conversationId = idleFollowUp
    ?? await turnConversationId(ctx, name, startNew, requestedSession);

  const secondary = !flagBoolean(parsed, "json") && !flagBoolean(parsed, "quiet");
  let finalText = "";
  let terminal: "done" | "error" | undefined;
  await ctx.client.stream(`/api/ghosts/${encodeURIComponent(name)}/messages`, {
    context: { messages: [{ role: "user", content: [{ type: "text", text }] }] },
    options: { sessionId: conversationId },
  }, (unknownEvent) => {
    const event = unknownEvent as StreamEvent;
    if (event.type === "limit_reached") {
      const limit = event as unknown as { harness?: string; kind?: string; window?: string; resetsAt?: string };
      const when = limit.resetsAt ? ` · resets ${new Date(limit.resetsAt).toLocaleString()}` : "";
      const kind = String(limit.kind ?? "limit").replace("_", " ");
      ctx.runtime.stderr.write(`ghost: ${limit.harness ?? "runtime"} ${kind}${limit.window ? ` (${limit.window})` : ""} reached${when}\n`);
    } else if (event.type === "error") {
      terminal = "error";
      ctx.runtime.stderr.write(`ghost: ${typeof event.errorMessage === "string" ? event.errorMessage : String(event.reason ?? "turn failed")}\n`);
    } else if (event.type === "done" && terminal !== "error") terminal = "done";
    emit(ctx, event, (): string | RenderedOutput => {
      let human = "";
      let quiet = "";
      if (event.type === "text_delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        finalText += delta;
        human = delta;
      } else if (event.type === "owner_message" && typeof event.text === "string") {
        human = `${event.text}\n`;
      } else if (event.type === "command_output" && typeof event.output === "string") {
        human = `${event.output}${event.output.endsWith("\n") ? "" : "\n"}`;
      } else if (event.type === "done") {
        human = finalText && !finalText.endsWith("\n") ? "\n" : "";
        quiet = finalText ? `${finalText}${finalText.endsWith("\n") ? "" : "\n"}` : "";
      }
      return { human, quiet };
    });
    switch (event.type) {
      case "tool_execution_start":
        if (secondary) ctx.runtime.stderr.write(`${dim(`⚙ ${toolDescription(event)}`, ctx.runtime.stdout.isTTY === true)}\n`);
        break;
      case "tool_execution_end":
        if (secondary && event.isError === true) {
          const name = typeof event.toolName === "string" ? event.toolName : "tool";
          const summary = typeof event.summary === "string" ? `: ${truncate(event.summary, 80)}` : "";
          ctx.runtime.stderr.write(`${dim(`✗ ${name}${summary}`, ctx.runtime.stdout.isTTY === true)}\n`);
        }
        break;
    }
  });
  if (!terminal) ctx.runtime.stderr.write("ghost: turn stream ended without a terminal event\n");
  return terminal === "done" ? EXIT_CODE.success : EXIT_CODE.failure;
}
