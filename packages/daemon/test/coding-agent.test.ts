import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseCodingAgent } from "../src/coding-agent.js";

let bin: string | null = null;

afterEach(() => {
  if (bin) rmSync(bin, { recursive: true, force: true });
  bin = null;
});

/** A PATH holding only these commands, each a script with this body. */
function path(commands: Record<string, string>): NodeJS.ProcessEnv {
  bin = mkdtempSync(join(tmpdir(), "ghost-coding-agent-"));
  for (const [name, body] of Object.entries(commands)) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { PATH: bin };
}

describe("chooseCodingAgent", () => {
  it("names Omarchy's default agent when it is installed and has a command", async () => {
    expect(await chooseCodingAgent(path({ "omarchy-default-agent": "echo codex", claude: "", codex: "" }))).toBe("codex");
  });

  it("names the first installed one when the default is another agent, or none is chosen", async () => {
    expect(await chooseCodingAgent(path({ "omarchy-default-agent": "echo pi", pi: "", codex: "", agy: "" }))).toBe("codex");
    expect(await chooseCodingAgent(path({ agy: "" }))).toBe("agy");
  });

  it("passes over one Omarchy's installer says is not installed, and names none when none is", async () => {
    expect(await chooseCodingAgent(path({ claude: "", "omarchy-install-claude-cli": "exit 1", codex: "" }))).toBe("codex");
    expect(await chooseCodingAgent(path({ "omarchy-default-agent": "echo claude" }))).toBeNull();
  });
});
