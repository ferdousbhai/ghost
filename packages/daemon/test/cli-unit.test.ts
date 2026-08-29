import { describe, expect, it } from "vitest";
import { ArgsError, parseArgs } from "../src/cli/args.js";
import { latestSession, resolveSessionPrefix, type SessionRow } from "../src/cli/common.js";
import { durationTime, relativeTime } from "../src/cli/output.js";
import { ghostCli } from "../src/cli/main.js";
import { SKILL_TEXT } from "../src/cli/skill.js";

class Sink {
  value = "";
  write(chunk: string): void {
    this.value += chunk;
  }
}

function session(id: string, runtime: SessionRow["runtime"] = "pi"): SessionRow {
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
  });
});

describe("CLI output and addressing helpers", () => {
  it("formats relative times", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    expect(relativeTime("2026-08-29T11:57:00.000Z", now)).toBe("3m");
    expect(relativeTime("2026-08-29T10:00:00.000Z", now)).toBe("2h");
    expect(relativeTime("2026-08-25T12:00:00.000Z", now)).toBe("4d");
    expect(durationTime(999)).toBe("999ms");
    expect(durationTime(61_000)).toBe("1m");
  });

  it("resolves exact and unique public/raw prefixes and refuses ambiguity", () => {
    const rows = [session("alpha"), session("alpine", "claude-code")];
    expect(resolveSessionPrefix(rows, "pi:alpha").conversationId).toBe("alpha");
    expect(resolveSessionPrefix(rows, "alph").conversationId).toBe("alpha");
    expect(() => resolveSessionPrefix(rows, "al")).toThrow(ArgsError);
  });

  it("selects the newest update without trusting pinned listing order", () => {
    const pinned = { ...session("older"), updatedAt: "2026-01-01T00:00:00.000Z", pinned: true };
    const recent = { ...session("recent"), updatedAt: "2026-01-02T00:00:00.000Z" };
    expect(latestSession([pinned, recent])).toEqual(recent);
  });
});

describe("ghost help", () => {
  it("is available without contacting the daemon for every command", async () => {
    for (const command of [
      "say", "list", "new", "rm", "use", "sessions", "show", "title", "fork", "pin",
      "unpin", "ask", "jobs", "plan", "todo", "model", "memory", "watch", "status",
      "smoke", "skill",
    ]) {
      const stdout = new Sink();
      const code = await ghostCli([command, "--help"], { stdout, stderr: new Sink() });
      expect(code, command).toBe(0);
      expect(stdout.value, command).toContain("Usage: ghost");
    }
  });

  it("prints the embedded version and stable exit-code reference offline", async () => {
    const versionOut = new Sink();
    expect(await ghostCli(["--version"], {
      env: { GHOSTD_VERSION: "9.8.7" },
      stdout: versionOut,
      stderr: new Sink(),
    })).toBe(0);
    expect(versionOut.value).toBe("9.8.7\n");

    const codesOut = new Sink();
    expect(await ghostCli(["help", "exit-codes"], {
      stdout: codesOut,
      stderr: new Sink(),
    })).toBe(0);
    for (const code of [0, 1, 2, 3, 4, 5, 6]) expect(codesOut.value).toContain(`  ${code}  `);
  });
});

describe("ghost skill", () => {
  it("mentions every command and stays concise", () => {
    for (const command of [
      "say", "list", "new", "rm", "use", "sessions", "show", "title", "fork", "pin",
      "unpin", "ask", "jobs", "plan", "todo", "model", "memory", "watch", "status",
      "smoke", "skill", "help",
    ]) expect(SKILL_TEXT).toContain(`ghost ${command}`);
    expect(SKILL_TEXT.split("\n").length).toBeLessThan(120);
  });
});
