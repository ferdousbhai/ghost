import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect } from "vitest";
import {
  MemorySecretServiceClient,
  setSecretServiceClientFactoryForTests,
} from "../src/secret-service.js";

const previousStateHome = process.env.XDG_STATE_HOME;
const previousTestStateHome = process.env.GHOST_TEST_XDG_STATE_HOME;
const previousJournalStream = process.env.JOURNAL_STREAM;
const previousInvocationId = process.env.INVOCATION_ID;
const stateHome = mkdtempSync(join(tmpdir(), "ghostd-vitest-state-"));

process.env.XDG_STATE_HOME = stateHome;
process.env.GHOST_TEST_XDG_STATE_HOME = stateHome;
delete process.env.JOURNAL_STREAM;
delete process.env.INVOCATION_ID;

export const testSecretService = new MemorySecretServiceClient();
setSecretServiceClientFactoryForTests(() => testSecretService);

beforeEach(() => {
  testSecretService.reset();
  const metadata = join(stateHome, "ghost", "keyring-metadata.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${metadata}${suffix}`, { force: true });
  }
});

afterEach(() => {
  expect(process.env.XDG_STATE_HOME).toBe(stateHome);
  expect(process.env.GHOST_TEST_XDG_STATE_HOME).toBe(stateHome);
});

afterAll(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  if (previousTestStateHome === undefined) delete process.env.GHOST_TEST_XDG_STATE_HOME;
  else process.env.GHOST_TEST_XDG_STATE_HOME = previousTestStateHome;
  if (previousJournalStream === undefined) delete process.env.JOURNAL_STREAM;
  else process.env.JOURNAL_STREAM = previousJournalStream;
  if (previousInvocationId === undefined) delete process.env.INVOCATION_ID;
  else process.env.INVOCATION_ID = previousInvocationId;
  rmSync(stateHome, { recursive: true, force: true });
});
