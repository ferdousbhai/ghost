import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveDocCatalog } from "../src/catalog.js";
import { GhostError, MemoryFileFormatError } from "../src/errors.js";
import { type GhostHome, openGhostHome } from "../src/home.js";
import { deriveMemoryIndex } from "../src/memory-file.js";
import {
  ARCHIVED_DOC_PATH,
  createGhostFixture,
  FINANCE_DOC_PATH,
  PAPER_DOC_PATH,
  type GhostFixture,
} from "./support/fixture.js";

let fixture: GhostFixture;
let home: GhostHome;
const execFileAsync = promisify(execFile);

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

async function childResult(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  return { code: code as number | null, stderr };
}

beforeEach(async () => {
  fixture = await createGhostFixture();
  home = openGhostHome(fixture.dir);
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("layout", () => {
  it("names itself after its directory", () => {
    expect(home.name).toBe("casper");
    expect(home.memoryDir).toBe(join(fixture.dir, "memory"));
  });

  it("never writes a derived index", async () => {
    await home.writeMemory({ content: "a fact" });
    const listing = await home.listMemory();
    expect(deriveMemoryIndex(listing.files).lines.length).toBeGreaterThan(0);
    await expect(readFile(join(fixture.dir, "MEMORY.md"), "utf8")).rejects.toThrow();
  });

  it("migrates nested legacy docs to strict v2 and is idempotent", async () => {
    const legacy = await createGhostFixture("legacy", {
      "character.md": "# Legacy\n",
      "notes/nested/h1-wins.md": `---
title: Frontmatter loses
tags: [Route Planning, route-planning, Café, "!!!"]
archived: true
path: Discard me
---

An introduction.
# Body Wins
The details.
#Existing #route-planning
`,
      "notes/nested/frontmatter-title.md": "---\ntitle: Frontmatter Wins\n---\n\nText.\n",
      "notes/deeper/plain-name.md": "No heading here.\n",
      "notes/.hidden.md": "hidden legacy bytes\n",
      "notes/.private/ignored.md": "hidden directory bytes\n",
    });
    try {
      const legacyHome = openGhostHome(legacy.dir);
      await legacyHome.ensure();
      expect(await readFile(join(legacyHome.docsDir, "nested/h1-wins.md"), "utf8"))
        .toBe(
          "# Body Wins\n\nAn introduction.\nThe details.\n\n"
          + "#route-planning #cafe #existing #archived\n",
        );
      expect(await readFile(
        join(legacyHome.docsDir, "nested/frontmatter-title.md"),
        "utf8",
      )).toBe("# Frontmatter Wins\n\nText.\n");
      expect(await readFile(join(legacyHome.docsDir, "deeper/plain-name.md"), "utf8"))
        .toBe("# plain-name\n\nNo heading here.\n");
      expect(await readFile(join(legacyHome.docsDir, ".hidden.md"), "utf8"))
        .toBe("hidden legacy bytes\n");
      expect(await readFile(join(legacyHome.docsDir, ".private/ignored.md"), "utf8"))
        .toBe("hidden directory bytes\n");

      const migrated = await readFile(join(legacyHome.docsDir, "nested/h1-wins.md"), "utf8");
      await legacyHome.ensure();
      expect(await readFile(join(legacyHome.docsDir, "nested/h1-wins.md"), "utf8"))
        .toBe(migrated);
      await expect(readFile(join(legacy.dir, "notes/nested/h1-wins.md"), "utf8"))
        .rejects.toThrow();
    } finally {
      await legacy.cleanup();
    }
  });

  it("does not rewrite canonical docs during a partial migration rerun", async () => {
    const partial = await createGhostFixture("partial", {
      "docs/already.md": "# Already canonical\n\nBytes stay put.\n\n#kept\n",
      "docs/legacy.md": "---\ntitle: Legacy\n---\n\nNeeds migration.\n",
    });
    try {
      const partialHome = openGhostHome(partial.dir);
      const canonicalPath = join(partialHome.docsDir, "already.md");
      const inode = (await stat(canonicalPath)).ino;
      await partialHome.ensure();
      expect((await stat(canonicalPath)).ino).toBe(inode);
      expect(await readFile(canonicalPath, "utf8"))
        .toBe("# Already canonical\n\nBytes stay put.\n\n#kept\n");
      expect(await readFile(join(partialHome.docsDir, "legacy.md"), "utf8"))
        .toBe("# Legacy\n\nNeeds migration.\n");
    } finally {
      await partial.cleanup();
    }
  });

  it("atomically migrates a v1 export manifest and leaves v2 untouched on rerun", async () => {
    const manifestHome = await createGhostFixture("manifest", {
      "docs/doc.md": "# Doc\n",
      "export-manifest.json": JSON.stringify({
        format: "ghost-home/v1",
        ghostname: "manifest",
        counts: { notes: 1 },
        custom: ["preserved"],
      }),
    });
    try {
      const opened = openGhostHome(manifestHome.dir);
      await expect(opened.readExportManifest())
        .rejects.toMatchObject({ code: "invalid_format" });
      await opened.ensure();
      expect(await opened.readExportManifest()).toEqual({
        format: "ghost-home/v2",
        ghostname: "manifest",
        counts: { notes: 1 },
        custom: ["preserved"],
      });
      const manifestPath = join(manifestHome.dir, "export-manifest.json");
      const inode = (await stat(manifestPath)).ino;
      await opened.ensure();
      expect((await stat(manifestPath)).ino).toBe(inode);
    } finally {
      await manifestHome.cleanup();
    }
  });

  it("rejects non-object and non-v2 live manifests", async () => {
    const manifestPath = join(fixture.dir, "export-manifest.json");
    await writeFile(manifestPath, '{"format":"ghost-home/v3"}');
    await expect(home.readExportManifest())
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(home.ensure()).rejects.toMatchObject({ code: "invalid_format" });
    await writeFile(manifestPath, "[]");
    await expect(home.readExportManifest())
      .rejects.toMatchObject({ code: "invalid_format" });
  });

  it("refuses to guess when legacy notes and canonical docs both exist", async () => {
    const ambiguous = await createGhostFixture("ambiguous", {
      "character.md": "# Ambiguous\n",
      "notes/project.md": "legacy\n",
      "docs/project.md": "canonical\n",
    });
    try {
      await expect(openGhostHome(ambiguous.dir).ensure())
        .rejects.toMatchObject({ code: "conflict" });
      expect(await readFile(join(ambiguous.dir, "notes", "project.md"), "utf8"))
        .toBe("legacy\n");
      expect(await readFile(join(ambiguous.dir, "docs", "project.md"), "utf8"))
        .toBe("canonical\n");
    } finally {
      await ambiguous.cleanup();
    }
  });
});

describe("character", () => {
  it("reads the persona and derives its title from the leading heading", async () => {
    const character = await home.readCharacter();
    expect(character?.title).toBe("Casper");
    expect(character?.body.startsWith("# Casper")).toBe(true);
  });

  it("leaves the derived title empty when the body has no leading heading", async () => {
    await writeFile(home.characterPath, "I keep the old ledgers.\n", "utf8");
    expect(await home.readCharacter()).toEqual({
      title: undefined,
      body: "I keep the old ledgers.\n",
    });
  });

  it("returns null when there is no character file", async () => {
    expect(await openGhostHome(fixture.root).readCharacter()).toBeNull();
  });
});

describe("docs", () => {
  it("lists strict v2 metadata derived from the raw Markdown", async () => {
    const { docs, skipped } = await home.listDocs();
    expect(skipped).toEqual([]);
    expect(docs.map((doc) => doc.path)).toEqual([
      PAPER_DOC_PATH,
      FINANCE_DOC_PATH,
      ARCHIVED_DOC_PATH,
      "press-restoration.md",
    ].sort((a, b) => a.localeCompare(b)));

    const paper = docs.find((doc) => doc.path === PAPER_DOC_PATH);
    expect(paper).toMatchObject({
      title: "Paper that takes a deep impression",
      tags: ["paper", "press"],
      archived: false,
    });
    const archived = docs.find((doc) => doc.path === ARCHIVED_DOC_PATH);
    expect(archived).toMatchObject({ tags: [], archived: true });
  });

  it("returns the complete canonical Markdown body", async () => {
    const bytes = await readFile(join(home.docsDir, PAPER_DOC_PATH), "utf8");
    const doc = await home.readDoc(PAPER_DOC_PATH);
    expect(doc.body).toBe(bytes);
    expect(doc.body.startsWith("# Paper that takes a deep impression")).toBe(true);
    expect(doc.body.endsWith("#paper #press\n")).toBe(true);
  });

  it("validates then writes exactly the supplied canonical bytes", async () => {
    const exact = "# Exact bytes\r\n\r\nKeep trailing spaces  \r\n\r\n#one\r\n";
    const meta = await home.writeDoc("nested/exact.md", { body: exact });
    expect(meta).toMatchObject({ title: "Exact bytes", tags: ["one"], archived: false });
    expect(await readFile(join(home.docsDir, "nested/exact.md"), "utf8")).toBe(exact);
    expect((await home.readDoc("nested/exact")).body).toBe(exact);
  });

  it("rejects non-v2 bytes on every live read and write path", async () => {
    const invalidPath = join(home.docsDir, "invalid.md");
    await writeFile(invalidPath, "---\ntitle: Legacy\n---\n\nbody\n");
    await expect(home.readDoc("invalid")).rejects.toMatchObject({ code: "invalid_format" });
    const listing = await home.listDocs();
    expect(listing.docs.some((doc) => doc.path === "invalid.md")).toBe(false);
    expect(listing.skipped).toEqual([
      expect.objectContaining({ path: "docs/invalid.md" }),
    ]);
    await expect(home.writeDoc("plain.md", { body: "plain bytes" }))
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(home.writeDoc("uppercase-tag.md", {
      body: "# Valid title\n\n#Not-Canonical\n",
    })).rejects.toMatchObject({ code: "invalid_format" });
    await expect(readFile(join(home.docsDir, "plain.md"), "utf8")).rejects.toThrow();
  });

  it("keeps canonical bytes identical across a read/write round trip", async () => {
    const before = await readFile(join(home.docsDir, PAPER_DOC_PATH), "utf8");
    const doc = await home.readDoc(PAPER_DOC_PATH);
    await home.writeDoc(PAPER_DOC_PATH, { body: doc.body });
    expect(await readFile(join(home.docsDir, PAPER_DOC_PATH), "utf8")).toBe(before);
  });

  it("refuses paths that escape the docs directory", async () => {
    await expect(home.readDoc("../../etc/passwd")).rejects.toThrow(GhostError);
    await expect(home.writeDoc("../outside.md", { body: "# X\n" })).rejects.toThrow(GhostError);
  });

  it("refuses file and directory symlinks instead of following them outside", async () => {
    const outsideFile = join(fixture.root, "outside.md");
    const outsideDir = join(fixture.root, "outside-docs");
    const outsideBytes = "# Outside secret\n\nNever list me.\n";
    await writeFile(outsideFile, outsideBytes, "utf8");
    await mkdir(outsideDir);
    await symlink(outsideFile, join(home.docsDir, "linked.md"));
    await symlink(outsideDir, join(home.docsDir, "linked-dir"));

    await expect(home.readDoc("linked.md"))
      .rejects.toMatchObject({ code: "invalid_path" });
    await expect(home.writeDoc("linked.md", { body: "# Replacement\n" }))
      .rejects.toMatchObject({ code: "invalid_path" });
    await expect(home.writeDoc("linked-dir/new.md", { body: "# New\n" }))
      .rejects.toMatchObject({ code: "invalid_path" });

    const listing = await home.listDocs();
    expect(listing.docs.map((doc) => doc.title)).not.toContain("Outside secret");
    expect(listing.skipped).toContainEqual(
      expect.objectContaining({ path: "docs/linked.md" }),
    );
    expect(await readFile(outsideFile, "utf8")).toBe(outsideBytes);
    await expect(readFile(join(outsideDir, "new.md"), "utf8")).rejects.toThrow();
  });

  it("rejects a FIFO document without blocking on open", async () => {
    await execFileAsync("mkfifo", [join(home.docsDir, "blocking.md")]);
    const started = Date.now();
    const listing = await home.listDocs();
    await expect(home.readDoc("blocking.md"))
      .rejects.toMatchObject({ code: "invalid_path" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(listing.skipped).toContainEqual(
      expect.objectContaining({ path: "docs/blocking.md" }),
    );
  });

  it("publishes concurrent doc replacements as complete atomic files", async () => {
    const bodies = Array.from(
      { length: 12 },
      (_, index) => `# Version ${index}\n\n${String(index).repeat(100_000)}\n`,
    );
    await Promise.all(bodies.map((body) => home.writeDoc("races/hot.md", { body })));

    expect(bodies).toContain(await readFile(join(home.docsDir, "races/hot.md"), "utf8"));
    expect((await readdir(join(home.docsDir, "races"))).filter((name) =>
      name.includes(".write-")
    )).toEqual([]);
  });

  it("throws not_found rather than returning an error payload", async () => {
    await expect(home.readDoc("missing.md")).rejects.toMatchObject({ code: "not_found" });
  });

  it("searches bodies and reports line numbers", async () => {
    const result = await home.searchDocs("carriage");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe("press-restoration.md");
    expect(result.matches[0]?.line).toBe(3);
  });

  it("excludes #archived docs from search unless explicitly activated", async () => {
    expect((await home.searchDocs("Superseded")).matches).toEqual([]);
    const active = await home.searchDocs("Superseded", { includeArchived: true });
    expect(active.matches).toEqual([
      expect.objectContaining({ path: ARCHIVED_DOC_PATH, line: 3 }),
    ]);
  });

  it("refuses a catastrophic-backtracking regex fast instead of hanging", async () => {
    const started = Date.now();
    await expect(home.searchDocs("(a+)+$", { regex: true }))
      .rejects.toMatchObject({ code: "invalid_format" });
    await expect(home.searchDocs("(.*a){30}", { regex: true }))
      .rejects.toMatchObject({ code: "invalid_format" });
    // The whole guard, analysis included, is bounded well under a second.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still runs an ordinary regex search", async () => {
    const result = await home.searchDocs("carr[a-z]+", { regex: true });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.path).toBe("press-restoration.md");
  });

  it("leaves the literal (non-regex) path untouched by the ReDoS guard", async () => {
    // The same string that is refused as a regex is a fine literal query: it is
    // escaped, so it can never backtrack, and it simply matches nothing here.
    const result = await home.searchDocs("(a+)+$");
    expect(result.matches).toEqual([]);
    expect(result.docsSearched).toBeGreaterThan(0);
  });

  it("caps title matches at max_results and reports truncation", async () => {
    for (let index = 0; index < 10; index += 1) {
      await home.writeDoc(`widgets/w${index}.md`, {
        body: `# Widget number ${index}\n\nNothing to match in the body.\n`,
      });
    }
    const result = await home.searchDocs("Widget number", { maxResults: 3 });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
    // Every returned match is a title hit (line 0), the path that used to overrun.
    expect(result.matches.every((match) => match.line === 0)).toBe(true);
  });
});

describe("doc catalog", () => {
  it("lists every doc and marks archived entries", async () => {
    const { docs } = await home.listDocs();
    const catalog = deriveDocCatalog(docs);
    expect(catalog.total).toBe(4);
    expect(catalog.lines.join("\n")).toContain(`${FINANCE_DOC_PATH}: Estate and finances`);
    expect(catalog.lines.join("\n")).toContain(`${ARCHIVED_DOC_PATH}: Old plan (archived)`);
  });
});

describe("memory", () => {
  it("lists memory in slug order", async () => {
    const { files, skipped } = await home.listMemory();
    expect(skipped).toEqual([]);
    expect(files.map((file) => file.slug)).toEqual([
      "apprentice-question",
      "working-habit",
    ]);
    expect(files[0]?.updated).toBe(new Date().toISOString().slice(0, 10));
  });

  it("replaces an existing file rather than appending a second one", async () => {
    await home.writeMemory({
      name: "working-habit.md",
      content: "Updated: the press is cold until nine.",
    });
    const { files } = await home.listMemory();
    expect(files).toHaveLength(2);
    expect((await home.readMemory("working-habit")).content)
      .toBe("Updated: the press is cold until nine.");
  });

  it("rejects a malformed write with instructional guidance", async () => {
    await expect(home.writeMemory({ content: "" }))
      .rejects.toThrow(MemoryFileFormatError);
    await expect(home.writeMemory({ content: "x".repeat(2_001) }))
      .rejects.toThrow(MemoryFileFormatError);
  });

  it("reports an empty memory file instead of dropping it silently", async () => {
    await writeFile(join(home.memoryDir, "broken.md"), "\n", "utf8");
    const { files, skipped } = await home.listMemory();
    expect(files.map((file) => file.slug)).not.toContain("broken");
    expect(skipped[0]?.path).toBe("memory/broken.md");
  });

  it("serializes concurrent writes to the same file", async () => {
    // pi runs a batch of tool calls in parallel; the last write must win whole,
    // not interleave with the others.
    await Promise.all(
      Array.from({ length: 12 }, (_, position) =>
        home.writeMemory({
          name: "hot-file.md",
          content: `write ${position}`,
        })),
    );
    const file = await home.readMemory("hot-file");
    expect(file.description).toMatch(/^write \d+$/);
    expect(file.content).toBe(file.description);
    const { files } = await home.listMemory();
    expect(files.filter((entry) => entry.slug === "hot-file")).toHaveLength(1);
  });

  it("serializes the directory-wide quota across different new names", async () => {
    const filler = "x\n";
    await Promise.all(Array.from({ length: 497 }, (_, index) =>
      writeFile(join(home.memoryDir, `filler-${index}.md`), filler, "utf8")
    ));

    const results = await Promise.allSettled([
      home.writeMemory({ name: "last-a", content: "a" }),
      home.writeMemory({ name: "last-b", content: "b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "limit_exceeded" }) }),
    ]);
    expect((await home.listMemory()).files).toHaveLength(500);
  });

  it("serializes the memory quota across separate Bun processes", async () => {
    const filler = "x\n";
    await Promise.all(Array.from({ length: 497 }, (_, index) =>
      writeFile(join(home.memoryDir, `process-filler-${index}.md`), filler, "utf8")
    ));

    const go = join(fixture.root, "process-go");
    const moduleUrl = new URL("../src/home.ts", import.meta.url).href;
    const spawnWriter = (name: string): ChildProcess => {
      const ready = join(fixture.root, `${name}.ready`);
      return spawn(process.execPath, [
        "-e",
        `
          const { openGhostHome } = await import(${JSON.stringify(moduleUrl)});
          await Bun.write(${JSON.stringify(ready)}, "ready");
          while (!(await Bun.file(${JSON.stringify(go)}).exists())) await Bun.sleep(5);
          await openGhostHome(${JSON.stringify(fixture.dir)}).writeMemory({
            name: ${JSON.stringify(name)},
            content: ${JSON.stringify(name)},
          });
        `,
      ], { stdio: ["ignore", "ignore", "pipe"] });
    };
    const first = spawnWriter("process-last-a");
    const second = spawnWriter("process-last-b");
    const firstResult = childResult(first);
    const secondResult = childResult(second);
    await Promise.all([
      waitForPath(join(fixture.root, "process-last-a.ready")),
      waitForPath(join(fixture.root, "process-last-b.ready")),
    ]);
    await writeFile(go, "go");

    const results = await Promise.all([firstResult, secondResult]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    expect(results.find((result) => result.code !== 0)?.stderr)
      .toContain("limit_exceeded");
    expect((await home.listMemory()).files).toHaveLength(500);
  });
});

describe("conversations", () => {
  it("lists imported transcripts", async () => {
    expect(await home.listConversations()).toEqual(["conv-1"]);
  });
});
