import { describe, expect, it, vi } from "vitest";
import { formatDuration } from "../src/jobs.js";
import type { SessionSummary } from "../src/session-host.js";
import { ArgsError, parseArgs } from "../src/cli/args.js";
import { EXIT_CODES } from "../src/cli/client.js";
import { latestSession, resolveSessionPrefix } from "../src/cli/common.js";
import { COMMANDS } from "../src/cli/main.js";
import { relativeTime } from "../src/cli/output.js";
import { renderSkillText } from "../src/cli/skill.js";
import type { CliFetch } from "../src/cli/types.js";
import { runCli } from "./helpers/cli.js";

function session(id: string, runtime: SessionSummary["runtime"] = "pi"): SessionSummary {
  return {
    id: `${runtime}:${id}`,
    conversationId: id,
    runtime,
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    pinned: false,
    unread: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function askDaemon(questions: Array<Record<string, unknown>>): {
  fetch: CliFetch;
  paths: string[];
  posted(): unknown;
} {
  const paths: string[] = [];
  let posted: unknown;
  const fetch: CliFetch = async (input, init) => {
    const url = new URL(input);
    paths.push(url.pathname);
    if (url.pathname === "/api/ghosts/casper/sessions") {
      return jsonResponse({ sessions: [session("conv")] });
    }
    if (url.pathname.endsWith("/ask") && init?.method === "GET") {
      return jsonResponse({
        ask: {
          id: "ask-1",
          createdAt: "2026-08-29T00:00:00.000Z",
          questions,
        },
      });
    }
    if (url.pathname.endsWith("/ask") && init?.method === "POST") {
      posted = JSON.parse(String(init.body));
      return jsonResponse({ accepted: true });
    }
    return jsonResponse({ error: { message: "unexpected request" } }, 500);
  };
  return { fetch, paths, posted: () => posted };
}

describe("CLI argv parser", () => {
  it("parses long, equals, short-value, boolean, and terminator forms", () => {
    expect(parseArgs([
      "--ghost=casper",
      "-s",
      "abc",
      "--json",
      "--",
      "--literal",
    ], { value: ["ghost", "session"] })).toEqual({
      positionals: ["--literal"],
      flags: { ghost: "casper", session: "abc", json: true },
    });
  });

  it("keeps a lone dash positional and rejects unknown flags", () => {
    expect(parseArgs(["-"]).positionals).toEqual(["-"]);
    expect(() => parseArgs(["--wat"])).toThrow(ArgsError);
    expect(() => parseArgs(["--ghost", "--json"], { value: ["ghost"] })).toThrow("--ghost requires a value");
    expect(() => parseArgs(["--ghost="], { value: ["ghost"] })).toThrow("--ghost= requires a value");
    expect(parseArgs(["--q", "model", "-q"], { value: ["q"] })).toEqual({
      positionals: [],
      flags: { q: "model", quiet: true },
    });
  });
});

describe("CLI output and addressing helpers", () => {
  it("formats relative times", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    expect(relativeTime("2026-08-29T11:57:00.000Z", now)).toBe("3m");
    expect(relativeTime("2026-08-29T10:00:00.000Z", now)).toBe("2h");
    expect(relativeTime("2026-08-25T12:00:00.000Z", now)).toBe("4d");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(61_000)).toBe("1m01s");
  });

  it("resolves exact and unique public/raw prefixes and refuses ambiguity", () => {
    const rows = [session("alpha"), session("alpine", "claude-code")];
    expect(resolveSessionPrefix(rows, "pi:alpha").conversationId).toBe("alpha");
    expect(resolveSessionPrefix(rows, "alph").conversationId).toBe("alpha");
    expect(() => resolveSessionPrefix(rows, "al")).toThrow(ArgsError);
  });

  it("selects the newest update", () => {
    const pinned = { ...session("older"), updatedAt: "2026-01-01T00:00:00.000Z", pinned: true };
    const recent = { ...session("recent"), updatedAt: "2026-01-02T00:00:00.000Z" };
    expect(latestSession([pinned, recent])).toEqual(recent);
  });
});

describe("ghost help", () => {
  it("is available without contacting the daemon for every command", async () => {
    for (const command of COMMANDS) {
      const result = await runCli([command.verb, "--help"]);
      expect(result.code, command.verb).toBe(0);
      expect(result.stdout, command.verb).toContain(`Usage: ghost ${command.verb}`);
    }
  });

  it("prints the embedded version and stable exit-code reference offline", async () => {
    const versionResult = await runCli(["--version"], {
      env: { GHOSTD_VERSION: "9.8.7" },
    });
    expect(versionResult).toMatchObject({ code: 0, stdout: "9.8.7\n" });

    const codes = await runCli(["help", "exit-codes"]);
    expect(codes.code).toBe(0);
    for (const { code } of EXIT_CODES) expect(codes.stdout).toContain(`  ${code}  `);
  });
});

describe("ghost skill", () => {
  it("mentions every command and stays concise", () => {
    const skill = renderSkillText(COMMANDS, EXIT_CODES);
    for (const command of COMMANDS) expect(skill).toContain(`ghost ${command.verb}`);
    expect(skill.split("\n").length).toBeLessThan(120);
  });
});

describe("ghost delegation", () => {
  it("prints a compact local projection without contacting ghostd", async () => {
    const loadDelegationStatus = vi.fn(async () => ({
      harnesses: [{
        id: "claude-code" as const,
        name: "Claude Code",
        kind: "native" as const,
        nativeConfiguration: true,
        installation: "installed" as const,
        authentication: "authenticated" as const,
        reason: null,
        usage: {
          source: "omarchy" as const,
          state: "missing" as const,
          updatedAt: null,
          stale: true,
          tier: null,
          status: null,
          help: null,
          limits: [],
          today: null,
        },
      }],
      claudeAgents: {
        state: "ready" as const,
        agents: [{ name: "reviewer", model: "sonnet" }],
        truncated: false,
      },
    }));

    const result = await runCli(["delegation"], {
      home: "/owner",
      cwd: "/repo",
      env: { PATH: "/usr/bin" },
      loadDelegationStatus,
      fetch: async () => { throw new Error("must not contact ghostd"); },
    });

    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: [
        "# Delegation",
        "harnesses claude-code=ready",
        "limits claude=missing",
        'claude-agents "reviewer"@"sonnet"',
        "",
      ].join("\n"),
    });
    expect(loadDelegationStatus).toHaveBeenCalledWith({
      cwd: "/repo",
      env: { PATH: "/usr/bin" },
      ownerHome: "/owner",
    });
  });
});

describe("CLI API adaptation", () => {
  it("shapes a single ask answer as an option or free text", async () => {
    const question = {
      id: "choice",
      question: "Pick one",
      options: [{ label: "Alpha" }, { label: "Beta" }],
    };
    for (const [input, result] of [
      ["2", { id: "choice", selectedOptions: ["Beta"] }],
      ["Alpha", { id: "choice", selectedOptions: ["Alpha"] }],
      ["Something else", { id: "choice", selectedOptions: [], customInput: "Something else" }],
    ] as const) {
      const daemon = askDaemon([question]);
      const response = await runCli([
        "ask", "answer", input, "-g", "casper", "-s", "conv", "--json",
      ], {
        env: { GHOSTD_PORT: "7718" },
        home: "/tmp/ghost-cli-unit",
        fetch: daemon.fetch,
      });
      expect(response.code, input).toBe(0);
      expect(daemon.posted()).toEqual({
        askId: "ask-1",
        kind: "submit",
        results: [result],
      });
      expect(daemon.paths).not.toContain("/api/ghosts");
    }
  });

  it("refuses to shape one answer across multiple questions", async () => {
    const daemon = askDaemon([
      { id: "one", question: "One?", options: [{ label: "Yes" }] },
      { id: "two", question: "Two?", options: [{ label: "No" }] },
    ]);
    const response = await runCli([
      "ask", "answer", "Yes", "-g", "casper", "-s", "conv", "--json",
    ], {
      env: { GHOSTD_PORT: "7718" },
      home: "/tmp/ghost-cli-unit",
      fetch: daemon.fetch,
    });
    expect(response.code).toBe(2);
    expect(response.stderr).toContain("supports one question");
    expect(daemon.posted()).toBeUndefined();
  });

  it("matches the shell todo glyphs", async () => {
    const fetch: CliFetch = async (input) => {
      const path = new URL(input).pathname;
      if (path === "/api/ghosts/casper/sessions") {
        return jsonResponse({ sessions: [session("conv")] });
      }
      return jsonResponse({
        todo: [{
          name: "Tasks",
          tasks: [
            { content: "pending", status: "pending" },
            { content: "active", status: "in_progress" },
            { content: "done", status: "completed" },
            { content: "blocked", status: "blocked" },
            { content: "dropped", status: "abandoned" },
          ],
        }],
      });
    };
    const response = await runCli(["todo", "-g", "casper", "-s", "conv"], {
      env: { GHOSTD_PORT: "7718" },
      home: "/tmp/ghost-cli-unit",
      fetch,
    });
    expect(response).toMatchObject({
      code: 0,
      stdout: "· pending\n▸ active\n✓ done\n⊘ blocked\n− dropped\n",
    });
  });

  it("reports the CLI version without requesting a version route", async () => {
    const paths: string[] = [];
    const fetch: CliFetch = async (input) => {
      const path = new URL(input).pathname;
      paths.push(path);
      if (path === "/api/ghosts") return jsonResponse([]);
      if (path === "/api/remote") {
        return jsonResponse({
          enabled: false,
          state: "off",
          scheme: null,
          hostname: null,
          url: null,
          tailscale: { installed: false, running: false, loggedIn: false, operator: false, certs: false },
          guests: "read-only",
          owner: null,
          problem: null,
        });
      }
      return jsonResponse({ error: { message: "unexpected request" } }, 500);
    };
    const response = await runCli(["status", "--json"], {
      env: { GHOSTD_PORT: "7718", GHOSTD_VERSION: "3.2.1" },
      home: "/tmp/ghost-cli-unit",
      fetch,
    });
    expect(JSON.parse(response.stdout)).toMatchObject({ version: "3.2.1", ghostCount: 0 });
    expect(paths.sort()).toEqual(["/api/ghosts", "/api/remote"]);
  });
});
