import { randomBytes } from "node:crypto";
import { ArgsError, flagBoolean, flagString, parseArgs } from "./args.js";
import type { DaemonClient } from "./client.js";
import { latestSession, listSessions, resolveGhost, resolveSessionPrefix, sessionPath } from "./common.js";
import { dim, truncate, writeJson } from "./output.js";
import type { CliRuntime, CliStdin } from "./types.js";
import { commandHelp } from "./usage.js";

interface StreamEvent {
  type?: unknown;
  [key: string]: unknown;
}

export function newConversationId(now = Date.now()): string {
  return `cli-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

async function stdinText(stdin: CliStdin): Promise<string> {
  if (typeof stdin === "string") return stdin;
  const chunks: string[] = [];
  if (Symbol.asyncIterator in Object(stdin)) {
    for await (const chunk of stdin as AsyncIterable<unknown>) chunks.push(String(chunk));
    return chunks.join("");
  }
  if (Symbol.iterator in Object(stdin)) {
    for (const chunk of stdin as Iterable<unknown>) chunks.push(String(chunk));
    return chunks.join("");
  }
  return await new Promise<string>((resolve, reject) => {
    const input = stdin as { on?: (...args: unknown[]) => unknown };
    if (!input.on) {
      resolve("");
      return;
    }
    input.on("data", (chunk: unknown) => chunks.push(String(chunk)));
    input.on("end", () => resolve(chunks.join("")));
    input.on("error", reject);
  });
}

function stdinIsTty(stdin: CliStdin): boolean {
  return typeof stdin === "object" && stdin !== null && "isTTY" in stdin
    ? (stdin as { isTTY?: boolean }).isTTY === true
    : false;
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
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ["new", "steer", "follow-up"],
    value: ["message", "ghost", "session"],
  });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("say"));
    return 0;
  }
  const steering = flagBoolean(parsed, "steer");
  const followUp = flagBoolean(parsed, "follow-up");
  const startNew = flagBoolean(parsed, "new");
  if ([steering, followUp, startNew].filter(Boolean).length > 1) {
    throw new ArgsError("--new, --steer, and --follow-up are mutually exclusive");
  }
  const text = await messageText(parsed.positionals, flagString(parsed, "message"), runtime.stdin);
  if (!text.trim()) throw new ArgsError("Message text cannot be empty.");
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  const requestedSession = flagString(parsed, "session");

  if (steering || followUp) {
    const sessions = await listSessions(client, name);
    const fallbackSession = latestSession(sessions);
    if (!fallbackSession) throw new ArgsError("A queued message needs an existing session.");
    const selected = requestedSession
      ? resolveSessionPrefix(sessions, requestedSession)
      : fallbackSession;
    const response = await client.request("POST", sessionPath(name, selected.id, "/queue"), {
      mode: steering ? "steer" : "followUp",
      text,
    });
    if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, response.body);
    else if (!flagBoolean(parsed, "quiet")) writeJson(runtime.stdout, response.body);
    return 0;
  }

  const sessions = startNew ? [] : await listSessions(client, name);
  const fallbackSession = latestSession(sessions);
  let conversationId: string;
  if (startNew) conversationId = newConversationId();
  else if (requestedSession) conversationId = resolveSessionPrefix(sessions, requestedSession).conversationId;
  else conversationId = fallbackSession?.conversationId ?? newConversationId();

  const json = flagBoolean(parsed, "json");
  const quiet = flagBoolean(parsed, "quiet");
  let finalText = "";
  let terminal: "done" | "error" | undefined;
  await client.stream(`/api/ghosts/${encodeURIComponent(name)}/messages`, {
    context: { messages: [{ role: "user", content: [{ type: "text", text }] }] },
    options: { sessionId: conversationId },
  }, (unknownEvent) => {
    const event = unknownEvent as StreamEvent;
    if (json) {
      writeJson(runtime.stdout, event);
      if (event.type === "error") {
        terminal = "error";
        runtime.stderr.write(`ghost: ${typeof event.errorMessage === "string" ? event.errorMessage : String(event.reason ?? "turn failed")}\n`);
      } else if (event.type === "done" && terminal !== "error") terminal = "done";
      return;
    }
    switch (event.type) {
      case "text_delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        finalText += delta;
        if (!quiet) runtime.stdout.write(delta);
        break;
      }
      case "owner_message":
        if (!quiet && typeof event.text === "string") runtime.stdout.write(`${event.text}\n`);
        break;
      case "command_output":
        if (!quiet && typeof event.output === "string") runtime.stdout.write(`${event.output}${event.output.endsWith("\n") ? "" : "\n"}`);
        break;
      case "tool_execution_start":
        if (!quiet) runtime.stderr.write(`${dim(`⚙ ${toolDescription(event)}`, runtime.stdout.isTTY === true)}\n`);
        break;
      case "tool_execution_end":
        if (!quiet && event.isError === true) {
          const name = typeof event.toolName === "string" ? event.toolName : "tool";
          const summary = typeof event.summary === "string" ? `: ${truncate(event.summary, 80)}` : "";
          runtime.stderr.write(`${dim(`✗ ${name}${summary}`, runtime.stdout.isTTY === true)}\n`);
        }
        break;
      case "error":
        terminal = "error";
        runtime.stderr.write(`ghost: ${typeof event.errorMessage === "string" ? event.errorMessage : String(event.reason ?? "turn failed")}\n`);
        break;
      case "done":
        if (terminal !== "error") terminal = "done";
        break;
    }
  });
  if (!json) {
    if (quiet && finalText) runtime.stdout.write(finalText);
    if (finalText && !finalText.endsWith("\n")) runtime.stdout.write("\n");
  }
  if (!terminal) runtime.stderr.write("ghost: turn stream ended without a terminal event\n");
  return terminal === "done" ? 0 : 1;
}
