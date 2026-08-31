import { randomBytes } from "node:crypto";
import { ArgsError, flagBoolean, flagString, type ParsedCliArgs } from "./args.js";
import { EXIT_CODE } from "./client.js";
import { latestSession, listSessions, resolveGhost, resolveSessionPrefix } from "./common.js";
import { dim, emit, truncate, type RenderedOutput } from "./output.js";
import type { CliContext, CliStdin } from "./types.js";

interface StreamEvent {
  type?: unknown;
  [key: string]: unknown;
}

export function newConversationId(now = Date.now()): string {
  return `cli-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

async function stdinText(stdin: CliStdin): Promise<string> {
  if (typeof stdin === "string") return stdin;
  return (await Array.fromAsync(stdin, String)).join("");
}

function stdinIsTty(stdin: CliStdin): boolean {
  return typeof stdin !== "string" && stdin.isTTY === true;
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

export async function sayCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const startNew = flagBoolean(parsed, "new");
  const text = await messageText(parsed.positionals, flagString(parsed, "message"), ctx.runtime.stdin);
  if (!text.trim()) throw new ArgsError("Message text cannot be empty.");
  const { name } = await resolveGhost(ctx.client, ctx.runtime, flagString(parsed, "ghost"));
  const requestedSession = flagString(parsed, "session");

  const sessions = startNew ? [] : await listSessions(ctx.client, name);
  const fallbackSession = latestSession(sessions);
  let conversationId: string;
  if (startNew) conversationId = newConversationId();
  else if (requestedSession) conversationId = resolveSessionPrefix(sessions, requestedSession).conversationId;
  else conversationId = fallbackSession?.conversationId ?? newConversationId();

  const secondary = !flagBoolean(parsed, "json") && !flagBoolean(parsed, "quiet");
  let finalText = "";
  let terminal: "done" | "error" | undefined;
  await ctx.client.stream(`/api/ghosts/${encodeURIComponent(name)}/messages`, {
    context: { messages: [{ role: "user", content: [{ type: "text", text }] }] },
    options: { sessionId: conversationId },
  }, (unknownEvent) => {
    const event = unknownEvent as StreamEvent;
    if (event.type === "error") {
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
