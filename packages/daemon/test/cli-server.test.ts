import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ListeningServer } from "../src/server.js";
import type { SessionHost } from "../src/session-host.js";
import { runCli } from "./helpers/cli.js";
import { startTestDaemon, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse } from "./helpers/http-fetch.js";
import type { MockProvider } from "./helpers/mock-provider.js";

const API_TOKEN = "a".repeat(64);
let temp: TempGhosts;
let provider: MockProvider;
let host: SessionHost;
let listening: ListeningServer | null;
let tokenFile: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  const fixture = await startTestDaemon({
    ghost: "casper",
    openSession: "conv-1",
  });
  ({ temp, provider, host, listening, tokenFile, env } = fixture);
});

afterEach(async () => {
  await listening?.close();
  await host.disposeAll();
  await provider.close();
  temp.cleanup();
});

async function cli(argv: string[], overrides: { env?: NodeJS.ProcessEnv } = {}) {
  return runCli(argv, {
    env: overrides.env ?? env,
    home: temp.ownerHome,
    fetch: fetchNoReuse,
  });
}

describe("ghost CLI against a real daemon server", () => {
  it("lists, creates, and persists a validated default mode 0600", async () => {
    const listed = await cli(["list", "--json"]);
    expect(listed).toMatchObject({ code: 0 });
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ name: "casper" })]);

    expect(await cli(["new", "probe", "--json"])).toMatchObject({ code: 0 });
    const used = await cli(["use", "casper"]);
    expect(used).toMatchObject({ code: 0, stdout: "casper\n" });
    const path = join(env.XDG_CONFIG_HOME!, "ghost", "cli.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ghost: "casper" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await cli(["use", "--json"])).stdout)).toEqual({ ghost: "casper" });

    const defaultSessions = await cli(["sessions", "--json"]);
    expect(defaultSessions).toMatchObject({ code: 0 });
    expect(JSON.parse(defaultSessions.stdout).sessions).toEqual([
      expect.objectContaining({ conversationId: "conv-1" }),
    ]);
  });

  it("lists sessions and reports status", async () => {
    const sessions = await cli(["sessions", "-g", "casper", "--json"]);
    expect(sessions.code).toBe(0);
    expect(JSON.parse(sessions.stdout).sessions).toEqual([
      expect.objectContaining({ conversationId: "conv-1" }),
    ]);

    const status = await cli(["status", "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      daemon: `http://127.0.0.1:${listening!.port}`,
      authenticated: true,
      version: expect.any(String),
    });
  });

  it("reports no ask and empty jobs", async () => {
    expect(JSON.parse((await cli(["ask", "-g", "casper", "-s", "conv", "--json"])).stdout)).toEqual({ ask: null });
    expect(await cli(["jobs", "-g", "casper", "-s", "conv", "--json"])).toMatchObject({
      code: 0,
      stdout: "{\"jobs\":[]}\n",
    });
  });


  it("reaches ghost admin and conversation state through named verbs", async () => {
    const shown = await cli(["character", "-g", "casper"]);
    expect(shown.code).toBe(0);
    const file = join(env.XDG_CONFIG_HOME!, "character.md");
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true });
    writeFileSync(file, "# Casper\n\nA quiet ghost.\n");
    expect(await cli(["character", "set", file, "-g", "casper", "--json"])).toMatchObject({ code: 0 });
    expect((await cli(["character", "-g", "casper"])).stdout).toContain("A quiet ghost.");

    const read = await cli(["read", "-g", "casper", "-s", "conv", "--json"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ ok: true });
    expect(JSON.parse((await cli(["resources", "-g", "casper", "-s", "conv", "--json"])).stdout))
      .toHaveProperty("skills");
    expect(JSON.parse((await cli(["project", "-g", "casper", "-s", "conv", "--json"])).stdout))
      .toHaveProperty("generation");
    expect(await cli(["remote"])).toMatchObject({ code: 5 });
    expect(await cli(["delete", "-g", "casper", "-s", "conv"])).toMatchObject({ code: 2 });
  });

  it("keeps destructive removal behind --yes", async () => {
    const result = await cli(["rm", "casper"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires --yes");
    expect(temp.registry.get("casper").name).toBe("casper");
  });

  it("maps a wrong token to exit 4 with the owner hint", async () => {
    writeFileSync(tokenFile, `${"b".repeat(64)}\n`, { mode: 0o600 });
    const result = await cli(["status"]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("ghostd api-token");
    expect(result.stderr).toContain(tokenFile);
  });

  it("re-reads a rotated token once after a 401", async () => {
    writeFileSync(tokenFile, `${"b".repeat(64)}\n`, { mode: 0o600 });
    let calls = 0;
    const retryingFetch: typeof fetchNoReuse = async (input, init) => {
      calls += 1;
      const response = await fetchNoReuse(input, init);
      if (response.status === 401) writeFileSync(tokenFile, `${API_TOKEN}\n`, { mode: 0o600 });
      return response;
    };
    const result = await runCli(["list", "--json"], {
      env,
      home: temp.ownerHome,
      fetch: retryingFetch,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(calls).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ name: "casper" })]);
  });

  it("maps a closed daemon to exit 3", async () => {
    const port = listening!.port;
    await listening!.close();
    listening = null;
    const result = await cli(["status"], { env: { ...env, GHOSTD_PORT: String(port) } });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("cannot reach ghostd");
  });

  it("returns empty jobs for a valid unknown public conversation id", async () => {
    const headers = { authorization: `Bearer ${API_TOKEN}` };
    const base = `http://127.0.0.1:${listening!.port}/api/ghosts/casper/sessions/${encodeURIComponent("pi:unknown")}`;
    const jobs = await fetchNoReuse(`${base}/jobs`, { headers });
    expect(await jobs.json()).toEqual({ jobs: [] });
  });
});
