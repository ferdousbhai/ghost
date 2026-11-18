
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/session-host.js";
import { ArgsError, parseArgs } from "../src/cli/args.js";
import { EXIT_CODES } from "../src/cli/client.js";
import { latestSession, resolveSessionPrefix } from "../src/cli/common.js";
import { COMMANDS } from "../src/cli/main.js";
import { HELP_TOPICS } from "../src/help-topics.js";
import { relativeTime } from "../src/cli/output.js";
import type { CliFetch } from "../src/cli/types.js";
import { runCli } from "./helpers/cli.js";

function session(id: string): SessionSummary {
  return {
    id,
    title: null,
    preview: null,
    source: null,
    harness: "claude",
    model: null,
    provider: null,
    effort: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    pinned: false,
    unread: false,
    running: false,
    question: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("a ghost's own shell addresses its conversation", () => {
  const env = { GHOSTD_PORT: "7718", GHOST: "casper", GHOST_SESSION: "conv-mine" };
  const sessions = [session("conv-other"), session("conv-mine")];

  it("reads $GHOST_SESSION in place of -s", async () => {
    const paths: string[] = [];
    const fetch: CliFetch = async (input) => {
      const path = new URL(input).pathname;
      paths.push(path);
      if (path === "/api/ghosts/casper/sessions") return jsonResponse({ sessions });
      if (path.endsWith("/transcript")) {
        return jsonResponse({ id: "conv-mine", title: null, harness: null, messages: [], total: 0, truncated: false });
      }
      return jsonResponse({ error: { message: "unexpected request" } }, 500);
    };
    const result = await runCli(["show", "--json"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(result.code).toBe(0);
    expect(paths).toContain("/api/ghosts/casper/sessions/conv-mine/transcript");
  });

  it("`ghost ask` asks in its own conversation, and --clear withdraws", async () => {
    const calls: Array<{ request: string; body: unknown }> = [];
    const fetch: CliFetch = async (input, init) => {
      const path = new URL(input).pathname;
      calls.push({ request: `${init?.method ?? "GET"} ${path}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/ghosts/casper/sessions") return jsonResponse({ sessions });
      if (path.endsWith("/question")) return jsonResponse({ ok: true });
      return jsonResponse({ error: { message: "unexpected request" } }, 500);
    };
    const asked = await runCli(["ask", "Ship it tonight?", "yes", "wait for review"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(asked.code).toBe(0);
    expect(calls).toContainEqual({
      request: "PUT /api/ghosts/casper/sessions/conv-mine/question",
      body: { text: "Ship it tonight?", options: ["yes", "wait for review"] },
    });
    expect((await runCli(["ask", "--clear"], { env, home: "/tmp/ghost-cli-unit", fetch })).code).toBe(0);
    expect(calls.map((call) => call.request)).toContain("DELETE /api/ghosts/casper/sessions/conv-mine/question");
    expect((await runCli(["ask"], { env, home: "/tmp/ghost-cli-unit", fetch })).code).not.toBe(0);
  });

  it("`ghost stop` targets the running turn", async () => {
    const requests: string[] = [];
    const running = [session("conv-other"), { ...session("conv-mine"), running: true }];
    const fetch: CliFetch = async (input, init) => {
      const path = new URL(input).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/ghosts/casper/sessions") return jsonResponse({ sessions: running });
      if (path.endsWith("/stop")) return jsonResponse({ stopped: true });
      return jsonResponse({ error: { message: "unexpected request" } }, 500);
    };
    const result = await runCli(["stop"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(result.code).toBe(0);
    expect(requests).toContain("POST /api/ghosts/casper/sessions/conv-mine/stop");
  });

  it("turns a follow-up to an idle conversation into its next turn", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetch: CliFetch = async (input, init) => {
      const path = new URL(input).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/ghosts/casper/sessions") return jsonResponse({ sessions });
      if (path.endsWith("/queue")) {
        return jsonResponse({ error: { code: "session_not_streaming", message: "idle" } }, 409);
      }
      if (path === "/api/ghosts/casper/messages") {
        return sseResponse([{ type: "text_delta", delta: "Noted." }, { type: "done" }]);
      }
      return jsonResponse({ error: { message: "unexpected request" } }, 500);
    };
    const result = await runCli(["say", "--follow-up", "-q", "job finished"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(result).toMatchObject({ code: 0, stdout: "Noted.\n" });
    const turn = calls.find((call) => call.path === "/api/ghosts/casper/messages");
    expect(turn?.body).toMatchObject({ sessionId: "conv-mine" });
  });

  it("acknowledges a follow-up queued into a live turn in words, and -q prints nothing", async () => {
    const fetch: CliFetch = async (input) => {
      const path = new URL(input).pathname;
      if (path === "/api/ghosts/casper/sessions") return jsonResponse({ sessions });
      if (path.endsWith("/queue")) return jsonResponse({ streaming: true, followUp: ["job finished"] });
      return jsonResponse({ error: { message: "unexpected request" } }, 500);
    };
    const human = await runCli(["say", "--follow-up", "job finished"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(human).toMatchObject({ code: 0, stdout: "queued for conv-mine\n" });
    const quiet = await runCli(["say", "--follow-up", "-q", "job finished"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(quiet).toMatchObject({ code: 0, stdout: "" });
  });

  it("`ghost show` prints a long conversation's newest page and says which messages it is", async () => {
    const total = 5;
    const queries: string[] = [];
    const fetch: CliFetch = async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/ghosts/casper/sessions") return jsonResponse({ sessions });
      queries.push(url.search);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const messages = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({
        role: "user", entryId: `e${offset + index}`, content: [{ type: "text", text: `message ${offset + index + 1}` }],
      }));
      return jsonResponse({ id: "conv-mine", messages, total, truncated: messages.length < total, readThrough: null });
    };
    const newest = await runCli(["show", "--limit", "2"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(newest.code).toBe(0);
    expect(queries).toEqual(["?limit=2", "?limit=2&offset=3"]);
    expect(newest.stdout).toContain("message 5");
    expect(newest.stdout).not.toContain("message 1\n");
    expect(newest.stdout).toContain("(messages 4–5 of 5; --offset/--limit for others)");

    queries.length = 0;
    const oldest = await runCli(["show", "--limit", "2", "--offset", "0"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(queries).toEqual(["?limit=2&offset=0"]);
    expect(oldest.stdout).toContain("message 1");
    expect(oldest.stdout).toContain("(messages 1–2 of 5; --offset/--limit for others)");

    queries.length = 0;
    const whole = await runCli(["show"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(queries).toEqual([""]);
    expect(whole.stdout).not.toContain("(messages");
  });

  it("-q keeps a read verb's primary output: the transcript without its paging note, the character body", async () => {
    const fetch: CliFetch = async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/ghosts/casper/sessions") return jsonResponse({ sessions });
      if (url.pathname === "/api/ghosts/casper/character") return jsonResponse({ body: "# Casper\nFriendly.\n" });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return jsonResponse({
        id: "conv-mine",
        messages: [{ role: "user", entryId: `e${offset}`, content: [{ type: "text", text: `message ${offset + 1}` }] }],
        total: 3,
        truncated: true,
        readThrough: null,
      });
    };
    const show = await runCli(["show", "-q", "--limit", "1"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("message 3");
    expect(show.stdout).not.toContain("(messages");
    const character = await runCli(["character", "show", "-q"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(character).toMatchObject({ code: 0, stdout: "# Casper\nFriendly.\n" });
  });

  it("still fails a follow-up on any other conflict", async () => {
    const fetch: CliFetch = async (input) => {
      const path = new URL(input).pathname;
      if (path === "/api/ghosts/casper/sessions") return jsonResponse({ sessions });
      if (path.endsWith("/queue")) return jsonResponse({ error: { code: "session_busy", message: "busy" } }, 409);
      return jsonResponse({ error: { message: "unexpected request" } }, 500);
    };
    const result = await runCli(["say", "--follow-up", "x"], { env, home: "/tmp/ghost-cli-unit", fetch });
    expect(result.code).toBe(EXIT_CODES.find((entry) => entry.meaning === "busy or conflict")?.code);
  });
});

describe("ghost help <topic>", () => {
  it("renders a recipe for the ghost the shell belongs to, without a daemon", async () => {
    const result = await runCli(["help", "timers"], {
      env: { GHOSTD_PORT: "7718", GHOST: "casper", XDG_CONFIG_HOME: "/tmp/ghost-cli-unit/xdg", PATH: "/nonexistent" },
      home: "/tmp/ghost-cli-unit",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ghost-timer-v1-6-casper-<slug>");
    expect(result.stdout).toContain('"/tmp/ghost-cli-unit/xdg/systemd/user"');
    expect(result.stdout).toContain("ExecStart=/usr/bin/ghost say --new --ghost casper");
  });

  it("renders every recipe before any ghost is named", async () => {
    for (const topic of HELP_TOPICS) {
      const result = await runCli(["help", topic], { env: { PATH: "/nonexistent" }, home: "/tmp/ghost-cli-unit" });
      expect(result.stderr, topic).toBe("");
      expect(result.code, topic).toBe(0);
      if (topic === "timers") expect(result.stdout).toContain("ghost-timer-v1-<name-length>-<ghost>-<slug>");
    }
  });

  it("restarts without sending a model prompt", async () => {
    const result = await runCli(["help", "self"], {
      env: { GHOSTD_PORT: "7718", GHOST: "casper", GHOST_SESSION: "conv-mine", PATH: "/nonexistent" },
      home: "/tmp/ghost-cli-unit",
    });
    expect(result.stdout).not.toContain("ghost say");
  });
});

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
    expect(() => parseArgs(["--ghost", "--json"], { value: ["ghost"] })).toThrow("'--ghost' argument is ambiguous");
    expect(() => parseArgs(["--ghost"], { value: ["ghost"] })).toThrow("argument missing");
    expect(() => parseArgs(["--ghost="], { value: ["ghost"] })).toThrow("--ghost requires a value");
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
  });

  it("resolves exact and unique public/raw prefixes and refuses ambiguity", () => {
    const rows = [session("alpha"), session("alpine")];
    expect(resolveSessionPrefix(rows, "alpha").id).toBe("alpha");
    expect(resolveSessionPrefix(rows, "alph").id).toBe("alpha");
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

  it("refuses a malformed verb before asking the daemon anything", async () => {
    const fetch: CliFetch = async (input) => {
      throw new Error(`unexpected request to ${String(input)}`);
    };
    for (const argv of [
      ["ask"],
      ["ask", "--clear", "Ship it?"],
      ["character", "edit"],
      ["character", "set"],
      ["harness", "claude", "--none"],
      ["mcp", "bogus"],
      ["mcp", "rm"],
      ["mcp", "add", "github"],
      ["mcp", "list", "github"],
      ["mcp", "enable", "github", "slack"],
      ["hooks", "show", "extra"],
      ["character", "show", "extra"],
      ["say", "hello", "-m", "world"],
    ]) {
      const result = await runCli(argv, { env: { GHOST: "casper", GHOST_SESSION: "conv-1" }, home: "/tmp/ghost-cli-unit", fetch });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).not.toContain("cannot reach ghostd");
    }
  });

  it("refuses -g or -s on a verb whose usage does not list it", async () => {
    const fetch: CliFetch = async (input) => {
      throw new Error(`unexpected request to ${String(input)}`);
    };
    for (const argv of [
      ...["harness", "sessions", "mcp", "character", "rename x", "routines", "event a b"].map((verb) => [...verb.split(" "), "-s", "conv-1"]),
      ...["list", "new x", "use", "hooks", "remote", "status", "harnesses", "smoke", "delegate claude"].map((verb) => [...verb.split(" "), "-g", "casper"]),
    ]) {
      const result = await runCli(argv, { env: { GHOST: "casper", GHOST_SESSION: "conv-1" }, home: "/tmp/ghost-cli-unit", fetch });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).toContain("Unknown option");
    }
    // -g still renders a recipe for the named ghost.
    expect(await runCli(["help", "timers", "-g", "casper"], { env: {}, home: "/tmp/ghost-cli-unit", fetch })).toMatchObject({ code: 0 });
  });

  it("refuses a missing or malformed input file before asking the daemon anything", async () => {
    const fetch: CliFetch = async (input) => {
      throw new Error(`unexpected request to ${String(input)}`);
    };
    const dir = mkdtempSync(join(tmpdir(), "ghost-cli-files-"));
    try {
      const missing = join(dir, "missing.json");
      const malformed = join(dir, "malformed.json");
      writeFileSync(malformed, "{ not json");
      for (const [argv, message] of [
        [["mcp", "add", "github", malformed], `${malformed} is not valid JSON`],
        [["mcp", "set", "github", missing], "ENOENT"],
        [["hooks", "set", malformed], `${malformed} is not valid JSON`],
        [["character", "set", missing], "ENOENT"],
        [["routines", "edit", "daily", missing], "ENOENT"],
        [["routines", "edit", "daily", malformed], `${malformed} is not valid JSON`],
      ] as const) {
        const result = await runCli([...argv], { env: { GHOST: "casper" }, home: dir, fetch });
        expect(result.code, argv.join(" ")).toBe(2);
        expect(result.stderr, argv.join(" ")).toContain(message);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  it("prints the memory and dictation recipes offline and lists them in its usage", async () => {
    for (const topic of ["memory", "dictation"]) {
      const result = await runCli(["help", topic], { env: {}, home: "/tmp/ghost-cli-unit" });
      expect(result.code, topic).toBe(0);
      expect(result.stdout, topic).toMatch(/^# /u);
    }
    expect((await runCli(["help", "help"])).stdout).toContain("memory|dictation");
  });

  it("refuses a topic it does not know, as it refuses an unknown verb", async () => {
    const result = await runCli(["help", "timer"]);
    expect(result).toMatchObject({ code: 2, stdout: "" });
    expect(result.stderr).toBe("ghost: Unknown help topic: timer\n");
  });
});

describe("CLI API adaptation", () => {
  it("ghost remote prints a problem's message, not the object", async () => {
    const fetch: CliFetch = async () => jsonResponse({
      state: "off",
      hostname: null,
      problem: { code: "tailscale_stopped", message: "Tailscale is not running", action: "sudo tailscale up" },
    });
    const response = await runCli(["remote"], { env: { GHOSTD_PORT: "7718" }, home: "/tmp/ghost-cli-unit", fetch });
    expect(response.stdout).toBe("off (Tailscale is not running)\n");
    const unavailable: CliFetch = async () => jsonResponse({
      state: "unavailable", hostname: null, app: null,
      problem: { code: "tailscale_stopped", message: "Tailscale is not running", action: "sudo tailscale up" },
    });
    expect((await runCli(["remote"], { env: { GHOSTD_PORT: "7718" }, home: "/tmp/ghost-cli-unit", fetch: unavailable })).stdout)
      .toBe("unavailable (Tailscale is not running)\n");
  });

  it("ghost remote prints the app link, and how to get HTTPS without it", async () => {
    let body: Record<string, unknown> = {
      state: "on", hostname: "box.tail.ts.net", problem: null,
      app: { origin: "https://summonghost.com", url: "https://summonghost.com/#add=box.tail.ts.net" },
    };
    const fetch: CliFetch = async () => jsonResponse(body);
    const run = () => runCli(["remote", "on"], { env: { GHOSTD_PORT: "7718" }, home: "/tmp/ghost-cli-unit", fetch });
    expect((await run()).stdout).toBe("on box.tail.ts.net\napp https://summonghost.com/#add=box.tail.ts.net\n");
    const refused = { state: "off", hostname: "box.tail.ts.net", app: { origin: "https://summonghost.com", url: null },
      problem: { code: "https_required", message: "This tailnet has no HTTPS certificates." } };
    expect((await runCli(["remote", "on"], { env: { GHOSTD_PORT: "7718" }, home: "/tmp/ghost-cli-unit", fetch: async () => jsonResponse(refused) })).stdout)
      .toBe("off (This tailnet has no HTTPS certificates.)\n");
    body = { ...body, app: null };
    expect((await run()).stdout).toBe("on box.tail.ts.net\nno app: remote.apps is empty, so nothing can reach Ghost remotely\n");
  });

  it("ghost hooks status prints each hook's event, name, and description", async () => {
    const fetch: CliFetch = async () => jsonResponse({
      path: "/home/owner/.config/ghost/hooks.json",
      document: { hooks: {
        session_stop: [{ hooks: [{ type: "command", command: "/bin/true", name: "Review", description: "Reviews the pass." }] }],
        turn_end: [{ hooks: [{ type: "command", command: "/bin/true" }] }],
      } },
    });
    const response = await runCli(["hooks"], { env: { GHOSTD_PORT: "7718" }, home: "/tmp/ghost-cli-unit", fetch });
    expect(response.stdout.split("\n").map((line) => line.trim().split(/\s{2,}/))).toEqual([
      ["EVENT", "NAME", "DESCRIPTION"],
      ["session_stop", "Review", "Reviews the pass."],
      ["turn_end", "Turn-end command hook", "Observes final turn success or failure without continuing it."],
      [""],
    ]);
  });

  it("ghost hooks set acknowledges in words; --json keeps the API body and -q prints nothing", async () => {
    const config = {
      path: "/home/owner/.config/ghost/hooks.json",
      document: { hooks: { turn_end: [{ hooks: [{ type: "command", command: "/bin/true" }, { type: "command", command: "/bin/false" }] }] } },
    };
    const fetch: CliFetch = async (_input, init) => {
      expect(init?.method).toBe("PUT");
      return jsonResponse(config);
    };
    const dir = mkdtempSync(join(tmpdir(), "ghost-cli-hooks-"));
    try {
      const file = join(dir, "hooks.json");
      writeFileSync(file, JSON.stringify(config.document));
      const run = (...flags: string[]) => runCli(["hooks", "set", file, ...flags], { env: { GHOSTD_PORT: "7718" }, home: dir, fetch });
      expect(await run()).toMatchObject({ code: 0, stdout: "replaced /home/owner/.config/ghost/hooks.json (2 hooks)\n" });
      expect(JSON.parse((await run("--json")).stdout)).toEqual(config);
      expect(await run("-q")).toMatchObject({ code: 0, stdout: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A daemon answering `ghost status`'s three reads, `/api/status` with `daemon`. */
  const statusDaemon = (daemon: Record<string, unknown>): CliFetch => async (input) => {
    const path = new URL(input).pathname;
    if (path === "/api/ghosts") return jsonResponse([]);
    if (path === "/api/status") return jsonResponse(daemon);
    if (path === "/api/remote") {
      return jsonResponse({
        state: "off", hostname: null, guests: "read-only", owner: null, app: null,
        problem: { code: "https_required", message: "This tailnet has no HTTPS certificates." },
      });
    }
    return jsonResponse({ error: { code: "not_found", message: "Not found." } }, 404);
  };

  it("reports the running daemon's version, commit, and source root, and remote access", async () => {
    const response = await runCli(["status"], {
      env: { GHOSTD_PORT: "7718", GHOSTD_VERSION: "3.2.1" },
      home: "/tmp/ghost-cli-unit",
      fetch: statusDaemon({
        version: "1.4.0",
        source: { commit: "0123456789abcdef0123456789abcdef01234567", root: "/home/owner/src/ghost" },
        startedAt: "2026-10-28T12:40:53.000Z",
        restartNeeded: false,
      }),
    });
    expect(response.stdout).toContain("daemon version 1.4.0");
    expect(response.stdout).toContain("daemon commit  0123456789abcdef0123456789abcdef01234567");
    expect(response.stdout).toContain("daemon source  /home/owner/src/ghost");
    expect(response.stdout).toContain("remote         off (This tailnet has no HTTPS certificates.)\n");
    expect(response.stdout).not.toContain("restart needed");
  });

  // An update that was not restarted into still answers under the same
  // version; status says so, and points at the safe way to restart.
  it("says when the code on disk is newer than the running daemon", async () => {
    const fetch = statusDaemon({ version: "1.4.0", source: { commit: null, root: null },
      startedAt: "2026-10-28T12:40:53.000Z", restartNeeded: true });
    const response = await runCli(["status"], { env: { GHOSTD_PORT: "7718" }, home: "/tmp/ghost-cli-unit", fetch });
    expect(response.stdout).toContain("daemon started 2026-10-28T12:40:53.000Z");
    expect(response.stdout).toContain("restart needed code on disk is newer than this daemon (ghost help self)");
  });
});
