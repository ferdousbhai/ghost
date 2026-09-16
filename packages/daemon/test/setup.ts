import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect } from "vitest";

// Credentials are user-level, so a test that resolves them must not reach the
// developer's real ones: point pi's agent dir at a temp home for the run.
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousStateHome = process.env.XDG_STATE_HOME;
const previousTestStateHome = process.env.GHOST_TEST_XDG_STATE_HOME;
const stateHome = mkdtempSync(join(tmpdir(), "ghostd-vitest-state-"));

const agentDir = mkdtempSync(join(tmpdir(), "ghostd-vitest-agent-"));

process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.XDG_STATE_HOME = stateHome;
process.env.GHOST_TEST_XDG_STATE_HOME = stateHome;

afterEach(() => {
  expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
  expect(process.env.XDG_STATE_HOME).toBe(stateHome);
  expect(process.env.GHOST_TEST_XDG_STATE_HOME).toBe(stateHome);
});

afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  if (previousTestStateHome === undefined) delete process.env.GHOST_TEST_XDG_STATE_HOME;
  else process.env.GHOST_TEST_XDG_STATE_HOME = previousTestStateHome;
  rmSync(stateHome, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});
