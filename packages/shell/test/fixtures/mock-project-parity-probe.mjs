import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  MOCK_PROJECT_SCAN_LIMITS,
  MOCK_PROJECT_SOURCES,
  MOCK_PROJECT_WARNING_TEXT,
  mockProjectResources,
  mockProjectWarnings,
  resolveMockProjectRoot,
} from "../../dev/mock-project-fixture.mjs";

assert.deepEqual(MOCK_PROJECT_SOURCES.instructionCandidates, [
  ".omp/AGENTS.md",
  ".claude/CLAUDE.md",
  ".agents/AGENTS.md",
  "AGENTS.md",
  "CLAUDE.md",
]);

const expectedRoots = {
  skills: ["skills/", ".agents/skills/", ".claude/skills/", ".pi/skills/", ".omp/skills/"],
  rules: ["rules/", ".claude/rules/", ".omp/rules/"],
  prompts: ["prompts/", ".claude/prompts/", ".omp/prompts/"],
  commands: ["commands/", ".claude/commands/", ".omp/commands/"],
  agents: ["agents/", ".claude/agents/", ".omp/agents/"],
};
for (const [kind, roots] of Object.entries(expectedRoots)) {
  assert.equal(MOCK_PROJECT_SOURCES[kind].length, roots.length);
  for (let index = 0; index < roots.length; index += 1) {
    assert.ok(MOCK_PROJECT_SOURCES[kind][index].startsWith(roots[index]));
  }
}
assert.deepEqual(MOCK_PROJECT_SOURCES.mcpFiles.map((source) => source.path), [
  ".omp/mcp.json", ".omp/.mcp.json",
]);
assert.deepEqual(MOCK_PROJECT_SOURCES.executable.map((path) => path.split("/").slice(0, -1).join("/")), [
  ".omp/extensions", ".pi/extensions", ".omp/hooks", ".omp/tools", ".claude/hooks",
]);
assert.deepEqual(MOCK_PROJECT_SCAN_LIMITS, {
  entries: 512, bytes: 1_048_576, fileBytes: 262_144, depth: 8, timeoutMs: 1_000,
});
for (const warning of Object.values(MOCK_PROJECT_WARNING_TEXT)) assert.equal(typeof warning, "string");

const resources = mockProjectResources();
assert.deepEqual(resources, {
  instructions: 1,
  skills: 5,
  rules: 3,
  prompts: 3,
  commands: 3,
  agents: 3,
  mcpServers: 3,
  ignoredExecutable: 5,
});
for (const value of Object.values(resources)) {
  assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= MOCK_PROJECT_SCAN_LIMITS.entries);
}
assert.deepEqual(mockProjectWarnings(resources), [
  "5 executable project resource(s) will remain disabled until isolated workers are available.",
]);
assert.deepEqual(mockProjectWarnings(resources, {
  scanWarnings: [MOCK_PROJECT_WARNING_TEXT.entryLimit],
  truncated: true,
}), [
  MOCK_PROJECT_WARNING_TEXT.entryLimit,
  "5 executable project resource(s) will remain disabled until isolated workers are available.",
  MOCK_PROJECT_WARNING_TEXT.truncated,
]);

const fixture = mkdtempSync(join(tmpdir(), "ghost-mock-project-parity-"));
try {
  const project = join(fixture, "project");
  const nested = join(project, "packages", "shell");
  mkdirSync(nested, { recursive: true });
  assert.equal(resolveMockProjectRoot(project), resolve(project));
  assert.equal(resolveMockProjectRoot(nested), resolve(nested));
  assert.equal(resolveMockProjectRoot("relative/project"), null);

  const projectLink = join(fixture, "project-link");
  symlinkSync(project, projectLink);
  assert.equal(resolveMockProjectRoot(projectLink), null);
  assert.equal(resolveMockProjectRoot(join(projectLink, "packages")), null);

  const outside = join(fixture, "outside");
  mkdirSync(outside);
  const linkedParent = join(project, "linked-parent");
  symlinkSync(outside, linkedParent);
  assert.equal(resolveMockProjectRoot(linkedParent), null);

  const file = join(project, "not-a-directory");
  writeFileSync(file, "fixture", "utf8");
  assert.equal(resolveMockProjectRoot(file), null);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("mock project fixture parity probe passed");

const routeFixture = mkdtempSync(join(tmpdir(), "ghost-mock-project-route-"));
const routeProject = join(routeFixture, "project");
const routeLink = join(routeFixture, "project-link");
mkdirSync(routeProject);
symlinkSync(routeProject, routeLink);
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
  const preview = async (path) => fetch(
    `http://127.0.0.1:${port}/api/ghosts/casper/sessions/pi%3Aparity/project/preview`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );

  const hooksResponse = await fetch(`http://127.0.0.1:${port}/api/hooks`, {
    headers: { authorization: "Bearer mock-parity" },
  });
  assert.equal(hooksResponse.status, 200);
  const hooks = await hooksResponse.json();
  assert.deepEqual(Object.keys(hooks), ["active", "total", "events", "hooks"]);
  assert.equal(hooks.active, true);
  assert.equal(hooks.total, 3);
  assert.deepEqual(hooks.events, [
    { event: "before_prompt", count: 1 },
    { event: "session_stop", count: 1 },
    { event: "conversation_idle", count: 1 },
  ]);
  assert.equal(hooks.hooks.length, hooks.total);
  assert.deepEqual(Object.keys(hooks.hooks[0]), ["event", "source", "name", "description"]);
  assert.deepEqual(Object.keys(hooks.hooks[2]), [
    "event", "source", "name", "description", "idleSeconds", "settingsKey",
  ]);
  assert.equal(hooks.hooks[2].idleSeconds, 60);
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

  const accepted = await preview(routeProject);
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.root, resolve(routeProject));
  assert.deepEqual(body.resources, resources);
  assert.deepEqual(body.warnings, mockProjectWarnings(resources));
  assert.deepEqual(Object.keys(body.resources), [
    "instructions", "skills", "rules", "prompts", "commands", "agents",
    "mcpServers", "ignoredExecutable",
  ]);

  const projectRoute = `http://127.0.0.1:${port}/api/ghosts/casper/sessions/pi%3Aparity/project`;
  const boundDraftResponse = await fetch(projectRoute, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      root: body.root,
      cwd: body.root,
      trustToken: body.trustToken,
      expectedGeneration: 0,
    }),
  });
  assert.equal(boundDraftResponse.status, 200);
  assert.equal((await boundDraftResponse.json()).root, body.root);
  const abandonedDraftResponse = await fetch(`${projectRoute}/draft`, { method: "DELETE" });
  assert.equal(abandonedDraftResponse.status, 200);
  assert.deepEqual(await abandonedDraftResponse.json(), {
    ok: true,
    id: "pi:parity",
    conversationId: "parity",
    runtime: "pi",
    abandoned: true,
  });
  const repeatedAbandonResponse = await fetch(`${projectRoute}/draft`, { method: "DELETE" });
  assert.equal(repeatedAbandonResponse.status, 200);
  assert.equal((await repeatedAbandonResponse.json()).abandoned, false);
  const publishedAbandonResponse = await fetch(
    `http://127.0.0.1:${port}/api/ghosts/casper/sessions/pi%3Asess-casper-1/project/draft`,
    { method: "DELETE" },
  );
  assert.equal(publishedAbandonResponse.status, 409);
  assert.equal((await publishedAbandonResponse.json()).error.code, "project_draft_published");

  const rejected = await preview(routeLink);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, "invalid_project_path");

  const memoryResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/memory`);
  assert.equal(memoryResponse.status, 200);
  const memory = await memoryResponse.json();
  assert.ok(Array.isArray(memory.memory) && memory.memory.length > 0);
  assert.deepEqual(Object.keys(memory.memory[0]).sort(), ["content", "path", "slug", "updated"]);
  assert.deepEqual(memory.skipped, []);
  const writtenResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/memory`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Probe fact worth keeping." }),
  });
  assert.equal(writtenResponse.status, 200);
  const written = await writtenResponse.json();
  assert.equal(written.slug, "probe-fact-worth-keeping");
  assert.equal(written.created, true);
  const trashedResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/memory`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: written.path, confirm: written.path }),
  });
  assert.equal(trashedResponse.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/memory`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "   " }),
  })).status, 400);

  const mcpResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/mcp`);
  assert.equal(mcpResponse.status, 200);
  const mcp = await mcpResponse.json();
  assert.ok(mcp.servers.length > 0);
  assert.ok(mcp.servers.every((server) => server.source === "canonical"));
  assert.ok(mcp.servers.every((server) => server.path === "mcp.json"));

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
  assert.ok(transcript.includes(join(casper.dir, "plans", "hud-work-strip.md")));

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
      context: { messages: [{ role: "user", content: "probe project tool trace" }] },
      options: { sessionId: "mock-project-trace-probe" },
    }),
  });
  assert.equal(turnResponse.status, 200);
  const turnEvents = await turnResponse.text();
  assert.ok(turnEvents.includes(join(casper.dir, "plans", "step-2.md")));

} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once("exit", resolveExit);
  });
  rmSync(routeFixture, { recursive: true, force: true });
}

console.log("mock project preview route parity probe passed");
