/**
 * The agent CLIs a ghost converses through, one row each: how to launch one
 * headless turn and how to read its output. Everything else about a turn —
 * model, auth, permissions, tools, compaction, retries — is the harness's own,
 * configured by the owner exactly as when they run it by hand.
 *
 * Each conversation has its own working directory, so "continue the most
 * recent session here" is a per-conversation resume for every harness whose
 * continue is cwd-scoped. A harness whose continue is not names its session
 * in its output, and the host hands that id back (`sessionFrom`).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MCPServerConfig } from "./mcp-config-policy.js";
import { isRecord } from "@ghost/extensions";

export interface HarnessMcpServer {
  readonly name: string;
  readonly config: MCPServerConfig;
}

export interface HarnessTurnInput {
  readonly prompt: string;
  /** A turn after the first in this conversation's directory. */
  readonly resume: boolean;
  /** The harness's own session id, for rows that report one (`sessionFrom`). */
  readonly sessionId: string | null;
  /** The rendered ghost system prompt; most rows read it from `AGENTS.md`. */
  readonly persona: string;
  /** The conversation's working directory. */
  readonly dir: string;
  readonly mcp: readonly HarnessMcpServer[];
}

export interface HarnessLaunch {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Files written into the conversation directory before launch. */
  readonly files?: Readonly<Record<string, string>>;
}

/** What a turn's output says, normalized across harnesses. */
export type HarnessEvent =
  | { readonly type: "text"; readonly block: string; readonly delta: string }
  | { readonly type: "thinking"; readonly block: string; readonly delta: string }
  | { readonly type: "tool_start"; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly type: "tool_end"; readonly id: string; readonly isError: boolean; readonly output?: string }
  | { readonly type: "session"; readonly id: string }
  /** The model answering, as the harness names it; `provider` and `effort` where it says. */
  | { readonly type: "model"; readonly model: string; readonly provider?: string; readonly effort?: string }
  | { readonly type: "error"; readonly message: string };

export interface HarnessRow {
  readonly id: string;
  /** The reasoning effort its launch asks for, when it sets one. */
  readonly effort?: string;
  /**
   * What a pass ran on, read from the session record the harness wrote, for
   * a harness whose output never says (see CONTRACTS.md, "Harnesses").
   */
  ranOn?(session: string, env: Readonly<Record<string, string | undefined>>): Promise<Extract<HarnessEvent, { type: "model" }> | null>;
  launch(input: HarnessTurnInput): HarnessLaunch;
  /** A parser for one turn's stdout, fed line by line. */
  parser(): (line: string) => HarnessEvent[];
}

const MAX_TOOL_OUTPUT = 4_000;

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_TOOL_OUTPUT);
  if (Array.isArray(value)) {
    return value.map((part) => str(record(part).text)).join("").slice(0, MAX_TOOL_OUTPUT);
  }
  const content = record(value).content;
  if (content !== undefined) return outputText(content);
  return "";
}

function json(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** `{"mcpServers": {...}}`, the Claude Code dialect several harnesses share. */
function mcpServersJson(servers: readonly HarnessMcpServer[], stdioType?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { name, config } of servers) {
    if (config.type === "http" || config.type === "sse") {
      out[name] = { type: config.type, url: config.url, ...(config.headers ? { headers: config.headers } : {}) };
    } else {
      out[name] = {
        ...(stdioType ? { type: stdioType } : {}),
        command: config.command,
        args: config.args ?? [],
        ...(config.env ? { env: config.env } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      };
    }
  }
  return { mcpServers: out };
}

/** A TOML-safe table key; MCP names allow `.` and `:`, which TOML paths do not. */
function tomlKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/** TOML inline values: JSON strings and string arrays are valid TOML as written. */
function tomlInlineTable(values: Readonly<Record<string, string>>): string {
  return `{${Object.entries(values).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ")}}`;
}

/** `[mcp_servers.<name>]` rows, the Codex dialect Grok also reads. */
function mcpServersToml(servers: readonly HarnessMcpServer[]): string {
  return servers.map(({ name, config }) => {
    const lines = [`[mcp_servers.${tomlKey(name)}]`];
    if (config.type === "http" || config.type === "sse") {
      lines.push(`url = ${JSON.stringify(config.url)}`);
      if (config.headers) lines.push(`http_headers = ${tomlInlineTable(config.headers)}`);
    } else {
      lines.push(`command = ${JSON.stringify(config.command)}`, `args = ${JSON.stringify(config.args ?? [])}`);
      if (config.env) lines.push(`env = ${tomlInlineTable(config.env)}`);
      if (config.cwd) lines.push(`cwd = ${JSON.stringify(config.cwd)}`);
    }
    lines.push("enabled = true");
    return lines.join("\n");
  }).join("\n\n");
}

/**
 * Claude Code's `stream-json` and Grok's `streaming-messages-json` (Anthropic
 * message events wrapped as `stream_event`, plus whole `assistant`/`user`
 * messages and a final `result`). Cursor prints the same envelope.
 */
function anthropicStreamParser(): (line: string) => HarnessEvent[] {
  let message = 0;
  const streamed = new Set<number>();
  return (line) => {
    const event = json(line);
    if (!event) return [];
    const out: HarnessEvent[] = [];
    if (typeof event.session_id === "string" && event.type === "system" && event.subtype === "init") {
      out.push({ type: "session", id: event.session_id });
      if (typeof event.model === "string") out.push({ type: "model", model: event.model });
    }
    if (event.type === "stream_event") {
      const inner = record(event.event);
      if (inner.type === "message_start") message += 1;
      if (inner.type === "content_block_delta") {
        const delta = record(inner.delta);
        const block = `${message}:${String(inner.index ?? 0)}`;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          streamed.add(message);
          out.push({ type: "text", block, delta: delta.text });
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          out.push({ type: "thinking", block, delta: delta.thinking });
        }
      }
      return out;
    }
    if (event.type === "assistant") {
      const content = record(event.message).content;
      if (!Array.isArray(content)) return out;
      content.forEach((part, index) => {
        const block = record(part);
        if (block.type === "tool_use" && typeof block.id === "string") {
          out.push({ type: "tool_start", id: block.id, name: str(block.name), args: block.input ?? {} });
        } else if (block.type === "text" && typeof block.text === "string" && !streamed.has(message)) {
          // A harness without partial messages sends each text block whole.
          out.push({ type: "text", block: `m${message}:${index}`, delta: block.text });
        }
      });
      if (!streamed.has(message)) message += 1;
      return out;
    }
    if (event.type === "user") {
      const content = record(event.message).content;
      if (!Array.isArray(content)) return out;
      for (const part of content) {
        const block = record(part);
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          out.push({ type: "tool_end", id: block.tool_use_id, isError: block.is_error === true, output: outputText(block.content) });
        }
      }
      return out;
    }
    if (event.type === "tool_call") {
      // Cursor reports tool calls as their own events.
      const id = str(event.call_id);
      const call = record(event.tool_call);
      const name = Object.keys(call)[0] ?? "tool";
      if (event.subtype === "started") out.push({ type: "tool_start", id, name, args: record(call[name]).args ?? {} });
      if (event.subtype === "completed") {
        const result = record(record(call[name]).result);
        out.push({ type: "tool_end", id, isError: result.error !== undefined, output: outputText(result.success ?? result.error) });
      }
      return out;
    }
    if (event.type === "result" && (event.is_error === true || (event.subtype !== undefined && event.subtype !== "success"))) {
      out.push({ type: "error", message: str(event.result) || str(event.error) || `The turn ended with ${str(event.subtype) || "an error"}.` });
    }
    return out;
  };
}

/** Codex `exec --json`: thread/turn/item events. */
function codexParser(): (line: string) => HarnessEvent[] {
  return (line) => {
    const event = json(line);
    if (!event) return [];
    if (event.type === "thread.started" && typeof event.thread_id === "string") return [{ type: "session", id: event.thread_id }];
    if (event.type === "turn.failed") return [{ type: "error", message: str(record(event.error).message) || "The turn failed." }];
    if (event.type === "error") return [{ type: "error", message: str(event.message) || "The turn failed." }];
    if (event.type !== "item.started" && event.type !== "item.completed") return [];
    const item = record(event.item);
    const id = str(item.id);
    const done = event.type === "item.completed";
    switch (item.type) {
      case "agent_message":
        return done ? [{ type: "text", block: id, delta: str(item.text) }] : [];
      case "reasoning":
        return done ? [{ type: "thinking", block: id, delta: str(item.text) }] : [];
      case "command_execution":
        return done
          ? [{ type: "tool_end", id, isError: item.exit_code !== 0, output: outputText(item.aggregated_output) }]
          : [{ type: "tool_start", id, name: "bash", args: { command: item.command } }];
      case "mcp_tool_call":
        return done
          ? [{ type: "tool_end", id, isError: item.status === "failed", output: outputText(record(item.result).content ?? record(item.error).message) }]
          : [{ type: "tool_start", id, name: `${str(item.server)}.${str(item.tool)}`, args: item.arguments ?? {} }];
      case "file_change":
        return done
          ? [{ type: "tool_start", id, name: "edit", args: { changes: item.changes } }, { type: "tool_end", id, isError: item.status === "failed" }]
          : [];
      case "web_search":
        return done ? [] : [{ type: "tool_start", id, name: "web_search", args: { query: item.query } }];
      default:
        return [];
    }
  };
}

/** pi's `--mode json`: its own agent-session events. omp prints the same. */
function piParser(): (line: string) => HarnessEvent[] {
  let message = 0;
  return (line) => {
    const event = json(line);
    if (!event) return [];
    if (event.type === "session" && typeof event.id === "string") return [{ type: "session", id: event.id }];
    if (event.type === "message_start") message += 1;
    if (event.type === "message_update") {
      const update = record(event.assistantMessageEvent);
      const block = `${message}:${String(update.contentIndex ?? 0)}`;
      if (update.type === "text_delta") return [{ type: "text", block, delta: str(update.delta) }];
      if (update.type === "thinking_delta") return [{ type: "thinking", block, delta: str(update.delta) }];
    }
    if (event.type === "tool_execution_start") {
      return [{ type: "tool_start", id: str(event.toolCallId), name: str(event.toolName), args: event.args ?? {} }];
    }
    if (event.type === "tool_execution_end") {
      return [{ type: "tool_end", id: str(event.toolCallId), isError: event.isError === true, output: outputText(event.result) }];
    }
    if (event.type === "message_end") {
      const ended = record(event.message);
      if (ended.role !== "assistant") return [];
      const out: HarnessEvent[] = [];
      if (typeof ended.model === "string") {
        out.push({
          type: "model",
          model: ended.model,
          ...(typeof ended.provider === "string" ? { provider: ended.provider } : {}),
          ...(typeof ended.thinkingLevel === "string" ? { effort: ended.thinkingLevel } : {}),
        });
      }
      if (ended.stopReason === "error") out.push({ type: "error", message: str(ended.errorMessage) || "The model request failed." });
      return out;
    }
    return [];
  };
}

/** A rollout file never moves, so each session's is searched for once. */
const codexRollouts = new Map<string, string>();

async function codexRollout(root: string, session: string): Promise<string | null> {
  const key = join(root, session);
  const known = codexRollouts.get(key);
  if (known) return known;
  const newest = async (dir: string) => (await readdir(dir).catch(() => [])).sort().reverse();
  for (const year of await newest(root)) {
    for (const month of await newest(join(root, year))) {
      for (const day of await newest(join(root, year, month))) {
        const name = (await newest(join(root, year, month, day))).find((file) => file.endsWith(`-${session}.jsonl`));
        if (!name) continue;
        const path = join(root, year, month, day, name);
        codexRollouts.set(key, path);
        return path;
      }
    }
  }
  return null;
}

/**
 * The model and effort of a Codex session's latest turn, from its rollout
 * file (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<session>.jsonl`): `exec
 * --json` names neither. A resumed session keeps its first day's file, so the
 * date directories are searched newest first.
 */
async function codexRanOn(
  session: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Extract<HarnessEvent, { type: "model" }> | null> {
  const rollout = await codexRollout(join(env.CODEX_HOME || join(env.HOME ?? "", ".codex"), "sessions"), session);
  if (!rollout) return null;
  let provider: string | undefined;
  let ran: Extract<HarnessEvent, { type: "model" }> | null = null;
  for (const line of (await readFile(rollout, "utf8")).split("\n")) {
    const entry = json(line);
    const payload = record(entry?.payload);
    if (entry?.type === "session_meta" && typeof payload.model_provider === "string") provider = payload.model_provider;
    if (entry?.type === "turn_context" && typeof payload.model === "string") {
      ran = { type: "model", model: payload.model, ...(typeof payload.effort === "string" ? { effort: payload.effort } : {}) };
    }
  }
  return ran && provider ? { ...ran, provider } : ran;
}

/**
 * The model, provider, and variant of an OpenCode session's latest assistant
 * message, from its database (`$XDG_DATA_HOME/opencode/opencode.db`): `run
 * --format json` names none of them.
 */
async function opencodeRanOn(
  session: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Extract<HarnessEvent, { type: "model" }> | null> {
  const { Database } = await import("bun:sqlite");
  const path = join(env.XDG_DATA_HOME || join(env.HOME ?? "", ".local", "share"), "opencode", "opencode.db");
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 20").all(session) as { data: string }[];
    for (const { data } of rows) {
      const message = json(data);
      if (message?.role !== "assistant" || typeof message.modelID !== "string") continue;
      return {
        type: "model",
        model: message.modelID,
        ...(typeof message.providerID === "string" ? { provider: message.providerID } : {}),
        ...(typeof message.variant === "string" ? { effort: message.variant } : {}),
      };
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Antigravity's `stream-json` (agy 1.2): typed `init`, `step_update`, and a
 * terminal `result`. Its step vocabulary is not yet recorded here, so the
 * reply is the result's `response`, whole.
 */
function agyParser(): (line: string) => HarnessEvent[] {
  return (line) => {
    const event = json(line);
    if (!event) return [];
    if (event.event === "init" && typeof event.conversation_id === "string") return [{ type: "session", id: event.conversation_id }];
    if (event.event !== "result") return [];
    const result = record(event.result);
    if (result.status === "ERROR") return [{ type: "error", message: str(result.error) || "The turn failed." }];
    return str(result.response) ? [{ type: "text", block: "result", delta: str(result.response) }] : [];
  };
}

/** OpenCode `run --format json`: one event per finished part. */
function opencodeParser(): (line: string) => HarnessEvent[] {
  let reported = false;
  return (line) => {
    const event = json(line);
    if (!event) return [];
    const out: HarnessEvent[] = [];
    if (!reported && typeof event.sessionID === "string") {
      reported = true;
      out.push({ type: "session", id: event.sessionID });
    }
    const part = record(event.part);
    if (event.type === "text") out.push({ type: "text", block: str(part.id), delta: str(part.text) });
    if (event.type === "reasoning") out.push({ type: "thinking", block: str(part.id), delta: str(part.text) });
    if (event.type === "tool_use") {
      const state = record(part.state);
      const id = str(part.callID) || str(part.id);
      out.push({ type: "tool_start", id, name: str(part.tool), args: state.input ?? {} });
      if (state.status === "completed" || state.status === "error") {
        out.push({ type: "tool_end", id, isError: state.status === "error", output: outputText(state.output ?? state.error) });
      }
    }
    if (event.type === "error") {
      const error = record(event.error);
      out.push({ type: "error", message: str(record(error.data).message) || str(error.name) || "The turn failed." });
    }
    return out;
  };
}

/** Copilot `--output-format json`: dotted session events. */
function copilotParser(): (line: string) => HarnessEvent[] {
  return (line) => {
    const event = json(line);
    if (!event) return [];
    const data = record(event.data);
    switch (event.type) {
      case "model.call_start":
        return typeof data.model === "string" ? [{ type: "model", model: data.model }] : [];
      case "session.usage_checkpoint": {
        // The cache record is where Copilot names the vendor and effort it ran.
        const state = record((Array.isArray(data.promptCacheBreakState) ? data.promptCacheBreakState : [])[0]);
        const ran = record(record(state.models)[str(state.lastActiveModel)]);
        if (typeof ran.model !== "string") return [];
        return [{
          type: "model",
          model: ran.model,
          ...(typeof ran.vendor === "string" ? { provider: ran.vendor } : {}),
          ...(typeof ran.reasoning_effort === "string" ? { effort: ran.reasoning_effort } : {}),
        }];
      }
      case "assistant.message_delta":
        return [{ type: "text", block: str(data.messageId), delta: str(data.deltaContent) }];
      case "assistant.reasoning_delta":
        return [{ type: "thinking", block: str(data.reasoningId), delta: str(data.deltaContent) }];
      case "tool.execution_start":
        return [{ type: "tool_start", id: str(data.toolCallId), name: str(data.toolName), args: data.arguments ?? {} }];
      case "tool.execution_complete":
        return [{
          type: "tool_end",
          id: str(data.toolCallId),
          isError: data.success === false,
          output: outputText(record(data.result).content ?? record(data.error).message),
        }];
      case "session.error":
        return [{ type: "error", message: str(data.message) || "The turn failed." }];
      default:
        return [];
    }
  };
}

/** Muse `exec --json`: a durable record stream; text arrives as run output deltas. */
function museParser(): (line: string) => HarnessEvent[] {
  return (line) => {
    const event = json(line);
    if (!event) return [];
    const payload = record(event.payload);
    const out: HarnessEvent[] = [];
    if (event.payload_type === "session.run.linked") {
      const stream = record(event.stream);
      if (typeof stream.id === "string") out.push({ type: "session", id: stream.id });
    }
    if (event.payload_type === "run.model.configured" && typeof payload.model_id === "string") {
      out.push({ type: "model", model: payload.model_id, ...(typeof payload.provider_id === "string" ? { provider: payload.provider_id } : {}) });
    }
    if (event.payload_type === "run.output.delta") {
      out.push({ type: "text", block: str(record(payload.run_stream).id), delta: str(payload.text) });
    }
    if (event.payload_type === "tool.result") {
      const facts = record(payload.correlation_facts);
      const id = str(payload.call_id);
      out.push(
        { type: "tool_start", id, name: str(facts.tool_name), args: {} },
        { type: "tool_end", id, isError: facts.outcome !== "success" },
      );
    }
    if (event.payload_type === "run.terminal.failed") {
      out.push({ type: "error", message: str(payload.reason) || str(payload.text) || "The turn failed." });
    }
    return out;
  };
}

/** A harness with no structured output: stdout is the reply. */
function textParser(): (line: string) => HarnessEvent[] {
  let first = true;
  return (line) => {
    const delta = first ? line : `\n${line}`;
    first = false;
    return [{ type: "text", block: "reply", delta }];
  };
}

function writeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Rows that can set reasoning effort per run ask for low: a ghost is a
// conversation, and the owner's own setting is tuned for coding. Copilot's
// `auto` model refuses an effort, opencode's variants are provider-specific,
// and cursor-agent sets effort only inside a model name, so those keep the
// owner's.
const EFFORT = "low";

const ROWS: readonly HarnessRow[] = [
  {
    id: "claude",
    effort: EFFORT,
    // The prompt goes right after -p: --mcp-config takes a list.
    launch: (turn) => ({
      argv: [
        "claude", "-p", turn.prompt,
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--permission-mode", "bypassPermissions", "--effort", EFFORT,
        ...(turn.resume ? ["--continue"] : []),
        ...(turn.mcp.length > 0 ? ["--mcp-config", ".ghost-mcp.json"] : []),
      ],
      files: turn.mcp.length > 0 ? { ".ghost-mcp.json": writeJson(mcpServersJson(turn.mcp)) } : {},
    }),
    parser: anthropicStreamParser,
  },
  {
    id: "codex",
    effort: EFFORT,
    launch: (turn) => ({
      argv: [
        "codex", "exec", ...(turn.resume ? ["resume", "--last"] : []),
        "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
        "-c", `model_reasoning_effort="${EFFORT}"`,
        ...turn.mcp.flatMap(({ name, config }) => {
          const key = `mcp_servers.${tomlKey(name)}`;
          if (config.type === "http" || config.type === "sse") {
            return ["-c", `${key}.url=${JSON.stringify(config.url)}`,
              ...(config.headers ? ["-c", `${key}.http_headers=${tomlInlineTable(config.headers)}`] : [])];
          }
          return ["-c", `${key}.command=${JSON.stringify(config.command)}`, "-c", `${key}.args=${JSON.stringify(config.args ?? [])}`,
            ...(config.env ? ["-c", `${key}.env=${tomlInlineTable(config.env)}`] : [])];
        }),
        "--", turn.prompt,
      ],
    }),
    parser: codexParser,
    ranOn: codexRanOn,
  },
  {
    id: "grok",
    effort: EFFORT,
    // Grok reads no AGENTS.md; --rules appends the persona to its system prompt.
    launch: (turn) => ({
      argv: [
        "grok", "-p", turn.prompt,
        "--output-format", "streaming-messages-json", "--include-partial-messages",
        "--always-approve", "--rules", turn.persona, "--reasoning-effort", EFFORT,
        ...(turn.resume ? ["--continue"] : []),
      ],
      files: turn.mcp.length > 0 ? { ".grok/config.toml": `${mcpServersToml(turn.mcp)}\n` } : {},
    }),
    parser: anthropicStreamParser,
  },
  {
    id: "copilot",
    launch: (turn) => ({
      argv: [
        "copilot", "-p", turn.prompt, "--output-format", "json", "--allow-all",
        ...(turn.resume ? ["--continue"] : []),
        ...(turn.mcp.length > 0 ? ["--additional-mcp-config", "@.ghost-mcp.json"] : []),
      ],
      files: turn.mcp.length > 0 ? { ".ghost-mcp.json": writeJson(mcpServersJson(turn.mcp, "local")) } : {},
    }),
    parser: copilotParser,
  },
  {
    id: "opencode",
    // OpenCode's --continue is not cwd-scoped outside a git repository, so a
    // later turn names the session the first one reported.
    launch: (turn) => {
      const mcp: Record<string, unknown> = {};
      for (const { name, config } of turn.mcp) {
        mcp[name] = config.type === "http" || config.type === "sse"
          ? { type: "remote", url: config.url, ...(config.headers ? { headers: config.headers } : {}), enabled: true }
          : { type: "local", command: [config.command, ...(config.args ?? [])], ...(config.env ? { environment: config.env } : {}), enabled: true };
      }
      return {
        argv: [
          "opencode", "run", "--format", "json", "--auto",
          ...(turn.resume && turn.sessionId ? ["--session", turn.sessionId] : []),
          "--", turn.prompt,
        ],
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) },
      };
    },
    parser: opencodeParser,
    ranOn: opencodeRanOn,
  },
  {
    id: "pi",
    effort: EFFORT,
    // pi has no MCP client; its own tools and extensions are the owner's.
    launch: (turn) => ({
      argv: ["pi", "-p", "--mode", "json", "--thinking", EFFORT, ...(turn.resume ? ["--continue"] : []), turn.prompt],
    }),
    parser: piParser,
  },
  {
    id: "omp",
    launch: (turn) => ({
      argv: ["omp", "-p", "--mode", "json", ...(turn.resume ? ["--continue"] : []), turn.prompt],
    }),
    parser: piParser,
  },
  {
    id: "agy",
    effort: EFFORT,
    launch: (turn) => ({
      argv: [
        "agy", "-p", turn.prompt, "--output-format", "stream-json", "--dangerously-skip-permissions", "--effort", EFFORT,
        ...(turn.resume ? ["--continue"] : []),
      ],
      files: turn.mcp.length > 0 ? { ".gemini/settings.json": writeJson(mcpServersJson(turn.mcp)) } : {},
    }),
    parser: agyParser,
  },
  {
    id: "cursor-agent",
    launch: (turn) => ({
      argv: [
        "cursor-agent", "-p", "--output-format", "stream-json", "--stream-partial-output",
        "--yolo", "--trust", "--approve-mcps",
        ...(turn.resume ? ["--continue"] : []),
        turn.prompt,
      ],
      files: turn.mcp.length > 0 ? { ".cursor/mcp.json": writeJson(mcpServersJson(turn.mcp)) } : {},
    }),
    parser: anthropicStreamParser,
  },
  {
    id: "crush",
    effort: EFFORT,
    // Crush keeps its sessions in the directory it runs in.
    launch: (turn) => ({
      argv: ["crush", "run", "-q", "--reasoning-effort", EFFORT, ...(turn.resume ? ["--continue"] : []), turn.prompt],
      files: turn.mcp.length > 0
        ? { "crush.json": writeJson({ mcp: Object.fromEntries(turn.mcp.map(({ name, config }) => [name,
            config.type === "http" || config.type === "sse"
              ? { type: config.type, url: config.url, ...(config.headers ? { headers: config.headers } : {}) }
              : { type: "stdio", command: config.command, args: config.args ?? [], ...(config.env ? { env: config.env } : {}) }])) }) }
        : {},
    }),
    parser: textParser,
  },
  {
    id: "muse",
    effort: EFFORT,
    // `muse exec` starts fresh unless named; the first turn reports its session.
    launch: (turn) => ({
      argv: [
        "muse", "exec", "--json", "--yolo", "--reasoning-effort", EFFORT,
        ...(turn.resume && turn.sessionId ? ["--session-id", turn.sessionId] : []),
        turn.prompt,
      ],
    }),
    parser: museParser,
  },
];

const BY_ID = new Map(ROWS.map((row) => [row.id, row]));

/** The harness ids Ghost can converse through, in Omarchy's order where it has one. */
export const SUPPORTED_HARNESSES: readonly string[] = ROWS.map((row) => row.id);

export function harnessRow(id: string): HarnessRow | null {
  return BY_ID.get(id) ?? null;
}

/**
 * The subscription account home Omarchy keeps for a harness, passed the way
 * `omarchy-agent` passes it, so a ghost spends the same account the owner's
 * own launches do.
 */
export const ACCOUNT_HOME_ENV: Readonly<Record<string, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
};
