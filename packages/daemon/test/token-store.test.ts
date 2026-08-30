import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
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
    await mkdir(join(dir, "state"), { mode: 0o700 });
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    await chmod(path, 0o000);
    try {
      expect(() => store.readOrCreate({ path })).toThrow();
    } finally {
      await chmod(path, 0o600);
    }
    expect((await readFile(path, "utf8")).trim()).toBe(token);
  });

  it("requires an existing token directory to remain mode 0700", async () => {
    const state = join(dir, "state");
    await mkdir(state, { mode: 0o700 });
    await chmod(state, 0o755);

    expect(() => store.readOrCreate({ path })).toThrow(/mode 0700/);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects linked, permissive, and non-regular token entries without blocking", async () => {
    const state = join(dir, "state");
    const token = "c".repeat(64);
    await mkdir(state, { mode: 0o700 });
    await writeFile(path, `${token}\n`, { mode: 0o600 });

    await chmod(path, 0o644);
    expect(() => store.read({ path })).toThrow(/mode 0600/);
    await chmod(path, 0o600);

    const alias = join(state, "token-alias");
    await link(path, alias);
    expect(() => store.read({ path })).toThrow(/single-link/);
    await unlink(alias);

    const target = join(state, "token-target");
    await writeFile(target, `${token}\n`, { mode: 0o600 });
    await unlink(path);
    await symlink(target, path);
    expect(() => store.read({ path })).toThrow(/symbolic link/);
    await unlink(path);

    await execFileAsync("mkfifo", [path]);
    const started = Date.now();
    expect(() => store.read({ path })).toThrow(/single-link regular file/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("accepts only the exact 64-hex-plus-newline token encoding", async () => {
    await mkdir(join(dir, "state"), { mode: 0o700 });
    const token = "d".repeat(64);
    await writeFile(path, token, { mode: 0o600 });
    expect(() => store.read({ path })).toThrow(/malformed/);
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    expect(store.read({ path })).toBe(token);
  });

  it("rejects high-bit bytes instead of decoding them as ASCII hex", async () => {
    await mkdir(join(dir, "state"), { mode: 0o700 });
    await writeFile(path, Buffer.concat([Buffer.alloc(64, 0xe1), Buffer.from("\n")]), {
      mode: 0o600,
    });

    expect(() => store.read({ path })).toThrow(/malformed/);
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

  it("settles restrictive-umask publication without invalidating a complete read", async () => {
    await mkdir(join(dir, "state"), { mode: 0o700 });
    const published = join(dir, "winner-published");
    const permissionObserved = join(dir, "loser-observed-permission");
    const modeFixed = join(dir, "winner-mode-fixed");
    const ready = join(dir, "winner-ready");
    const admitted = join(dir, "loser-admitted");
    const settled = join(dir, "winner-settled");
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const storeSource = `
      const { createTokenStore } = await import(${JSON.stringify(moduleUrl)});
      const store = createTokenStore({
        filename: "test-token",
        envVar: "GHOSTD_TEST_TOKEN_FILE",
        command: "test-token",
        purpose: "Test token.",
      });
    `;
    const winnerScript = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";

      const tokenPath = ${JSON.stringify(path)};
      const publishedPath = ${JSON.stringify(published)};
      const permissionObservedPath = ${JSON.stringify(permissionObserved)};
      const modeFixedPath = ${JSON.stringify(modeFixed)};
      const readyPath = ${JSON.stringify(ready)};
      const admittedPath = ${JSON.stringify(admitted)};
      const settledPath = ${JSON.stringify(settled)};
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      const originalChmodSync = fs.chmodSync;
      const originalFchmodSync = fs.fchmodSync;
      const originalFstatSync = fs.fstatSync;
      const originalFsyncSync = fs.fsyncSync;
      const originalWriteFileSync = fs.writeFileSync;
      const originalWriteSync = fs.writeSync;
      let permissionCoordinated = false;
      let coordinated = false;
      function waitFor(candidate) {
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(candidate)) {
          if (Date.now() >= deadline) throw new Error("timed out waiting for " + candidate);
          Atomics.wait(sleep, 0, 0, 2);
        }
      }
      function afterCompleteWrite() {
        if (coordinated) return;
        coordinated = true;
        originalWriteFileSync(readyPath, "", { flag: "wx" });
        waitFor(admittedPath);
      }
      fs.fchmodSync = function (descriptor, mode) {
        if (!permissionCoordinated) {
          permissionCoordinated = true;
          originalWriteFileSync(publishedPath, "", { flag: "wx" });
          waitFor(permissionObservedPath);
        }
        const result = originalFchmodSync.call(this, descriptor, mode);
        originalWriteFileSync(modeFixedPath, "", { flag: "wx" });
        return result;
      };
      fs.writeFileSync = function (candidate, data, options) {
        const result = originalWriteFileSync.call(this, candidate, data, options);
        if (candidate === tokenPath) afterCompleteWrite();
        return result;
      };
      fs.writeSync = function (descriptor, ...args) {
        const written = originalWriteSync.call(this, descriptor, ...args);
        if (!coordinated && originalFstatSync(descriptor).size === 65) afterCompleteWrite();
        return written;
      };
      fs.chmodSync = function (candidate, mode) {
        const result = originalChmodSync.call(this, candidate, mode);
        if (coordinated && candidate === tokenPath) {
          originalWriteFileSync(settledPath, "", { flag: "wx" });
        }
        return result;
      };
      fs.fsyncSync = function (descriptor) {
        const result = originalFsyncSync.call(this, descriptor);
        if (coordinated) originalWriteFileSync(settledPath, "", { flag: "wx" });
        return result;
      };
      syncBuiltinESMExports();
      process.umask(0o777);
      ${storeSource}
      const result = store.readOrCreate({ path: tokenPath });
      process.stdout.write(JSON.stringify(result));
    `;
    const loserScript = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";

      const tokenPath = ${JSON.stringify(path)};
      const permissionObservedPath = ${JSON.stringify(permissionObserved)};
      const modeFixedPath = ${JSON.stringify(modeFixed)};
      const admittedPath = ${JSON.stringify(admitted)};
      const settledPath = ${JSON.stringify(settled)};
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      const originalFstatSync = fs.fstatSync;
      const originalLstatSync = fs.lstatSync;
      const originalWriteFileSync = fs.writeFileSync;
      let permissionObserved = false;
      let admitted = false;
      function waitFor(candidate) {
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(candidate)) {
          if (Date.now() >= deadline) throw new Error("timed out waiting for " + candidate);
          Atomics.wait(sleep, 0, 0, 2);
        }
      }
      fs.lstatSync = function (candidate, options) {
        const state = originalLstatSync.call(this, candidate, options);
        if (!permissionObserved && candidate === tokenPath && state.size === 0n) {
          permissionObserved = true;
          originalWriteFileSync(permissionObservedPath, "", { flag: "wx" });
          waitFor(modeFixedPath);
        }
        return state;
      };
      fs.fstatSync = function (descriptor, options) {
        const state = originalFstatSync.call(this, descriptor, options);
        if (!admitted && state.size === 65n) {
          admitted = true;
          originalWriteFileSync(admittedPath, "", { flag: "wx" });
          waitFor(settledPath);
        }
        return state;
      };
      syncBuiltinESMExports();
      ${storeSource}
      const result = store.readOrCreate({ path: tokenPath });
      process.stdout.write(JSON.stringify(result));
    `;

    const winner = execFileAsync("node", ["--eval", winnerScript], { timeout: 8_000 });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        await stat(published);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (attempt === 499) throw new Error("token winner did not publish its exclusive inode");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    const loser = execFileAsync("node", ["--eval", loserScript], { timeout: 8_000 });
    const [winningOutput, losingOutput] = await Promise.all([winner, loser]);
    const winningResult = JSON.parse(winningOutput.stdout) as { token: string; created: boolean };
    const losingResult = JSON.parse(losingOutput.stdout) as { token: string; created: boolean };
    expect(winningResult).toMatchObject({ created: true });
    expect(losingResult).toEqual({ ...winningResult, created: false });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }, 10_000);

  it("waits for an exclusive winner to finish its complete token write", async () => {
    await mkdir(join(dir, "state"), { mode: 0o700 });
    const token = "e".repeat(64);
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";

      const tokenPath = ${JSON.stringify(path)};
      const token = ${JSON.stringify(token)};
      fs.writeFileSync(tokenPath, "", { flag: "wx", mode: 0o600 });
      const originalFstatSync = fs.fstatSync;
      let completed = false;
      fs.fstatSync = function (descriptor, options) {
        const admitted = originalFstatSync.call(this, descriptor, options);
        if (!completed && admitted.size === 0n) {
          completed = true;
          fs.writeFileSync(tokenPath, token + "\\n", { mode: 0o600 });
        }
        return admitted;
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
      process.stdout.write(JSON.stringify({ completed, result }));
    `;

    const { stdout } = await execFileAsync("node", ["--eval", script]);
    expect(JSON.parse(stdout)).toEqual({
      completed: true,
      result: { token, path, created: false },
    });
  });

  it("reads a concurrent winner that appears between read and symlink inspection", async () => {
    await mkdir(join(dir, "state"), { mode: 0o700 });
    const token = "b".repeat(64);
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";

      const tokenPath = ${JSON.stringify(path)};
      const token = ${JSON.stringify(token)};
      const originalOpenSync = fs.openSync;
      let intercepted = false;
      let readAttempts = 0;
      fs.openSync = function (candidate, flags, mode) {
        if (candidate === tokenPath) readAttempts += 1;
        if (!intercepted && candidate === tokenPath) {
          intercepted = true;
          const winner = originalOpenSync(tokenPath, "wx", 0o600);
          fs.writeSync(winner, token + "\\n");
          fs.closeSync(winner);
          const missing = new Error("simulated stale missing read");
          missing.code = "ENOENT";
          throw missing;
        }
        return originalOpenSync.call(this, candidate, flags, mode);
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
    await mkdir(join(dir, "state"), { mode: 0o700 });
    const moduleUrl = new URL("../src/token-store.ts", import.meta.url).href;
    const script = `
      import { execFileSync } from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";

      const tokenPath = ${JSON.stringify(path)};
      const originalOpenSync = fs.openSync;
      let readAttempts = 0;
      fs.openSync = function (candidate, flags, mode) {
        if (candidate === tokenPath) {
          readAttempts += 1;
          if (readAttempts === 1) {
            execFileSync("mkfifo", [tokenPath]);
            const missing = new Error("simulated stale missing read");
            missing.code = "ENOENT";
            throw missing;
          }
        }
        return originalOpenSync.call(this, candidate, flags, mode);
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
    await mkdir(join(dir, "state"), { mode: 0o700 });
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
        stderr: expect.stringContaining("symbolic link"),
      });
  });

  it("requires explicit rotation before replacing malformed persisted data", async () => {
    await mkdir(join(dir, "state"), { mode: 0o700 });
    await writeFile(path, "not-a-token\n", { mode: 0o600 });

    expect(() => store.readOrCreate({ path })).toThrow(/malformed.*rotate it explicitly/i);
    expect(await readFile(path, "utf8")).toBe("not-a-token\n");

    const rotated = store.rotate({ path });
    expect(rotated.token).toMatch(TOKEN_PATTERN);
    expect(store.read({ path })).toBe(rotated.token);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
