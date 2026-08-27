import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhostError } from "../src/errors.js";
import {
  importGhostArchive,
  MAX_IMPORT_COMPRESSED_BYTES,
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_FILES,
  MAX_IMPORT_UNCOMPRESSED_BYTES,
  setImportFaultInjectorForTest,
  type ImportFaultPoint,
} from "../src/import.js";
import { deriveMemoryIndex } from "../src/memory-file.js";
import { createTempDir, writeFileTree } from "./support/fixture.js";

/**
 * A hand-built ghost-home/v1 archive in the exact shape the hosted exporter
 * wrote. Import is the only boundary that still admits it.
 */
const ROOT = "casper";
const execFileAsync = promisify(execFile);
const ARCHIVE: Record<string, string> = {
  [`${ROOT}/character.md`]: "# Casper\n\nA printer.",
  [`${ROOT}/notes/craft/paper-notes.md`]:
    "---\ntitle: Paper notes\ntags: [paper]\n---\n\nDamp the sheet.",
  [`${ROOT}/notes/estate-finances.md`]:
    "---\ntitle: Estate and finances\npath: Estate & finances\n---\n\nThe lease.",
  [`${ROOT}/memory/working-habit.md`]:
    "---\ndescription: I work in the morning\nupdated: 2026-08-02\n---\n\nThe press is cold until ten.\n",
  [`${ROOT}/conversations/conv-1.json`]:
    '{\n  "id": "conv-1",\n  "ownerId": "owner-1",\n  "catalog": null,\n  "messages": []\n}\n',
  [`${ROOT}/export-manifest.json`]: `${JSON.stringify({
    format: "ghost-home/v1",
    exportedAt: "2026-08-20T12:00:00.000Z",
    ghostname: "casper",
    appVersion: "test",
    source: "browser-local-replica",
    counts: {
      characterNotes: 1,
      notes: 2,
      archivedNotes: 0,
      memoryFiles: 1,
      conversations: 1,
    },
    derived: [],
    pathRewrites: { "casper/notes/estate-finances.md": "notes/Estate & finances.md" },
    notIncluded: [],
  }, null, 2)}\n`,
};

function zipArchive(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[path] = strToU8(text);
  return zipSync(entries);
}

function declareZipEntrySize(
  bytes: Uint8Array,
  path: string,
  size: number,
): Uint8Array {
  const patched = bytes.slice();
  const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 0; offset <= patched.byteLength - 46;) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(patched.subarray(offset + 46, offset + 46 + nameLength));
    if (name === path) view.setUint32(offset + 24, size, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return patched;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function childResult(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, "exit");
  return {
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    stderr,
  };
}

let workspace: { dir: string; cleanup(): Promise<void> };
let zipPath: string;

beforeEach(async () => {
  workspace = await createTempDir();
  zipPath = join(workspace.dir, "casper-ghost-home.zip");
  await writeFile(zipPath, zipArchive(ARCHIVE));
});

afterEach(async () => {
  setImportFaultInjectorForTest(null);
  await workspace.cleanup();
});

describe("importGhostArchive", () => {
  it("lands a zip as a readable ghost home", async () => {
    const ghostsRoot = join(workspace.dir, "ghosts");
    const result = await importGhostArchive(zipPath, ghostsRoot);

    expect(result.ghostName).toBe("casper");
    expect(result.dir).toBe(join(ghostsRoot, "casper"));
    expect(result.manifest.format).toBe("ghost-home/v2");
    expect(result.filesWritten).toBe(Object.keys(ARCHIVE).length);

    const home = result.home;
    expect((await home.readCharacter())?.title).toBe("Casper");

    const { docs } = await home.listDocs();
    expect(docs.map((doc) => doc.path))
      .toEqual(["craft/paper-notes.md", "estate-finances.md"]);
    expect(docs.find((doc) => doc.path === "estate-finances.md"))
      .toMatchObject({ title: "Estate and finances", tags: [], archived: false });

    const memory = await home.listMemory();
    expect(deriveMemoryIndex(memory.files).lines)
      .toEqual(["- working-habit.md: I work in the morning"]);

    expect(await home.listConversations()).toEqual(["conv-1"]);
    expect(await home.readExportManifest())
      .toMatchObject({ format: "ghost-home/v2", ghostname: "casper" });
    expect((await readdir(ghostsRoot)).some((name) => name.startsWith(".ghost-import-")))
      .toBe(false);
  });

  it("migrates v1 docs and manifest while preserving unrelated archive bytes", async () => {
    const ghostsRoot = join(workspace.dir, "ghosts");
    const { dir } = await importGhostArchive(zipPath, ghostsRoot);
    expect(await readFile(join(dir, "docs/craft/paper-notes.md"), "utf8"))
      .toBe("# Paper notes\n\nDamp the sheet.\n\n#paper\n");
    expect(await readFile(join(dir, "docs/estate-finances.md"), "utf8"))
      .toBe("# Estate and finances\n\nThe lease.\n");
    expect(JSON.parse(await readFile(join(dir, "export-manifest.json"), "utf8")))
      .toMatchObject({ format: "ghost-home/v2", ghostname: "casper" });
    expect(await readFile(join(dir, "memory/working-habit.md"), "utf8"))
      .toBe(ARCHIVE[`${ROOT}/memory/working-habit.md`]);
    expect(await readFile(join(dir, "conversations/conv-1.json"), "utf8"))
      .toBe(ARCHIVE[`${ROOT}/conversations/conv-1.json`]);
  });

  it("rejects an archive where legacy notes and canonical docs collide", async () => {
    const collision = join(workspace.dir, "collision.zip");
    await writeFile(collision, zipArchive({
      ...ARCHIVE,
      [`${ROOT}/docs/estate-finances.md`]: "different bytes",
    }));
    await expect(importGhostArchive(collision, join(workspace.dir, "ghosts")))
      .rejects.toMatchObject({ code: "invalid_format" });
  });

  it("imports an already-extracted directory the same way", async () => {
    const extracted = join(workspace.dir, "extracted");
    await writeFileTree(extracted, ARCHIVE);
    const fromRoot = await importGhostArchive(
      extracted,
      join(workspace.dir, "GhostsA"),
    );
    expect(fromRoot.filesWritten).toBe(Object.keys(ARCHIVE).length);

    // …and when the directory handed over *is* the archive root.
    const fromInside = await importGhostArchive(
      join(extracted, ROOT),
      join(workspace.dir, "GhostsB"),
    );
    expect(fromInside.ghostName).toBe("casper");
    expect((await fromInside.home.readCharacter())?.title).toBe("Casper");
  });

  it("honours an explicit ghost name", async () => {
    const result = await importGhostArchive(zipPath, join(workspace.dir, "ghosts"), {
      name: "casper-2",
    });
    expect(result.home.name).toBe("casper-2");
  });

  it("refuses to import into a non-empty ghost home unless told to", async () => {
    const ghostsRoot = join(workspace.dir, "ghosts");
    const original = await importGhostArchive(zipPath, ghostsRoot);
    await writeFile(join(original.dir, "old-only.txt"), "must disappear", "utf8");
    await expect(importGhostArchive(zipPath, ghostsRoot))
      .rejects.toMatchObject({ code: "conflict" });
    const replacement = await importGhostArchive(zipPath, ghostsRoot, { overwrite: true });
    expect(replacement).toMatchObject({ ghostName: "casper" });
    expect(replacement.replaced).toBeDefined();
    expect(await readFile(join(replacement.replaced as string, "old-only.txt"), "utf8"))
      .toBe("must disappear");
    await expect(readFile(join(original.dir, "old-only.txt"), "utf8")).rejects.toThrow();
    expect((await readdir(ghostsRoot)).some((name) => name.startsWith(".ghost-import-")))
      .toBe(false);
  });

  it("leaves the existing home untouched when staged validation fails", async () => {
    const ghostsRoot = join(workspace.dir, "ghosts");
    const original = await importGhostArchive(zipPath, ghostsRoot);
    await writeFile(join(original.dir, "sentinel.txt"), "original", "utf8");
    const invalid = join(workspace.dir, "invalid-staging.zip");
    await writeFile(invalid, zipArchive({
      [`${ROOT}/export-manifest.json`]:
        '{"format":"ghost-home/v2","ghostname":"casper"}',
      [`${ROOT}/docs`]: "blocks the docs directory",
      [`${ROOT}/docs/new.md`]: "# New\n",
    }));

    await expect(importGhostArchive(invalid, ghostsRoot, { overwrite: true }))
      .rejects.toThrow();
    expect(await readFile(join(original.dir, "sentinel.txt"), "utf8")).toBe("original");
    expect((await readdir(ghostsRoot)).filter((name) =>
      name.startsWith(".casper.import-") || name.includes(".import-backup-")
    )).toEqual([]);
  });

  it("documents that overwrite cannot quiesce a live home descriptor", async () => {
    const ghostsRoot = join(workspace.dir, "LiveGhosts");
    const original = await importGhostArchive(zipPath, ghostsRoot);
    const marker = join(workspace.dir, "live-home-lock");
    const helperUrl = new URL("../src/linux-fs.ts", import.meta.url).href;
    const child = spawn(process.execPath, [
      "-e",
      `
        const { openConfinedDirectory, withDescriptorLock } = await import(
          ${JSON.stringify(helperUrl)}
        );
        const directory = await openConfinedDirectory(
          ${JSON.stringify(original.dir)},
          ${JSON.stringify(join(original.dir, "memory"))},
          { label: "Memory path" },
        );
        await withDescriptorLock(directory, async () => {
          await Bun.write(${JSON.stringify(marker)}, "locked");
          await Bun.sleep(1500);
        });
        await directory.close();
      `,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const result = childResult(child);
    await waitForPath(marker);

    const replacement = await importGhostArchive(zipPath, ghostsRoot, {
      overwrite: true,
    });
    expect(replacement.replaced).toBeDefined();
    expect(child.exitCode).toBeNull();
    expect(await result).toEqual({ code: 0, signal: null, stderr: "" });
  });

  it("admits current v2 archives without rewriting canonical docs", async () => {
    const current = join(workspace.dir, "current.zip");
    const canonical = "# Current\n\nExact bytes.  \n\n#current\n";
    await writeFile(current, zipArchive({
      [`${ROOT}/docs/current.md`]: canonical,
      [`${ROOT}/export-manifest.json`]:
        '{"format":"ghost-home/v2","ghostname":"casper"}\n',
    }));
    const result = await importGhostArchive(current, join(workspace.dir, "CurrentGhosts"));
    expect(result.manifest.format).toBe("ghost-home/v2");
    expect(await readFile(join(result.dir, "docs/current.md"), "utf8")).toBe(canonical);
  });

  it("rejects an archive outside the current and migratable formats", async () => {
    const wrong = join(workspace.dir, "wrong.zip");
    await writeFile(wrong, zipArchive({
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v3"}',
    }));
    await expect(importGhostArchive(wrong, join(workspace.dir, "ghosts")))
      .rejects.toMatchObject({ code: "invalid_format" });
  });

  it("rejects an archive with no manifest", async () => {
    const bare = join(workspace.dir, "bare.zip");
    await writeFile(bare, zipArchive({ [`${ROOT}/character.md`]: "hello" }));
    await expect(importGhostArchive(bare, join(workspace.dir, "ghosts")))
      .rejects.toThrow(GhostError);
  });

  it("refuses an entry that escapes the ghost home", async () => {
    const evil = join(workspace.dir, "evil.zip");
    await writeFile(evil, zipArchive({
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v1","ghostname":"casper"}',
      [`${ROOT}/../../pwned.md`]: "no",
    }));
    await expect(importGhostArchive(evil, join(workspace.dir, "ghosts")))
      .rejects.toMatchObject({ code: "invalid_path" });
  });

  it("ignores macOS zip cruft", async () => {
    const noisy = join(workspace.dir, "noisy.zip");
    await writeFile(noisy, zipArchive({
      ...ARCHIVE,
      "__MACOSX/._casper": "",
      [`${ROOT}/.DS_Store`]: "",
    }));
    const result = await importGhostArchive(noisy, join(workspace.dir, "ghosts"));
    expect(result.ignored).toContain("__MACOSX/._casper");
    expect(result.filesWritten).toBe(Object.keys(ARCHIVE).length);
  });

  it("reports a missing source", async () => {
    await expect(importGhostArchive(join(workspace.dir, "nope.zip"), workspace.dir))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects symbolic-link archive sources and nested directory entries", async () => {
    const linkedArchive = join(workspace.dir, "linked.zip");
    await symlink(zipPath, linkedArchive);
    await expect(importGhostArchive(linkedArchive, join(workspace.dir, "LinkedZip")))
      .rejects.toMatchObject({ code: "invalid_path" });

    const extracted = join(workspace.dir, "linked-directory");
    await writeFileTree(extracted, {
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
    });
    const outside = join(workspace.dir, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(extracted, ROOT, "linked.txt"));
    await expect(importGhostArchive(extracted, join(workspace.dir, "LinkedDirectory")))
      .rejects.toMatchObject({ code: "invalid_path" });
  });

  it("rejects FIFO sources and extracted entries without blocking", async () => {
    const fifoSource = join(workspace.dir, "source.fifo");
    await execFileAsync("mkfifo", [fifoSource]);
    const started = Date.now();
    await expect(importGhostArchive(fifoSource, join(workspace.dir, "FifoSource")))
      .rejects.toMatchObject({ code: "invalid_format" });

    const extracted = join(workspace.dir, "fifo-directory");
    await writeFileTree(extracted, {
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
    });
    await execFileAsync("mkfifo", [join(extracted, ROOT, "blocking.bin")]);
    await expect(importGhostArchive(extracted, join(workspace.dir, "FifoDirectory")))
      .rejects.toMatchObject({ code: "invalid_path" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("caps zip and extracted-directory traversal depth", async () => {
    const deepEntry = `${ROOT}/${Array.from(
      { length: MAX_IMPORT_DEPTH + 1 },
      (_, index) => `level-${index}`,
    ).join("/")}/too-deep.txt`;
    const deepZip = join(workspace.dir, "deep.zip");
    await writeFile(deepZip, zipArchive({
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
      [deepEntry]: "deep",
    }));
    await expect(importGhostArchive(deepZip, join(workspace.dir, "DeepZip")))
      .rejects.toMatchObject({ code: "limit_exceeded" });

    const deepDirectory = join(workspace.dir, "deep-directory");
    await writeFileTree(deepDirectory, {
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
      [deepEntry]: "deep",
    });
    await expect(importGhostArchive(deepDirectory, join(workspace.dir, "DeepDirectory")))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("rejects a zip over the compressed byte limit before reading it", async () => {
    const oversized = join(workspace.dir, "oversized.zip");
    await writeFile(oversized, new Uint8Array());
    await truncate(oversized, MAX_IMPORT_COMPRESSED_BYTES + 1);
    await expect(importGhostArchive(oversized, join(workspace.dir, "ghosts")))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("preflights per-file and total expanded sizes before inflating", async () => {
    const tooLargePath = `${ROOT}/too-large.bin`;
    let perFile = zipArchive({
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
      [tooLargePath]: "tiny",
    });
    perFile = declareZipEntrySize(perFile, tooLargePath, MAX_IMPORT_FILE_BYTES + 1);
    const perFilePath = join(workspace.dir, "per-file.zip");
    await writeFile(perFilePath, perFile);
    await expect(importGhostArchive(perFilePath, join(workspace.dir, "PerFile")))
      .rejects.toMatchObject({ code: "limit_exceeded" });

    const totalFiles: Record<string, string> = {
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
    };
    for (let index = 0; index < 5; index += 1) {
      totalFiles[`${ROOT}/part-${index}.bin`] = "tiny";
    }
    let total = zipArchive(totalFiles);
    const declaredSize = Math.floor(MAX_IMPORT_UNCOMPRESSED_BYTES / 5) + 1;
    for (let index = 0; index < 5; index += 1) {
      total = declareZipEntrySize(total, `${ROOT}/part-${index}.bin`, declaredSize);
    }
    const totalPath = join(workspace.dir, "total.zip");
    await writeFile(totalPath, total);
    await expect(importGhostArchive(totalPath, join(workspace.dir, "Total")))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("caps the number of archive files", async () => {
    const files: Record<string, string> = {
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
    };
    for (let index = 0; index < MAX_IMPORT_FILES; index += 1) {
      files[`${ROOT}/empty-${index}.txt`] = "";
    }
    const crowded = join(workspace.dir, "crowded.zip");
    await writeFile(crowded, zipArchive(files));
    await expect(importGhostArchive(crowded, join(workspace.dir, "Crowded")))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("counts explicit archive directories toward the entry limit", async () => {
    const entries: Record<string, string> = {
      [`${ROOT}/export-manifest.json`]: '{"format":"ghost-home/v2"}',
    };
    for (let index = 0; index < MAX_IMPORT_ENTRIES; index += 1) {
      entries[`${ROOT}/directory-${index}/`] = "";
    }
    const crowded = join(workspace.dir, "crowded-directories.zip");
    await writeFile(crowded, zipArchive(entries));
    await expect(importGhostArchive(crowded, join(workspace.dir, "CrowdedDirectories")))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("restores a recoverable backup from a stale interrupted transaction", async () => {
    const ghostsRoot = join(workspace.dir, "RecoveryGhosts");
    const target = join(ghostsRoot, "casper");
    const trash = join(ghostsRoot, ".trash");
    const backup = join(trash, "casper-import-overwrite-interrupted");
    const transaction = join(
      ghostsRoot,
      ".ghost-import-4242-00000000-0000-4000-8000-000000000000",
    );
    await writeFileTree(target, { "sentinel.txt": "original" });
    await mkdir(trash, { recursive: true });
    await rename(target, backup);
    await mkdir(join(transaction, "home"), { recursive: true });
    const previousStats = await stat(backup);
    const stagingStats = await stat(join(transaction, "home"));
    await writeFile(join(transaction, "transaction.json"), `${JSON.stringify({
      version: 1,
      phase: "prepared",
      target,
      staging: join(transaction, "home"),
      backup,
      previousIdentity: { dev: previousStats.dev, ino: previousStats.ino },
      stagingIdentity: { dev: stagingStats.dev, ino: stagingStats.ino },
    })}\n`);

    await importGhostArchive(zipPath, ghostsRoot, { name: "new-ghost" });
    expect(await readFile(join(target, "sentinel.txt"), "utf8")).toBe("original");
    await expect(stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a transaction when setup fails immediately after opening it", async () => {
    const ghostsRoot = join(workspace.dir, "SetupFailureGhosts");
    setImportFaultInjectorForTest((point) => {
      if (point === "after_transaction_open") throw new Error("injected setup failure");
    });
    await expect(importGhostArchive(zipPath, ghostsRoot))
      .rejects.toThrow("injected setup failure");
    expect((await readdir(ghostsRoot)).filter((name) => name.startsWith(".ghost-import-")))
      .toEqual([]);
  });

  it.each([
    "after_prepared",
    "after_backup_rename",
    "after_target_rename",
    "after_published",
  ] satisfies ImportFaultPoint[])(
    "restores the original home after an injected %s failure",
    async (failurePoint) => {
      const ghostsRoot = join(workspace.dir, `Failure-${failurePoint}`);
      const original = await importGhostArchive(zipPath, ghostsRoot);
      await writeFile(join(original.dir, "sentinel.txt"), "original");
      setImportFaultInjectorForTest((point) => {
        if (point === failurePoint) throw new Error(`injected ${failurePoint}`);
      });

      await expect(importGhostArchive(zipPath, ghostsRoot, { overwrite: true }))
        .rejects.toThrow(`injected ${failurePoint}`);
      expect(await readFile(join(original.dir, "sentinel.txt"), "utf8")).toBe("original");
      expect((await readdir(ghostsRoot)).filter((name) => name.startsWith(".ghost-import-")))
        .toEqual([]);
    },
  );

  it("rolls back a SIGKILL after target rename from the prepared phase", async () => {
    const ghostsRoot = join(workspace.dir, "KilledPreparedGhosts");
    const original = await importGhostArchive(zipPath, ghostsRoot);
    await writeFile(join(original.dir, "sentinel.txt"), "original");
    const marker = join(workspace.dir, "killed-prepared");
    const moduleUrl = new URL("../src/import.ts", import.meta.url).href;
    const child = spawn(process.execPath, [
      "-e",
      `
        const { importGhostArchive, setImportFaultInjectorForTest } = await import(
          ${JSON.stringify(moduleUrl)}
        );
        setImportFaultInjectorForTest(async (point) => {
          if (point !== "after_target_rename") return;
          await Bun.write(${JSON.stringify(marker)}, "killed");
          process.kill(process.pid, "SIGKILL");
        });
        await importGhostArchive(
          ${JSON.stringify(zipPath)},
          ${JSON.stringify(ghostsRoot)},
          { overwrite: true },
        );
      `,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const killed = childResult(child);
    await waitForPath(marker);
    expect(await killed).toMatchObject({ code: null, signal: "SIGKILL" });
    const transactionName = (await readdir(ghostsRoot)).find((name) =>
      name.startsWith(".ghost-import-")
    );
    expect(transactionName).toBeDefined();
    expect(JSON.parse(await readFile(
      join(ghostsRoot, transactionName as string, "transaction.json"),
      "utf8",
    ))).toMatchObject({ phase: "prepared" });

    await importGhostArchive(zipPath, ghostsRoot, { name: "recovery-trigger" });
    expect(await readFile(join(original.dir, "sentinel.txt"), "utf8")).toBe("original");
    expect((await readdir(ghostsRoot)).filter((name) => name.startsWith(".ghost-import-")))
      .toEqual([]);
  });

  it("keeps the published home after a SIGKILL in the committed phase", async () => {
    const ghostsRoot = join(workspace.dir, "KilledCommittedGhosts");
    const original = await importGhostArchive(zipPath, ghostsRoot);
    await writeFile(join(original.dir, "sentinel.txt"), "original");
    const replacementArchive = join(workspace.dir, "committed-replacement.zip");
    await writeFile(replacementArchive, zipArchive({
      [`${ROOT}/character.md`]: "# Committed replacement\n",
      [`${ROOT}/export-manifest.json`]:
        '{"format":"ghost-home/v2","ghostname":"casper"}',
    }));
    const marker = join(workspace.dir, "killed-committed");
    const moduleUrl = new URL("../src/import.ts", import.meta.url).href;
    const child = spawn(process.execPath, [
      "-e",
      `
        const { importGhostArchive, setImportFaultInjectorForTest } = await import(
          ${JSON.stringify(moduleUrl)}
        );
        setImportFaultInjectorForTest(async (point) => {
          if (point !== "after_committed") return;
          await Bun.write(${JSON.stringify(marker)}, "killed");
          process.kill(process.pid, "SIGKILL");
        });
        await importGhostArchive(
          ${JSON.stringify(replacementArchive)},
          ${JSON.stringify(ghostsRoot)},
          { overwrite: true },
        );
      `,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const killed = childResult(child);
    await waitForPath(marker);
    expect(await killed).toMatchObject({ code: null, signal: "SIGKILL" });
    const transactionName = (await readdir(ghostsRoot)).find((name) =>
      name.startsWith(".ghost-import-")
    );
    expect(transactionName).toBeDefined();
    expect(JSON.parse(await readFile(
      join(ghostsRoot, transactionName as string, "transaction.json"),
      "utf8",
    ))).toMatchObject({ phase: "committed" });

    await importGhostArchive(zipPath, ghostsRoot, { name: "recovery-trigger" });
    expect(await readFile(join(original.dir, "character.md"), "utf8"))
      .toBe("# Committed replacement\n");
    await expect(readFile(join(original.dir, "sentinel.txt"), "utf8")).rejects.toThrow();
    const backups = await readdir(join(ghostsRoot, ".trash"));
    const sentinelCopies = await Promise.all(backups.map(async (name) => {
      try {
        return await readFile(join(ghostsRoot, ".trash", name, "sentinel.txt"), "utf8");
      } catch {
        return null;
      }
    }));
    expect(sentinelCopies).toContain("original");
    expect((await readdir(ghostsRoot)).filter((name) => name.startsWith(".ghost-import-")))
      .toEqual([]);
  });

  it("serializes two overwrite publications across Bun processes", async () => {
    const ghostsRoot = join(workspace.dir, "RaceGhosts");
    await importGhostArchive(zipPath, ghostsRoot);
    const alphaPath = join(workspace.dir, "alpha.zip");
    const betaPath = join(workspace.dir, "beta.zip");
    const currentManifest = '{"format":"ghost-home/v2","ghostname":"casper"}';
    await writeFile(alphaPath, zipArchive({
      [`${ROOT}/character.md`]: "# Alpha\n",
      [`${ROOT}/export-manifest.json`]: currentManifest,
    }));
    await writeFile(betaPath, zipArchive({
      [`${ROOT}/character.md`]: "# Beta\n",
      [`${ROOT}/export-manifest.json`]: currentManifest,
    }));

    const go = join(workspace.dir, "import-go");
    const moduleUrl = new URL("../src/import.ts", import.meta.url).href;
    const spawnImport = (source: string, name: string): ChildProcess => {
      const ready = join(workspace.dir, `${name}.ready`);
      return spawn(process.execPath, [
        "-e",
        `
          const { importGhostArchive } = await import(${JSON.stringify(moduleUrl)});
          await Bun.write(${JSON.stringify(ready)}, "ready");
          while (!(await Bun.file(${JSON.stringify(go)}).exists())) await Bun.sleep(5);
          await importGhostArchive(
            ${JSON.stringify(source)},
            ${JSON.stringify(ghostsRoot)},
            { overwrite: true },
          );
        `,
      ], { stdio: ["ignore", "ignore", "pipe"] });
    };
    const alpha = spawnImport(alphaPath, "alpha");
    const beta = spawnImport(betaPath, "beta");
    const alphaResult = childResult(alpha);
    const betaResult = childResult(beta);
    await Promise.all([
      waitForPath(join(workspace.dir, "alpha.ready")),
      waitForPath(join(workspace.dir, "beta.ready")),
    ]);
    await writeFile(go, "go");

    const results = await Promise.all([alphaResult, betaResult]);
    expect(results).toEqual([
      { code: 0, signal: null, stderr: "" },
      { code: 0, signal: null, stderr: "" },
    ]);
    const published = await readFile(join(ghostsRoot, ROOT, "character.md"), "utf8");
    expect(["# Alpha\n", "# Beta\n"]).toContain(published);
    const backups = await readdir(join(ghostsRoot, ".trash"));
    expect(backups).toHaveLength(2);
    const backupCharacters = await Promise.all(backups.map((name) =>
      readFile(join(ghostsRoot, ".trash", name, "character.md"), "utf8")
    ));
    expect([...backupCharacters, published]).toEqual(
      expect.arrayContaining(["# Alpha\n", "# Beta\n", ARCHIVE[`${ROOT}/character.md`]]),
    );
    expect((await readdir(ghostsRoot)).some((name) => name.startsWith(".ghost-import-")))
      .toBe(false);
  });
});
