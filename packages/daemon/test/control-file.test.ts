import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  ftruncateSync,
  linkSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readDaemonControlFile,
  readDaemonControlLine,
  writeDaemonControlFile,
} from "../src/control-file.js";
import {
  readLegacyToolCwds,
  TOOL_CWDS_MAX_BYTES,
  toolCwdsPath,
} from "../src/legacy-cwd-files.js";

describe("daemon control-file reader", () => {
  let root = "";
  let path = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ghost-control-file-"));
    path = join(root, "state.json");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("admits strict UTF-8 only through a stable mode-0600 single-link file", async () => {
    writeFileSync(path, "safe π\n", { mode: 0o600 });
    await expect(readDaemonControlFile(path, 8)).resolves.toBe("safe π\n");

    writeFileSync(path, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    await expect(readDaemonControlFile(path, 8)).rejects.toThrow("not valid UTF-8");

    writeFileSync(path, "mode", { mode: 0o600 });
    chmodSync(path, 0o640);
    await expect(readDaemonControlFile(path, 8)).rejects.toThrow("mode 0600");
    chmodSync(path, 0o600);

    const alias = join(root, "alias.json");
    linkSync(path, alias);
    await expect(readDaemonControlFile(path, 8)).rejects.toThrow("exactly one link");
  });

  it("rejects symlinks and FIFOs without following or blocking", async () => {
    const target = join(root, "target.json");
    writeFileSync(target, "outside", { mode: 0o600 });
    symlinkSync(target, path);
    await expect(readDaemonControlFile(path, 16)).rejects.toThrow();
    rmSync(path);

    execFileSync("mkfifo", [path]);
    const timeout = Symbol("timeout");
    const result = await Promise.race([
      readDaemonControlFile(path, 16).then(() => "resolved", () => "rejected"),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 500)),
    ]);
    expect(result).toBe("rejected");
  });

  it("accepts the complete exact byte cap and rejects one byte beyond it", async () => {
    writeFileSync(path, "1234", { mode: 0o600 });
    await expect(readDaemonControlFile(path, 4)).resolves.toBe("1234");
    writeFileSync(path, "12345", { mode: 0o600 });
    await expect(readDaemonControlFile(path, 4)).rejects.toThrow("4-byte limit");
  });

  it("atomically publishes a bounded mode-0600 file without creating its parent", async () => {
    await writeDaemonControlFile(path, "first\n", 6);
    await expect(readDaemonControlFile(path, 6)).resolves.toBe("first\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    await writeDaemonControlFile(path, "second\n", 7);
    await expect(readDaemonControlFile(path, 7)).resolves.toBe("second\n");
    await expect(writeDaemonControlFile(path, "too long", 7)).rejects.toThrow("7-byte limit");
    await expect(readDaemonControlFile(path, 7)).resolves.toBe("second\n");

    await expect(writeDaemonControlFile(join(root, "absent", "state.json"), "x", 1))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads bounded complete lines while permitting a huge transcript remainder", async () => {
    writeFileSync(path, "title\nheader\n", { mode: 0o600 });
    const descriptor = openSync(path, "r+");
    try {
      ftruncateSync(descriptor, 384 * 1_048_576);
    } finally {
      closeSync(descriptor);
    }
    await expect(readDaemonControlLine(path, 6)).resolves.toBe("title");
    await expect(readDaemonControlLine(path, 5)).rejects.toThrow("no first-line terminator");
  });

  it("rejects descriptor growth and final-path replacement after admission", async () => {
    writeFileSync(path, "stable\n", { mode: 0o600 });
    await expect(readDaemonControlFile(path, 32, (stage) => {
      if (stage === "read") appendFileSync(path, "growth");
    })).rejects.toThrow("changed");

    writeFileSync(path, "original\n", { mode: 0o600 });
    const displaced = join(root, "displaced.json");
    await expect(readDaemonControlFile(path, 32, (stage) => {
      if (stage !== "opened") return;
      renameSync(path, displaced);
      writeFileSync(path, "replacement\n", { mode: 0o600 });
    })).rejects.toThrow("changed");

    rmSync(displaced);
    writeFileSync(path, "prefix\nremainder", { mode: 0o600 });
    await expect(readDaemonControlLine(path, 16, (stage) => {
      if (stage === "read") appendFileSync(path, "growth");
    })).rejects.toThrow("changed");

    writeFileSync(path, "prefix\n", { mode: 0o600 });
    await expect(readDaemonControlLine(path, 16, (stage) => {
      if (stage !== "opened") return;
      renameSync(path, displaced);
      writeFileSync(path, "replacement\n", { mode: 0o600 });
    })).rejects.toThrow("changed");
  });

  it("normalizes post-open disappearance instead of reporting initial absence", async () => {
    await expect(readDaemonControlFile(path, 32)).rejects.toMatchObject({ code: "ENOENT" });
    writeFileSync(path, "present\n", { mode: 0o600 });
    let error: unknown;
    try {
      await readDaemonControlFile(path, 32, (stage) => {
        if (stage === "opened") rmSync(path);
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
    expect((error as Error).message).toContain("Daemon control file");
  });

  // A hostile sidecar must never reach a transcript. The legacy reader is only
  // ever used to adopt a pre-move home, so it yields nothing rather than
  // throwing — refusing to open the conversation over a bad sidecar would be
  // the worse failure — but it must still refuse to read the file at all.
  it("keeps hostile tool-cwd sidecars out of transcript restoration", async () => {
    const conversationId = "hostile-tool-cwds";
    const sidecar = toolCwdsPath(root, conversationId);
    const outside = join(root, "outside-tool-cwds.json");
    writeFileSync(outside, '{"version":1,"cwds":{"call":"/outside"}}\n', { mode: 0o600 });
    symlinkSync(outside, sidecar);
    await expect(readLegacyToolCwds(root, conversationId)).resolves.toEqual(new Map());
    rmSync(sidecar);

    execFileSync("mkfifo", [sidecar]);
    const timeout = Symbol("timeout");
    const fifo = await Promise.race([
      readLegacyToolCwds(root, conversationId).then((value) => value, () => "rejected"),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 500)),
    ]);
    // Anything but the timeout: a fifo must not block the read.
    expect(fifo).not.toBe(timeout);
    rmSync(sidecar);

    const descriptor = openSync(sidecar, "w", 0o600);
    try {
      ftruncateSync(descriptor, TOOL_CWDS_MAX_BYTES + 1);
    } finally {
      closeSync(descriptor);
    }
    await expect(readLegacyToolCwds(root, conversationId)).resolves.toEqual(new Map());
  });
});
