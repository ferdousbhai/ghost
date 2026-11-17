/**
 * One turn on the local model (CONTRACTS.md "Local model"): ghostd's own
 * loop over llama-server's OpenAI-compatible chat API, emitting the same
 * events a harness parser does. The model reads through `local-tools.ts`;
 * anything else it proposes runs only after the owner approves it.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessEvent } from "./harness-table.js";
import type { LocalModel } from "./local-model.js";
import { localToolSpecs, runApprovedCommand, runReadTool, type ToolContext } from "./local-tools.js";

/** Model calls in one pass; the last is made without tools, so the pass ends in an answer. */
const MAX_ROUNDS = 8;
const PENDING_FILE = ".local-pending.json";
export const APPROVE = "Run it";
export const DECLINE = "Don't run it";
const APPROVAL = /^\s*(run it|yes|y|yep|ok|okay|go|go ahead|do it|approve[d]?|run)\b/iu;

export interface NativeTurnInput {
  readonly prompt: string;
  readonly persona: string;
  readonly cwd: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly onEvent: (event: HarnessEvent) => void;
  /** Set the conversation's open question for the owner. */
  readonly ask: (text: string, options: readonly string[]) => Promise<void>;
}

/** The local model's half of the system prompt; the persona is the other half. */
export const LOCAL_SECTION = `## Running locally

You are running on the owner's own computer, on a local model, with these tools instead of a shell. Look things up before answering a question about the owner's life, files or messages: search_content first, then read what it found. Name the file (and page or date) each fact came from. If nothing turns up, say so; never guess a fact, a date or the time. Anything beyond reading (sending, changing, deleting, network) goes through run_command, which asks the owner first; say plainly what you proposed and why, then stop.`;

interface Pending {
  readonly command: string;
  readonly reason: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readPending(cwd: string): Promise<Pending | null> {
  try {
    const value = JSON.parse(await readFile(join(cwd, PENDING_FILE), "utf8")) as Partial<Pending>;
    return typeof value.command === "string" ? { command: value.command, reason: String(value.reason ?? "") } : null;
  } catch {
    return null;
  }
}

/**
 * A command proposed last turn is settled by the owner's reply: an approval
 * runs it here, deterministically, and the model is told the outcome;
 * anything else declines it.
 */
async function settlePending(input: NativeTurnInput, context: ToolContext): Promise<string | null> {
  const pending = await readPending(input.cwd);
  if (!pending) return null;
  await rm(join(input.cwd, PENDING_FILE), { force: true });
  const reply = input.prompt.split("<conversation-so-far>").length > 1
    ? input.prompt.slice(input.prompt.lastIndexOf("</conversation-so-far>") + "</conversation-so-far>".length).trim()
    : input.prompt;
  if (!APPROVAL.test(reply)) return `<declined-command>\nThe owner did not approve \`${pending.command}\`; it did not run.\n</declined-command>`;
  const id = `approved-${Date.now()}`;
  input.onEvent({ type: "tool_start", id, name: "run_command", args: { command: pending.command, reason: pending.reason } });
  const result = await runApprovedCommand(pending.command, context);
  input.onEvent({ type: "tool_end", id, isError: result.isError, output: result.text });
  return `<approved-command>\nThe owner approved \`${pending.command}\`. It ${result.isError ? "failed" : "ran"}; output:\n${result.text}\n</approved-command>`;
}

/** Stream one chat completion, emitting text and reasoning as they arrive. */
async function complete(
  model: LocalModel,
  endpoint: { url: string; key: string },
  messages: ChatMessage[],
  tools: ReturnType<typeof localToolSpecs> | null,
  round: number,
  input: NativeTurnInput,
): Promise<{ content: string; calls: ToolCall[] }> {
  const response = await fetch(`${endpoint.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.key}` },
    body: JSON.stringify({
      model: model.name,
      messages,
      ...(tools ? { tools } : {}),
      stream: true,
      // Gemma 4's card samples at 1.0; grounded answers want it lower, as Lastbook does.
      temperature: 0.3,
      top_p: 0.95,
      top_k: 64,
    }),
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`The local model refused the request (${response.status}): ${detail}`);
  }
  let content = "";
  const calls: ToolCall[] = [];
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let event: { choices?: Array<{ delta?: Record<string, unknown> }>; error?: { message?: string } };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) throw new Error(event.error.message ?? "The local model failed.");
      const delta = event.choices?.[0]?.delta ?? {};
      if (typeof delta.reasoning_content === "string") input.onEvent({ type: "thinking", block: `r${round}`, delta: delta.reasoning_content });
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        input.onEvent({ type: "text", block: `r${round}`, delta: delta.content });
      }
      for (const part of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
        const index = typeof part.index === "number" ? part.index : calls.length;
        const fn = (part.function ?? {}) as { name?: string; arguments?: string };
        if (!calls[index]) calls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
        const call = calls[index];
        if (typeof part.id === "string" && part.id) call.id = part.id;
        if (fn.name) call.function.name += fn.name;
        if (fn.arguments) call.function.arguments += fn.arguments;
      }
    }
  }
  calls.forEach((call, index) => { call.id ||= `call-${round}-${index}`; });
  return { content, calls: calls.filter(Boolean) };
}

/** Run one pass; throws with a message the turn reports as its error. */
export async function runLocalTurn(model: LocalModel, input: NativeTurnInput): Promise<void> {
  const context: ToolContext = { home: input.home, env: input.env, signal: input.signal };
  const endpoint = await model.acquire(() => input.onEvent({ type: "thinking", block: "load", delta: "Loading the local model…" }));
  try {
    input.onEvent({ type: "model", model: model.name, provider: "local" });
    const settled = await settlePending(input, context);
    const tools = localToolSpecs(context);
    const messages: ChatMessage[] = [
      { role: "system", content: `${input.persona}\n\n${LOCAL_SECTION}\n\nThe time now is ${new Date().toString()}.` },
      { role: "user", content: settled ? `${input.prompt}\n\n${settled}` : input.prompt },
    ];
    let proposed = false;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS || proposed;
      const { content, calls } = await complete(model, endpoint, messages, last ? null : tools, round, input);
      if (calls.length === 0) return;
      messages.push({ role: "assistant", content, tool_calls: calls });
      for (const call of calls) {
        const args = parseArgs(call.function.arguments);
        input.onEvent({ type: "tool_start", id: call.id, name: call.function.name, args });
        let result: { text: string; isError: boolean };
        if (call.function.name === "run_command") {
          const command = typeof args.command === "string" ? args.command.trim() : "";
          if (!command || proposed) {
            result = { text: proposed ? "Only one command can wait for approval at a time." : "A command is needed.", isError: true };
          } else {
            const reason = typeof args.reason === "string" ? args.reason.trim() : "";
            await writeFile(join(input.cwd, PENDING_FILE), JSON.stringify({ command, reason }), { mode: 0o600 });
            await input.ask(`Run \`${command.slice(0, 300)}\`?${reason ? ` ${reason.slice(0, 200)}` : ""}`, [APPROVE, DECLINE]);
            proposed = true;
            result = { text: "Not run yet: the owner has been asked. Tell them in one or two sentences what you want to run and why, then stop.", isError: false };
          }
        } else {
          result = await runReadTool(call.function.name, args, context);
        }
        input.onEvent({ type: "tool_end", id: call.id, isError: result.isError, output: result.text });
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
      }
    }
  } finally {
    model.release();
  }
}
