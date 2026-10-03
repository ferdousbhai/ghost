import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect } from "vitest";

const previousStateHome = process.env.XDG_STATE_HOME;
const previousTestStateHome = process.env.GHOST_TEST_XDG_STATE_HOME;
const stateHome = mkdtempSync(join(tmpdir(), "ghostd-vitest-state-"));

// The desktop tools' server is a fake: no test may reach the owner's desktop.
process.env.GHOST_DESKTOP = fileURLToPath(new URL("./helpers/fake-desktop.ts", import.meta.url));
process.env.XDG_STATE_HOME = stateHome;
process.env.GHOST_TEST_XDG_STATE_HOME = stateHome;

afterEach(() => {
  expect(process.env.XDG_STATE_HOME).toBe(stateHome);
  expect(process.env.GHOST_TEST_XDG_STATE_HOME).toBe(stateHome);
});

afterAll(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  if (previousTestStateHome === undefined) delete process.env.GHOST_TEST_XDG_STATE_HOME;
  else process.env.GHOST_TEST_XDG_STATE_HOME = previousTestStateHome;
  rmSync(stateHome, { recursive: true, force: true });
});
