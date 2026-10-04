/**
 * Each row's parser against output its CLI really printed (recorded on
 * 2026-10-03 from two-turn probes; personal paths and prompts stripped), and
 * each row's launch line for the flags that carry resume, persona, and MCP.
 */
import { readFileSync } from "node:fs";
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
  dir: "/tmp/c1",
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
