import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenStore, TOKEN_PATTERN } from "../src/token-store.js";

const store = createTokenStore({
  filename: "test-token",
  envVar: "GHOSTD_TEST_TOKEN_FILE",
  command: "test-token",
  purpose: "Test token.",
});
const execFileAsync = promisify(execFile);

describe("shared token-store persistence", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ghost-token-store-"));
    path = join(dir, "state", "test-token");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined only when the token file is missing", async () => {
    expect(store.read({ path })).toBeUndefined();
    const existingDirectory = join(dir, "not-a-file");
    await mkdir(existingDirectory);

    expect(() => store.read({ path: existingDirectory })).toThrow();
  });

  it("surfaces an unreadable token instead of silently replacing it", async () => {
    const token = "a".repeat(64);
    await mkdir(join(dir, "state"));
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    await chmod(path, 0o000);
    try {
      expect(() => store.readOrCreate({ path })).toThrow();
    } finally {
      await chmod(path, 0o600);
    }
    expect((await readFile(path, "utf8")).trim()).toBe(token);
  });

  it("returns the one winning token when processes mint concurrently", async () => {
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const script = `
      import { createTokenStore } from ${JSON.stringify(moduleUrl)};
      const store = createTokenStore({
        filename: "test-token",
        envVar: "GHOSTD_TEST_TOKEN_FILE",
        command: "test-token",
        purpose: "Test token.",
      });
      process.stdout.write(JSON.stringify(store.readOrCreate({ path: ${JSON.stringify(path)} })));
    `;

    const results = await Promise.all(Array.from({ length: 12 }, async () => {
      const { stdout } = await execFileAsync(process.execPath, ["--eval", script]);
      return JSON.parse(stdout) as { token: string; created: boolean };
    }));

    expect(new Set([...results.map((result) => result.token), store.read({ path })]).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it("reads a concurrent winner that appears between read and symlink inspection", async () => {
    await mkdir(join(dir, "state"));
    const token = "b".repeat(64);
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";

      const tokenPath = ${JSON.stringify(path)};
      const token = ${JSON.stringify(token)};
      const originalReadFileSync = fs.readFileSync;
      let intercepted = false;
      let readAttempts = 0;
      fs.readFileSync = function (candidate, options) {
        if (candidate === tokenPath) readAttempts += 1;
        if (!intercepted && candidate === tokenPath) {
          intercepted = true;
          fs.writeFileSync(tokenPath, token + "\\n", { mode: 0o600 });
          const missing = new Error("simulated stale missing read");
          missing.code = "ENOENT";
          throw missing;
        }
        return originalReadFileSync.call(this, candidate, options);
      };
      syncBuiltinESMExports();

      const { createTokenStore } = await import(${JSON.stringify(moduleUrl)});
      const store = createTokenStore({
        filename: "test-token",
        envVar: "GHOSTD_TEST_TOKEN_FILE",
        command: "test-token",
        purpose: "Test token.",
      });
      const result = store.readOrCreate({ path: tokenPath });
      process.stdout.write(JSON.stringify({
        intercepted,
        readAttempts,
        result,
      }));
    `;

    // Bun does not currently synchronize monkey-patched builtin exports, so
    // use the Node runtime already required by this workspace for this seam.
    const { stdout } = await execFileAsync("node", ["--eval", script]);
    expect(JSON.parse(stdout)).toEqual({
      intercepted: true,
      readAttempts: 2,
      result: { token, path, created: false },
    });
  });

  it("rejects a FIFO revealed after ENOENT without retrying a blocking read", async () => {
    await mkdir(join(dir, "state"));
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const script = `
      import { execFileSync } from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";

      const tokenPath = ${JSON.stringify(path)};
      const originalReadFileSync = fs.readFileSync;
      let readAttempts = 0;
      fs.readFileSync = function (candidate, options) {
        if (candidate === tokenPath) {
          readAttempts += 1;
          if (readAttempts === 1) {
            execFileSync("mkfifo", [tokenPath]);
            const missing = new Error("simulated stale missing read");
            missing.code = "ENOENT";
            throw missing;
          }
        }
        return originalReadFileSync.call(this, candidate, options);
      };
      syncBuiltinESMExports();

      const { createTokenStore } = await import(${JSON.stringify(moduleUrl)});
      const store = createTokenStore({
        filename: "test-token",
        envVar: "GHOSTD_TEST_TOKEN_FILE",
        command: "test-token",
        purpose: "Test token.",
      });
      try {
        store.readOrCreate({ path: tokenPath });
      } catch (error) {
        process.stdout.write(JSON.stringify({
          readAttempts,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    `;

    const { stdout } = await execFileAsync("node", ["--eval", script], { timeout: 1_000 });
    expect(JSON.parse(stdout)).toEqual({
      readAttempts: 1,
      message: `Token file ${path} is not a regular file.`,
    });
  });

  it("rejects a dangling token symlink without retrying forever", async () => {
    await mkdir(join(dir, "state"));
    await symlink("missing-token", path);
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const script = `
      import { createTokenStore } from ${JSON.stringify(moduleUrl)};
      const store = createTokenStore({
        filename: "test-token",
        envVar: "GHOSTD_TEST_TOKEN_FILE",
        command: "test-token",
        purpose: "Test token.",
      });
      try {
        store.readOrCreate({ path: ${JSON.stringify(path)} });
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : String(error));
        process.exit(23);
      }
    `;

    await expect(execFileAsync(process.execPath, ["--eval", script], { timeout: 1_000 }))
      .rejects.toMatchObject({
        code: 23,
        killed: false,
        stderr: expect.stringContaining("dangling symlink"),
      });
  });

  it("requires explicit rotation before replacing malformed persisted data", async () => {
    await mkdir(join(dir, "state"));
    await writeFile(path, "not-a-token\n", { mode: 0o600 });

    expect(() => store.readOrCreate({ path })).toThrow(/malformed.*rotate it explicitly/i);
    expect(await readFile(path, "utf8")).toBe("not-a-token\n");

    const rotated = store.rotate({ path });
    expect(rotated.token).toMatch(TOKEN_PATTERN);
    expect(store.read({ path })).toBe(rotated.token);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
