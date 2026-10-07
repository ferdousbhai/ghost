/**
 * Each row's parser against output its CLI really printed (recorded on
 * 2026-10-03 from two-turn probes; personal paths and prompts stripped), and
 * each row's launch line for the flags that carry resume, persona, and MCP.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessRow, type HarnessEvent, type HarnessTurnInput } from "../src/harness-table.js";

function parse(id: string, fixture: string): HarnessEvent[] {
  const row = harnessRow(id);
  if (!row) throw new Error(`no row ${id}`);
  const parser = row.parser();
  const text = readFileSync(new URL(`./fixtures/harness/${fixture}`, import.meta.url), "utf8");
  return text.split("\n").filter(Boolean).flatMap((line) => parser(line));
}

function reply(events: readonly HarnessEvent[]): string {
  return events.flatMap((event) => event.type === "text" ? [event.delta] : []).join("");
}

function tools(events: readonly HarnessEvent[]): Array<[string, string | boolean]> {
  return events.flatMap((event): Array<[string, string | boolean]> =>
    event.type === "tool_start" ? [["start", event.name]] : event.type === "tool_end" ? [["end", event.isError]] : []);
}

const TURN: HarnessTurnInput = {
  prompt: "-hello",
  resume: false,
  sessionId: null,
  persona: "You are Casper.",
  mcp: [{ name: "ghost", config: { command: "/usr/bin/ghost", args: ["mcp", "serve", "-s", "c1"] } }],
};

describe("parsers over recorded output", () => {
  it("claude: streamed text deltas, one Bash call, the session id", () => {
    const events = parse("claude", "claude.jsonl");
    expect(reply(events)).toMatch(/^ZEPHYR: The command printed `ghost-probe-42`/u);
    expect(tools(events)).toEqual([["start", "Bash"], ["end", false]]);
    expect(events[0]).toEqual({ type: "session", id: expect.any(String) });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("grok: the same envelope as claude", () => {
    const events = parse("grok", "grok.jsonl");
    expect(reply(events)).toContain("ghost-probe-42");
    expect(tools(events)).toHaveLength(2);
  });

  it("codex: whole agent messages and a command execution, warnings ignored", () => {
    const events = parse("codex", "codex.jsonl");
    expect(reply(events)).toContain("ZEPHYR: My name is Zephyr.");
    expect(tools(events)).toEqual([["start", "bash"], ["end", false]]);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  // Every probe ran `echo ghost-probe-42`; a card shows what the model wrote,
  // never the harness's shell wrapper around it.
  it.each([
    ["claude", "claude.jsonl"],
    ["codex", "codex.jsonl"],
    ["grok", "grok.jsonl"],
    ["copilot", "copilot.jsonl"],
    ["pi", "pi.jsonl"],
  ])("%s: a command card carries the script itself", (id, fixture) => {
    const start = parse(id, fixture).find((event) => event.type === "tool_start");
    expect(start?.type === "tool_start" && start.args).toMatchObject({ command: "echo ghost-probe-42" });
  });

  // A start with no end leaves a card running for the rest of the turn, and
  // the HUD's activity line names the newest running card.
  it.each([
    ["claude", "claude.jsonl"],
    ["codex", "codex.jsonl"],
    ["copilot", "copilot.jsonl"],
    ["grok", "grok.jsonl"],
    ["muse", "muse.jsonl"],
    ["pi", "pi.jsonl"],
  ])("%s: every tool that starts ends", (id, fixture) => {
    const events = parse(id, fixture);
    const ended = new Set(events.flatMap((event) => event.type === "tool_end" ? [event.id] : []));
    expect(events.filter((event) => event.type === "tool_start" && !ended.has(event.id))).toEqual([]);
  });

  it("codex: a web search ends when Codex completes it", () => {
    const parser = (harnessRow("codex") ?? { parser: () => () => [] }).parser();
    const search = (type: string) => parser(JSON.stringify({ type, item: { id: "ws", type: "web_search", query: "" } }));
    expect(search("item.started")).toEqual([{ type: "tool_start", id: "ws", name: "web_search", args: { query: "" } }]);
    expect(search("item.completed")).toEqual([{ type: "tool_end", id: "ws", isError: false }]);
  });

  it("codex: a command is the script inside its bash -lc wrapper", () => {
    const parser = (harnessRow("codex") ?? { parser: () => () => [] }).parser();
    const command = (wrapped: string) => {
      const [event] = parser(JSON.stringify({ type: "item.started", item: { id: "i", type: "command_execution", command: wrapped } }));
      return event?.type === "tool_start" ? (event.args as { command: string }).command : undefined;
    };
    expect(command("/usr/bin/bash -lc 'pnpm --filter @ghost/omarchy test'")).toBe("pnpm --filter @ghost/omarchy test");
    expect(command(String.raw`/usr/bin/bash -lc "rg -n \"mic|composer\" -g '*.qml' | head"`))
      .toBe(`rg -n "mic|composer" -g '*.qml' | head`);
    expect(command(String.raw`/usr/bin/bash -lc "sed -e 's|"'^dir=.*|x|'"' f"`)).toBe("sed -e 's|^dir=.*|x|' f");
    expect(command("/usr/bin/bash -lc 'unterminated")).toBe("/usr/bin/bash -lc 'unterminated");
    expect(command("ls -la")).toBe("ls -la");
  });

  it("copilot: message deltas and one tool execution", () => {
    const events = parse("copilot", "copilot.jsonl");
    expect(reply(events)).toContain("ZEPHYR: I’m Zephyr.");
    expect(tools(events)).toEqual([["start", "bash"], ["end", false]]);
  });

  it("pi: text deltas, a tool execution, its session", () => {
    const events = parse("pi", "pi.jsonl");
    expect(reply(events)).toContain("ZEPHYR");
    expect(tools(events)).toEqual([["start", "bash"], ["end", false]]);
    expect(events.find((event) => event.type === "session")).toBeDefined();
  });

  // Lines trimmed from 2026-10-04 probes; the recorded fixtures predate the fields.
  it("claude and pi: the model, with pi's provider and thinking level", () => {
    const claude = (harnessRow("claude") ?? { parser: () => () => [] }).parser();
    expect(claude(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-5" })))
      .toEqual([{ type: "session", id: "s1" }, { type: "model", model: "claude-opus-5-5" }]);
    const pi = (harnessRow("pi") ?? { parser: () => () => [] }).parser();
    expect(pi(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "low", stopReason: "stop" } })))
      .toEqual([{ type: "model", model: "gpt-6-astra", provider: "openai-codex", effort: "low" }]);
  });

  // Lines trimmed from a 2026-10-04 codex-cli 0.160.0 rollout file.
  it("codex: the model, provider, and effort from the session's rollout file, newest day first", async () => {
    const home = mkdtempSync(join(tmpdir(), "ghost-codex-home-"));
    try {
      const write = (day: string, session: string, model: string) => {
        mkdirSync(join(home, "sessions", day), { recursive: true });
        writeFileSync(join(home, "sessions", day, `rollout-2026-10-04T23-37-08-${session}.jsonl`), [
          { type: "session_meta", payload: { id: session, model_provider: "openai" } },
          { type: "turn_context", payload: { model: "gpt-6-astra", effort: "high" } },
          { type: "turn_context", payload: { model, effort: "low", summary: "none" } },
        ].map((line) => JSON.stringify(line)).join("\n"));
      };
      write("2026/09/30", "thread-a", "gpt-6.1-sol");
      write("2026/10/04", "thread-b", "gpt-6-astra");
      const row = harnessRow("codex");
      expect(await row?.ranOn?.("thread-a", { CODEX_HOME: home }))
        .toEqual({ type: "model", model: "gpt-6.1-sol", provider: "openai", effort: "low" });
      expect(await row?.ranOn?.("thread-c", { CODEX_HOME: home })).toBeNull();
      // A long rollout is read from its ends: the newest turn_context sits
      // behind megabytes of later entries, across the reader's 1 MiB windows.
      const filler = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(4096) } });
      writeFileSync(join(home, "sessions", "2026/10/04", "rollout-2026-10-05T00-00-00-thread-long.jsonl"), [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-long", model_provider: "openai" } }),
        ...Array.from({ length: 300 }, () => filler),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.2-sol", effort: "medium" } }),
        ...Array.from({ length: 700 }, () => filler),
      ].join("\n"));
      expect(await row?.ranOn?.("thread-long", { CODEX_HOME: home }))
        .toEqual({ type: "model", model: "gpt-6.2-sol", provider: "openai", effort: "medium" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Lines trimmed from 2026-10-05 probes.
  it("copilot and muse: the model their streams name, with copilot's vendor and effort", () => {
    const copilot = (harnessRow("copilot") ?? { parser: () => () => [] }).parser();
    expect(copilot(JSON.stringify({ type: "model.call_start", data: { turnId: "0", model: "mai-code-1.1-flash" } })))
      .toEqual([{ type: "model", model: "mai-code-1.1-flash" }]);
    expect(copilot(JSON.stringify({
      type: "session.usage_checkpoint",
      data: { promptCacheBreakState: [{ conversation: "main", lastActiveModel: "mai-code-1.1-flash",
        models: { "mai-code-1.1-flash": { model: "mai-code-1.1-flash", vendor: "openai", reasoning_effort: "medium" } } }] },
    }))).toEqual([{ type: "model", model: "mai-code-1.1-flash", provider: "openai", effort: "medium" }]);
    const muse = (harnessRow("muse") ?? { parser: () => () => [] }).parser();
    expect(muse(JSON.stringify({
      payload_type: "run.model.configured",
      payload: { kind: "run_model_configured", model_id: "muse-spark-1.3-contributor", provider_id: "meta" },
    }))).toEqual([{ type: "model", model: "muse-spark-1.3-contributor", provider: "meta" }]);
  });

  it("agy: its own typed stream, the session it opened and a refusal as the turn's error", () => {
    const agy = (harnessRow("agy") ?? { parser: () => () => [] }).parser();
    expect([
      { event: "init", conversation_id: "dac452a8", init: { cwd: "/tmp/c1", tools: [], permission_mode: "always-proceed" } },
      { event: "step_update", step_update: { conversation_id: "dac452a8", step_index: 1, state: "DONE", step_type: "error_message" } },
      { event: "result", result: { conversation_id: "dac452a8", status: "ERROR", response: "", error: "Individual quota reached." } },
    ].flatMap((line) => agy(JSON.stringify(line)))).toEqual([
      { type: "session", id: "dac452a8" },
      { type: "error", message: "Individual quota reached." },
    ]);
    expect(agy(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } })))
      .toEqual([{ type: "text", block: "result", delta: "ok" }]);
  });

  it("opencode: the model, provider, and variant of the session's latest assistant message", async () => {
    const { Database } = await import("bun:sqlite");
    const data = mkdtempSync(join(tmpdir(), "ghost-opencode-data-"));
    try {
      mkdirSync(join(data, "opencode"));
      const db = new Database(join(data, "opencode", "opencode.db"));
      db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)");
      const add = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
      add.run("m1", "ses_a", 1, 1, JSON.stringify({ role: "assistant", modelID: "big-pickle", providerID: "opencode" }));
      add.run("m2", "ses_a", 2, 2, JSON.stringify({ role: "assistant", modelID: "x-preview-f-free", providerID: "opencode", variant: "max" }));
      add.run("m3", "ses_a", 3, 3, JSON.stringify({ role: "user", model: { providerID: "opencode", modelID: "big-pickle" } }));
      db.close();
      const row = harnessRow("opencode");
      expect(await row?.ranOn?.("ses_a", { XDG_DATA_HOME: data }))
        .toEqual({ type: "model", model: "x-preview-f-free", provider: "opencode", effort: "max" });
      expect(await row?.ranOn?.("ses_b", { XDG_DATA_HOME: data })).toBeNull();
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it("muse: run output deltas and a tool result", () => {
    const events = parse("muse", "muse.jsonl");
    expect(reply(events)).toContain("Muse");
    expect(tools(events)).toEqual([["start", "bash"], ["end", false]]);
  });

  it("opencode: a provider error becomes the turn's error, with the session it opened", () => {
    const events = parse("opencode", "opencode-error.jsonl");
    expect(events).toEqual([
      { type: "session", id: expect.stringMatching(/^ses_/u) },
      { type: "error", message: expect.stringContaining("API key is missing") },
    ]);
  });

  it("crush: plain stdout is the reply", () => {
    expect(reply(parse("crush", "crush.txt"))).toBe("ZEPHYR: My name is Zephyr.");
  });
});

describe("launch lines", () => {
  it("asks for low reasoning effort where a run can set it", () => {
    const flags: Record<string, string[]> = {
      claude: ["--effort", "low"],
      codex: ["-c", 'model_reasoning_effort="low"'],
      grok: ["--reasoning-effort", "low"],
      pi: ["--thinking", "low"],
      crush: ["--reasoning-effort", "low"],
      muse: ["--reasoning-effort", "low"],
      agy: ["--effort", "low"],
    };
    for (const [id, pair] of Object.entries(flags)) {
      expect(harnessRow(id)?.launch(TURN).argv, id).toEqual(expect.arrayContaining(pair));
    }
  });

  it("claude takes the prompt right after -p, so its list flags cannot swallow it", () => {
    const launch = harnessRow("claude")?.launch({ ...TURN, resume: true });
    expect(launch?.argv.slice(0, 3)).toEqual(["claude", "-p", "-hello"]);
    expect(launch?.argv).toContain("--continue");
    expect(launch?.argv.slice(-2)).toEqual(["--mcp-config", ".ghost-mcp.json"]);
    expect(JSON.parse(launch?.files?.[".ghost-mcp.json"] ?? "{}")).toEqual({
      mcpServers: { ghost: { command: "/usr/bin/ghost", args: ["mcp", "serve", "-s", "c1"] } },
    });
  });

  it("codex resumes the directory's last session and takes MCP as config overrides", () => {
    const argv = harnessRow("codex")?.launch({ ...TURN, resume: true }).argv ?? [];
    expect(argv.slice(0, 4)).toEqual(["codex", "exec", "resume", "--last"]);
    expect(argv).toContain('mcp_servers.ghost.command="/usr/bin/ghost"');
    expect(argv.slice(-2)).toEqual(["--", "-hello"]);
  });

  it("grok gets the persona as --rules, since it reads no AGENTS.md", () => {
    const launch = harnessRow("grok")?.launch(TURN);
    expect(launch?.argv).toEqual(expect.arrayContaining(["--rules", "You are Casper."]));
    expect(launch?.files?.[".grok/config.toml"]).toContain('[mcp_servers.ghost]\ncommand = "/usr/bin/ghost"');
  });

  it("opencode resumes by the session id it reported, not by directory", () => {
    const fresh = harnessRow("opencode")?.launch(TURN).argv ?? [];
    expect(fresh).not.toContain("--session");
    const resumed = harnessRow("opencode")?.launch({ ...TURN, resume: true, sessionId: "ses_1" });
    expect(resumed?.argv).toEqual(expect.arrayContaining(["--session", "ses_1"]));
    expect(JSON.parse(resumed?.env?.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
      mcp: { ghost: { type: "local", command: ["/usr/bin/ghost", "mcp", "serve", "-s", "c1"], enabled: true } },
    });
  });
});
