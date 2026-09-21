import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// The mock daemon must answer the routes the HUD relies on with the daemon's
// exact shapes: hooks status, the MCP catalog, the roster, a transcript, and a
// streamed turn. Paths inside the ghost home never leak into transcripts.
const here = dirname(fileURLToPath(import.meta.url));
const mockPath = resolve(here, "../../dev/mock-ghostd.mjs");
const child = spawn(process.execPath, [mockPath, "--port", "0", "--tool-steps", "2"], {
  stdio: ["ignore", "ignore", "pipe"],
});

try {
  const port = await new Promise((resolvePort, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`mock did not listen: ${output}`)), 5_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const found = output.match(/mock-ghostd on http:\/\/127\.0\.0\.1:(\d+)/u);
      if (!found) return;
      clearTimeout(timer);
      resolvePort(Number(found[1]));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock exited before listening (${code}): ${output}`));
    });
  });

  const hooksResponse = await fetch(`http://127.0.0.1:${port}/api/hooks`, {
    headers: { authorization: "Bearer mock-parity" },
  });
  assert.equal(hooksResponse.status, 200);
  const hooks = await hooksResponse.json();
  assert.deepEqual(Object.keys(hooks), ["active", "total", "events", "hooks"]);
  assert.equal(hooks.active, true);
  assert.equal(hooks.total, 2);
  assert.deepEqual(hooks.events, [
    { event: "before_prompt", count: 1 },
    { event: "session_stop", count: 1 },
  ]);
  assert.equal(hooks.hooks.length, hooks.total);
  assert.deepEqual(Object.keys(hooks.hooks[0]), ["event", "name", "description"]);
  const serializedHooks = JSON.stringify(hooks);
  for (const forbidden of [
    "command", "commands", "args", "arguments", "path", "paths", "prompt", "prompts",
    "context", "contexts", "error", "errors", "scheduler",
  ]) {
    assert.ok(!serializedHooks.includes(`"${forbidden}"`));
  }
  const hooksPost = await fetch(`http://127.0.0.1:${port}/api/hooks`, {
    method: "POST",
    headers: { authorization: "Bearer mock-parity" },
  });
  assert.equal(hooksPost.status, 405);
  assert.equal((await hooksPost.json()).error.code, "method_not_allowed");
  const perGhostHooks = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/hooks`);
  assert.equal(perGhostHooks.status, 404);

  const projectRoute = await fetch(
    `http://127.0.0.1:${port}/api/ghosts/casper/sessions/pi%3Asess-casper-1/project`,
  );
  assert.equal(projectRoute.status, 404);

  const mcpResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/mcp`);
  assert.equal(mcpResponse.status, 200);
  const mcp = await mcpResponse.json();
  assert.ok(mcp.servers.length > 0);
  assert.ok(mcp.servers.every((server) => server.source === "canonical"));
  assert.ok(mcp.servers.every((server) => server.path === "mcp.json"));

  const resourcesResponse = await fetch(
    `http://127.0.0.1:${port}/api/ghosts/casper/sessions/pi%3Asess-casper-1/resources`,
  );
  assert.equal(resourcesResponse.status, 200);
  const resources = await resourcesResponse.json();
  for (const row of [...resources.skills, ...resources.mcpServers, ...resources.diagnostics]) {
    assert.ok(["machine", "ghost"].includes(row.source));
  }

  const rosterResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts`);
  assert.equal(rosterResponse.status, 200);
  const roster = await rosterResponse.json();
  const casper = roster.find((ghost) => ghost.name === "casper");
  assert.ok(casper);

  const transcriptResponse = await fetch(
    `http://127.0.0.1:${port}/api/ghosts/casper/sessions/pi%3Asess-casper-1/transcript`,
  );
  assert.equal(transcriptResponse.status, 200);
  const transcript = JSON.stringify(await transcriptResponse.json());
  assert.ok(transcript.includes(join(homedir(), "project-brief.md")));
  assert.ok(!transcript.includes(join(casper.dir, "plans")));

  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "fresh-mock-ghost" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.ok(existsSync(created.dir));

  const turnResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: { messages: [{ role: "user", content: "probe tool trace" }] },
      options: { sessionId: "mock-trace-probe" },
    }),
  });
  assert.equal(turnResponse.status, 200);
  const turnEvents = await turnResponse.text();
  assert.ok(turnEvents.includes(join(homedir(), "step-2.md")));
  assert.ok(!turnEvents.includes(join(casper.dir, "plans")));
  if (created.dir.startsWith(join(homedir(), ".cache"))) rmSync(created.dir, { recursive: true, force: true });
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once("exit", resolveExit);
  });
}

console.log("mock ghostd parity probe passed");
