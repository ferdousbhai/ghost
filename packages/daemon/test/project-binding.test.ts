import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationIdentity } from "../src/conversation-identity.js";
import {
  PROJECT_TRUST_MAX_BYTES,
  PROJECT_TRUST_MAX_ROOTS,
  PROJECT_TRUST_ROOT_MAX_BYTES,
  ProjectBindingStore as ProductionProjectBindingStore,
  projectBindingPath,
  summarizeProject,
} from "../src/project-binding.js";
import {
  loadProjectDeclarativeSnapshot,
  PROJECT_SCAN_MAX_BYTES,
  PROJECT_SCAN_MAX_FILE_BYTES,
  PROJECT_SCAN_MAX_ENTRIES,
  PROJECT_SCAN_MAX_DEPTH,
} from "../src/project-resources.js";
import {
  piProjectSnapshotPath,
  readPiProjectSnapshot,
} from "../src/project-snapshot.js";

const roots: string[] = [];

class ProjectBindingStore extends ProductionProjectBindingStore {
  override preview(
    runtime: Parameters<ProductionProjectBindingStore["preview"]>[0],
    conversationId: string,
    path: string,
    scope = "casper",
  ): ReturnType<ProductionProjectBindingStore["preview"]> {
    return super.preview(runtime, conversationId, path, scope);
  }

  override write(
    input: Omit<Parameters<ProductionProjectBindingStore["write"]>[0], "scope">
      & { scope?: string },
  ): Promise<void> {
    return super.write({ ...input, scope: input.scope ?? "casper" });
  }

  override updateRuntimeStatus(
    sessionDir: string,
    runtime: Parameters<ProductionProjectBindingStore["updateRuntimeStatus"]>[1],
    conversationId: string,
    current: Parameters<ProductionProjectBindingStore["updateRuntimeStatus"]>[3],
    input: Parameters<ProductionProjectBindingStore["updateRuntimeStatus"]>[4],
    scope = "casper",
  ): Promise<boolean> {
    return super.updateRuntimeStatus(
      sessionDir,
      runtime,
      conversationId,
      current,
      input,
      scope,
    );
  }

  override writeOperationalCwd(
    sessionDir: string,
    runtime: Parameters<ProductionProjectBindingStore["writeOperationalCwd"]>[1],
    conversationId: string,
    current: Parameters<ProductionProjectBindingStore["writeOperationalCwd"]>[3],
    cwd: string,
    scope = "casper",
  ): Promise<void> {
    return super.writeOperationalCwd(
      sessionDir,
      runtime,
      conversationId,
      current,
      cwd,
      scope,
    );
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(now?: () => number) {
  const root = mkdtempSync(join(tmpdir(), "ghost-project-binding-"));
  roots.push(root);
  const ownerHome = join(root, "owner");
  const sessionDir = join(root, "ghost", "sessions");
  const project = join(root, "project");
  mkdirSync(ownerHome, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const store = new ProjectBindingStore({
    ownerHome,
    trustPath: join(root, "state", "project-trust.json"),
    ...(now ? { now } : {}),
  });
  return { root, ownerHome, sessionDir, project, store };
}

interface TestTrustRow {
  root: string;
  dev: string;
  ino: string;
  trustedAt: string;
}

function trustLedgerBytes(roots: TestTrustRow[]): Buffer {
  return Buffer.from(`${JSON.stringify({ version: 1, roots }, null, 2)}\n`, "utf8");
}

function compactTrustLedgerBytes(roots: TestTrustRow[]): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, roots }), "utf8");
}

function filesystemTrustRow(root: string, now: number): TestTrustRow {
  const info = statSync(root, { bigint: true });
  return {
    root,
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    trustedAt: new Date(now).toISOString(),
  };
}

function paddingTrustRoot(index: number, byteLength: number): string {
  const prefix = `/ledger-padding-${index.toString().padStart(4, "0")}-`;
  if (byteLength < Buffer.byteLength(prefix) || byteLength > PROJECT_TRUST_ROOT_MAX_BYTES) {
    throw new Error(`Unsupported trust-root padding length ${byteLength}.`);
  }
  return `${prefix}${"x".repeat(byteLength - Buffer.byteLength(prefix))}`;
}

function trustRowsForSerializedSize(
  targetBytes: number,
  finalRows: TestTrustRow[],
): TestTrustRow[] {
  const roots: TestTrustRow[] = [];
  const trustedAt = "2026-08-27T00:00:00.000Z";
  for (let index = 0; index < PROJECT_TRUST_MAX_ROOTS - finalRows.length; index += 1) {
    const minimumRootLength = 32;
    const row = (rootLength: number): TestTrustRow => ({
      root: paddingTrustRoot(index, rootLength),
      dev: String(index + 1),
      ino: String(index + 10_000),
      trustedAt,
    });
    const minimum = trustLedgerBytes([
      ...roots,
      row(minimumRootLength),
      ...finalRows,
    ]).byteLength;
    const maximum = trustLedgerBytes([
      ...roots,
      row(PROJECT_TRUST_ROOT_MAX_BYTES),
      ...finalRows,
    ]).byteLength;
    if (targetBytes >= minimum && targetBytes <= maximum) {
      const rootLength = minimumRootLength + (targetBytes - minimum);
      roots.push(row(rootLength));
      expect(trustLedgerBytes([...roots, ...finalRows])).toHaveLength(targetBytes);
      return roots;
    }
    if (targetBytes < minimum) break;
    roots.push(row(8_000));
  }
  throw new Error(`Could not construct a ${targetBytes}-byte trust ledger.`);
}

describe("ProjectBindingStore", () => {
  it("keeps committed scope revocation across writes until the old authority retires", async () => {
    const { sessionDir, project, store } = fixture();
    const parent = conversationIdentity("pi", "scope-write-revocation");
    const initial = await store.read(
      sessionDir, parent.id, parent.runtime, parent.conversationId,
    );
    const preview = await store.preview(
      parent.runtime, parent.conversationId, project, "casper",
    );
    await store.write({
      sessionDir,
      runtime: parent.runtime,
      conversationId: parent.conversationId,
      current: initial,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
      scope: "casper",
    });
    const current = await store.read(
      sessionDir, parent.id, parent.runtime, parent.conversationId,
    );
    const lease = await store.beginScopeRevocation("casper");
    lease.commit();
    await expect(store.write({
      sessionDir,
      runtime: parent.runtime,
      conversationId: parent.conversationId,
      current,
      root: project,
      cwd: project,
      reason: "reloaded",
      scope: "casper",
    })).rejects.toMatchObject({ code: "task_binding_changed" });
    lease.rollback();
    await expect(store.preview(
      parent.runtime, parent.conversationId, project, "casper",
    )).rejects.toMatchObject({ code: "task_binding_changed" });
    lease.retire();
    await expect(store.preview(
      parent.runtime, parent.conversationId, project, "casper",
    )).resolves.toMatchObject({ root: project });
  });

  it("fences every final-name binding publisher under exact and scope revocation", async () => {
    const { sessionDir, project, store } = fixture();
    const source = conversationIdentity("pi", "publisher-source");
    const initial = await store.read(
      sessionDir,
      source.id,
      source.runtime,
      source.conversationId,
    );
    const preview = await store.preview(
      source.runtime,
      source.conversationId,
      project,
      "casper",
    );
    await store.write({
      sessionDir,
      runtime: source.runtime,
      conversationId: source.conversationId,
      current: initial,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
      scope: "casper",
    });
    const current = await store.read(
      sessionDir,
      source.id,
      source.runtime,
      source.conversationId,
    );

    const exact = await store.beginRevocation(
      sessionDir,
      "casper",
      source.runtime,
      source.conversationId,
    );
    await expect(store.updateRuntimeStatus(
      sessionDir,
      source.runtime,
      source.conversationId,
      current,
      { status: "ready", error: null, mcpStatus: "off" },
      "casper",
    )).rejects.toMatchObject({ code: "task_binding_changed" });
    exact.rollback();

    const scope = await store.beginScopeRevocation("casper");
    await expect(store.writeOperationalCwd(
      sessionDir,
      source.runtime,
      source.conversationId,
      current,
      project,
      "casper",
    )).rejects.toMatchObject({ code: "task_binding_changed" });
    scope.rollback();

    const target = conversationIdentity("pi", "publisher-target");
    const staged = `${projectBindingPath(
      sessionDir,
      target.runtime,
      target.conversationId,
    )}.pending`;
    const targetRevocation = await store.beginRevocation(
      sessionDir,
      "casper",
      target.runtime,
      target.conversationId,
    );
    await expect(store.clone(
      sessionDir,
      target.runtime,
      target.conversationId,
      current,
      "casper",
      staged,
    )).rejects.toMatchObject({ code: "task_binding_changed" });
    targetRevocation.rollback();
    await store.clone(
      sessionDir,
      target.runtime,
      target.conversationId,
      current,
      "casper",
      staged,
    );
    const publicationRevocation = await store.beginRevocation(
      sessionDir,
      "casper",
      target.runtime,
      target.conversationId,
    );
    await expect(store.publishCloneDestination(
      sessionDir,
      target.runtime,
      target.conversationId,
      "casper",
      staged,
    )).rejects.toMatchObject({ code: "task_binding_changed" });
    expect(existsSync(staged)).toBe(true);
    expect(existsSync(projectBindingPath(
      sessionDir,
      target.runtime,
      target.conversationId,
    ))).toBe(false);
    publicationRevocation.rollback();
    await store.publishCloneDestination(
      sessionDir,
      target.runtime,
      target.conversationId,
      "casper",
      staged,
    );
  });

  it("consults legacy cwd lazily only when no binding sidecar exists", async () => {
    const { ownerHome, sessionDir, project, store } = fixture();
    let legacyReads = 0;
    const legacyCwd = async () => {
      legacyReads += 1;
      return project;
    };

    const legacy = await store.read(
      sessionDir,
      "pi:lazy-legacy",
      "pi",
      "lazy-legacy",
      { legacyCwd },
    );
    expect(legacyReads).toBe(1);
    expect(legacy).toMatchObject({ cwd: project, reason: "legacy" });

    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "lazy-legacy",
      current: legacy,
      root: null,
      cwd: ownerHome,
      reason: "unbound",
    });
    legacyReads = 0;
    const bound = await store.read(
      sessionDir,
      "pi:lazy-legacy",
      "pi",
      "lazy-legacy",
      { legacyCwd },
    );
    expect(legacyReads).toBe(0);
    expect(bound).toMatchObject({ cwd: ownerHome, reason: "unbound" });

    writeFileSync(
      projectBindingPath(sessionDir, "pi", "lazy-legacy"),
      "{malformed\n",
      { encoding: "utf8", mode: 0o600 },
    );
    await expect(store.read(
      sessionDir,
      "pi:lazy-legacy",
      "pi",
      "lazy-legacy",
      { legacyCwd },
    )).rejects.toBeInstanceOf(Error);
    expect(legacyReads).toBe(0);
  });

  it("fails closed on linked, blocking, and oversized binding metadata", async () => {
    const { root, sessionDir, store } = fixture();
    const conversationId = "hostile-binding";
    const path = projectBindingPath(sessionDir, "pi", conversationId);
    const outside = join(root, "outside-binding.json");
    let legacyReads = 0;
    const read = () => store.read(
      sessionDir,
      `pi:${conversationId}`,
      "pi",
      conversationId,
      { legacyCwd: async () => {
        legacyReads += 1;
        return undefined;
      } },
    );

    writeFileSync(outside, "{}\n", { mode: 0o600 });
    symlinkSync(outside, path);
    await expect(read()).rejects.toMatchObject({ code: "project_binding_invalid", status: 500 });
    expect(legacyReads).toBe(0);
    rmSync(path);

    execFileSync("mkfifo", [path]);
    const timeout = Symbol("timeout");
    const fifo = await Promise.race([
      read().then(() => "resolved", () => "rejected"),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 500)),
    ]);
    expect(fifo).toBe("rejected");
    expect(legacyReads).toBe(0);
    rmSync(path);

    writeFileSync(path, "x".repeat(1_048_577), { mode: 0o600 });
    await expect(read()).rejects.toMatchObject({ code: "project_binding_invalid", status: 500 });
    expect(legacyReads).toBe(0);
  });

  it("rejects every corrupt persisted binding field without repair or legacy fallback", async () => {
    const { root, sessionDir, project, store } = fixture();
    const conversationId = "strict-binding-schema";
    const current = await store.read(
      sessionDir,
      `pi:${conversationId}`,
      "pi",
      conversationId,
    );
    const preview = await store.preview("pi", conversationId, project);
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId,
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const bound = await store.read(
      sessionDir,
      `pi:${conversationId}`,
      "pi",
      conversationId,
    );
    const path = projectBindingPath(sessionDir, "pi", conversationId);
    const valid = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const resources = valid.resources as Record<string, unknown>;
    const identity = valid.identity as Record<string, string>;
    const outside = join(root, "outside-project");
    mkdirSync(outside);
    const without = (field: string): Record<string, unknown> => Object.fromEntries(
      Object.entries(valid).filter(([name]) => name !== field),
    );
    const invalidRows: Array<[string, Record<string, unknown>]> = [
      ["extra warnings", { ...valid, warnings: [] }],
      ["missing field", without("error")],
      ["wrong version", { ...valid, version: 2 }],
      ["wrong runtime", { ...valid, runtime: "claude-code" }],
      ["wrong conversation", { ...valid, conversationId: "another" }],
      ["empty root", { ...valid, root: "" }],
      ["noncanonical root", { ...valid, root: `${project}/.` }],
      ["untrusted canonical root", { ...valid, root: outside, cwd: outside }],
      ["missing bound identity", { ...valid, identity: null }],
      ["identity extra field", { ...valid, identity: { ...identity, generation: "1" } }],
      ["identity noncanonical digits", { ...valid, identity: { ...identity, dev: "00" } }],
      ["identity mismatch", {
        ...valid,
        identity: { ...identity, ino: String(BigInt(identity.ino!) + 1n) },
      }],
      ["relative cwd", { ...valid, cwd: "relative" }],
      ["noncanonical cwd", { ...valid, cwd: `${project}/.` }],
      ["cwd outside root", { ...valid, cwd: outside }],
      ["negative generation", { ...valid, generation: -1 }],
      ["fractional generation", { ...valid, generation: 1.5 }],
      ["unsafe generation", { ...valid, generation: Number.MAX_SAFE_INTEGER + 1 }],
      ["unknown status", { ...valid, status: "loading" }],
      ["array error", { ...valid, error: [] }],
      ["empty error code", { ...valid, error: { code: "", message: "failed" } }],
      ["oversized error", {
        ...valid,
        error: { code: "project_error", message: "x".repeat(8 * 1024 + 1) },
      }],
      ["unknown MCP state", { ...valid, mcpStatus: "connecting" }],
      ["missing resource", {
        ...valid,
        resources: Object.fromEntries(
          Object.entries(resources).filter(([name]) => name !== "skills"),
        ),
      }],
      ["extra resource", { ...valid, resources: { ...resources, documents: 1 } }],
      ["negative resource", { ...valid, resources: { ...resources, skills: -1 } }],
      ["fractional resource", { ...valid, resources: { ...resources, skills: 0.5 } }],
      ["invalid timestamp", { ...valid, lastRefreshAt: "2026-08-27" }],
      ["unknown reason", { ...valid, reason: "repaired" }],
      ["null root with identity", { ...valid, root: null }],
      ["null root with resources", {
        ...valid,
        root: null,
        identity: null,
        status: "unbound",
        error: null,
        mcpStatus: "off",
        resources: { ...resources, skills: 1 },
      }],
    ];
    let legacyReads = 0;
    for (const [name, row] of invalidRows) {
      const bytes = `${JSON.stringify(row)}\n`;
      writeFileSync(path, bytes, { mode: 0o600 });
      await expect(store.read(
        sessionDir,
        `pi:${conversationId}`,
        "pi",
        conversationId,
        { legacyCwd: async () => {
          legacyReads += 1;
          return outside;
        } },
      ), name).rejects.toMatchObject({ code: "project_binding_invalid", status: 500 });
      expect(readFileSync(path, "utf8"), name).toBe(bytes);
    }
    expect(legacyReads).toBe(0);

    const corrupt = `${JSON.stringify({ ...valid, warnings: ["must not persist"] })}\n`;
    writeFileSync(path, corrupt, { mode: 0o600 });
    await expect(store.updateRuntimeStatus(
      sessionDir,
      "pi",
      conversationId,
      bound,
      { status: "ready", error: null, mcpStatus: "off" },
    )).rejects.toMatchObject({ code: "project_binding_invalid", status: 500 });
    expect(readFileSync(path, "utf8")).toBe(corrupt);

    writeFileSync(path, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
    await expect(store.read(sessionDir, `pi:${conversationId}`, "pi", conversationId))
      .resolves.toMatchObject(bound);
  });

  it("rejects relative project inputs at the store boundary", async () => {
    const { sessionDir, store } = fixture();
    await expect(store.preview("pi", "relative", "project"))
      .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    const current = await store.read(sessionDir, "pi:relative", "pi", "relative");
    await expect(store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "relative",
      current,
      root: "project",
      reason: "bound",
    })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    await expect(store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "relative",
      current,
      root: null,
      cwd: "child",
      reason: "unbound",
    })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  it("defaults to owner home and previews only bounded declarative resources", async () => {
    const { root, ownerHome, sessionDir, project, store } = fixture();
    const initial = await store.read(sessionDir, "pi:draft", "pi", "draft");
    expect(initial).toMatchObject({
      root: null,
      cwd: ownerHome,
      relativeCwd: null,
      generation: 0,
      status: "unbound",
      resources: {
        instructions: 0,
        skills: 0,
        rules: 0,
        prompts: 0,
        commands: 0,
        agents: 0,
        mcpServers: 0,
        ignoredExecutable: 0,
      },
    });

    writeFileSync(join(project, "AGENTS.md"), "project");
    mkdirSync(join(project, ".omp", "skills", "review"), { recursive: true });
    writeFileSync(
      join(project, ".omp", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: review\n---\n\nskill",
    );
    mkdirSync(join(project, ".claude", "rules"), { recursive: true });
    writeFileSync(join(project, ".claude", "rules", "safe.md"), "rule");
    mkdirSync(join(project, ".omp", "extensions"), { recursive: true });
    writeFileSync(join(project, ".omp", "extensions", "unsafe.ts"), "export default 1");
    writeFileSync(
      join(project, ".omp", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          one: { type: "stdio", command: "one" },
          two: { type: "stdio", command: "two" },
        },
      }),
    );
    mkdirSync(join(project, "deep", ".omp", "skills", "ignored"), { recursive: true });
    writeFileSync(join(project, "deep", ".omp", "skills", "ignored", "SKILL.md"), "deep");
    writeFileSync(join(root, "outside.md"), "outside");
    symlinkSync(join(root, "outside.md"), join(project, "CLAUDE.md"));

    const projectLink = join(root, "project-link");
    symlinkSync(project, projectLink);
    await expect(store.preview("pi", "draft", projectLink))
      .rejects.toMatchObject({ code: "invalid_project_path" });

    expect(await summarizeProject(project)).toEqual({
      instructions: 1,
      skills: 1,
      rules: 1,
      prompts: 0,
      commands: 0,
      agents: 0,
      mcpServers: 2,
      ignoredExecutable: 1,
    });
    const preview = await store.preview("pi", "draft", project);
    expect(preview).toMatchObject({
      root: project,
      name: "project",
      resources: { instructions: 1, skills: 1, mcpServers: 2, ignoredExecutable: 1 },
      warnings: expect.arrayContaining([
        expect.stringContaining("remain disabled"),
      ]),
    });
  });

  it("counts and persists only validated typed skills while skipping invalid siblings", async () => {
    const { sessionDir, project, store } = fixture();
    const valid = join(project, ".omp", "skills", "valid");
    const shadowed = join(project, ".agents", "skills", "shadowed");
    const descriptionless = join(project, ".omp", "skills", "descriptionless");
    const namelessCollision = join(project, ".claude", "skills", "valid");
    const malformed = join(project, ".omp", "skills", "malformed");
    mkdirSync(valid, { recursive: true });
    mkdirSync(shadowed, { recursive: true });
    mkdirSync(descriptionless, { recursive: true });
    mkdirSync(namelessCollision, { recursive: true });
    mkdirSync(malformed, { recursive: true });
    writeFileSync(
      join(valid, "SKILL.md"),
      "---\nname: valid\ndescription: accepted\n---\n\nVALID-SKILL-BODY",
    );
    writeFileSync(
      join(shadowed, "SKILL.md"),
      "---\nname: valid\ndescription: shadowed\n---\n\nSHADOWED-SKILL-BODY",
    );
    writeFileSync(
      join(descriptionless, "SKILL.md"),
      "---\nname: descriptionless\n---\n\nDESCRIPTIONLESS-SKILL-BODY",
    );
    writeFileSync(
      join(namelessCollision, "SKILL.md"),
      "---\ndescription: must not inherit the valid directory name\n---\n\nNAMELESS-COLLISION-BODY",
    );
    writeFileSync(
      join(malformed, "SKILL.md"),
      "---\nname: [unterminated\n---\n\nMALFORMED-SKILL-BODY",
    );

    const preview = await store.preview("pi", "typed-skills", project);
    expect(preview.resources.skills).toBe(1);
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("skill name or description is missing"),
      expect.stringContaining("skill metadata is invalid"),
    ]));

    const current = await store.read(sessionDir, "pi:typed-skills", "pi", "typed-skills");
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "typed-skills",
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const bound = await store.read(sessionDir, "pi:typed-skills", "pi", "typed-skills");
    const snapshot = await readPiProjectSnapshot({
      sessionDir,
      conversationId: "typed-skills",
      generation: bound.generation,
      root: project,
      identity: await store.assertTrusted(project),
    });
    expect(bound.resources.skills).toBe(1);
    expect(snapshot.resources.skills).toBe(1);
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["valid"]);
    expect(snapshot.skills[0]?.snapshotContent).toContain("VALID-SKILL-BODY");
    expect(JSON.stringify(snapshot.skills)).not.toContain("SHADOWED-SKILL-BODY");
    expect(JSON.stringify(snapshot.skills)).not.toContain("DESCRIPTIONLESS-SKILL-BODY");
    expect(JSON.stringify(snapshot.skills)).not.toContain("NAMELESS-COLLISION-BODY");
    expect(JSON.stringify(snapshot.skills)).not.toContain("MALFORMED-SKILL-BODY");
  });

  it("preserves .omp-compatible rule globs and interrupt modes in the immutable Pi snapshot", async () => {
    const { sessionDir, project, store } = fixture();
    const rulesDir = join(project, ".omp", "rules");
    mkdirSync(rulesDir, { recursive: true });
    const writeRule = (name: string, frontmatter: string, body: string) => {
      writeFileSync(join(rulesDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
    };
    writeRule(
      "string-glob",
      'globs: "**/*.ts"\ncondition: STRING_GLOB\ninterruptMode: never',
      "STRING-GLOB-RULE",
    );
    writeRule(
      "array-globs",
      "globs:\n  - '**/*.tsx'\n  - 42\n  - '**/*.jsx'\ncondition: ARRAY_GLOBS\ninterruptMode: prose-only",
      "ARRAY-GLOBS-RULE",
    );
    writeRule(
      "tool-mode",
      "condition: TOOL_MODE\ninterruptMode: tool-only",
      "TOOL-MODE-RULE",
    );
    writeRule(
      "always-mode",
      "condition: ALWAYS_MODE\ninterruptMode: always",
      "ALWAYS-MODE-RULE",
    );
    writeRule(
      "omp-defaults",
      "globs: 42\ncondition: DEFAULT_MODE\ninterruptMode: sometimes",
      "OMP-DEFAULTED-RULE",
    );
    writeFileSync(
      join(rulesDir, "malformed.md"),
      "---\nglobs: [unterminated\n---\n\nMALFORMED-RULE",
    );

    const preview = await store.preview("pi", "typed-rules", project);
    expect(preview.resources.rules).toBe(5);
    expect(preview.warnings).toContainEqual(
      expect.stringContaining("rule metadata is invalid"),
    );

    const current = await store.read(sessionDir, "pi:typed-rules", "pi", "typed-rules");
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "typed-rules",
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const bound = await store.read(sessionDir, "pi:typed-rules", "pi", "typed-rules");
    for (const name of ["string-glob", "array-globs", "tool-mode", "always-mode"]) {
      writeFileSync(join(rulesDir, `${name}.md`), "MUTATED-AFTER-BIND");
    }
    const snapshotPath = piProjectSnapshotPath(
      sessionDir,
      "typed-rules",
      bound.generation,
    );
    const snapshot = await readPiProjectSnapshot({
      sessionDir,
      conversationId: "typed-rules",
      generation: bound.generation,
      root: project,
      identity: await store.assertTrusted(project),
    });
    const rules = new Map(snapshot.rules.map((rule) => [rule.name, rule]));
    expect(rules.get("string-glob")).toMatchObject({
      globs: ["**/*.ts"],
      condition: ["STRING_GLOB"],
      interruptMode: "never",
      content: "STRING-GLOB-RULE",
    });
    expect(rules.get("array-globs")).toMatchObject({
      globs: ["**/*.tsx", "**/*.jsx"],
      condition: ["ARRAY_GLOBS"],
      interruptMode: "prose-only",
      content: "ARRAY-GLOBS-RULE",
    });
    expect(rules.get("tool-mode")).toMatchObject({
      condition: ["TOOL_MODE"],
      interruptMode: "tool-only",
    });
    expect(rules.get("always-mode")).toMatchObject({
      condition: ["ALWAYS_MODE"],
      interruptMode: "always",
    });
    expect(rules.get("omp-defaults")).toMatchObject({ condition: ["DEFAULT_MODE"] });
    expect(rules.get("omp-defaults")?.globs).toBeUndefined();
    expect(rules.get("omp-defaults")?.interruptMode).toBeUndefined();
    expect(JSON.stringify(snapshot.rules)).not.toContain("MALFORMED-RULE");
    expect(JSON.stringify(snapshot.rules)).not.toContain("MUTATED-AFTER-BIND");

    const stored = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      snapshot: { rules: Array<Record<string, unknown>> };
    };
    stored.snapshot.rules[0]!.interruptMode = ["always"];
    writeFileSync(snapshotPath, JSON.stringify(stored), { mode: 0o600 });
    await expect(readPiProjectSnapshot({
      sessionDir,
      conversationId: "typed-rules",
      generation: bound.generation,
      root: project,
      identity: await store.assertTrusted(project),
    })).rejects.toMatchObject({ code: "project_snapshot_invalid", status: 500 });
  });

  it("warning-skips invalid UTF-8 instructions, skills, and project MCP bytes", async () => {
    const { project } = fixture();
    const invalidSkill = join(project, ".omp", "skills", "invalid");
    const validSkill = join(project, ".omp", "skills", "valid");
    mkdirSync(invalidSkill, { recursive: true });
    mkdirSync(validSkill, { recursive: true });
    writeFileSync(
      join(project, ".omp", "AGENTS.md"),
      Buffer.concat([Buffer.from("INVALID-INSTRUCTION-"), Buffer.from([0x80])]),
    );
    writeFileSync(join(project, "AGENTS.md"), "VALID-FALLBACK-INSTRUCTION");
    writeFileSync(
      join(invalidSkill, "SKILL.md"),
      Buffer.concat([
        Buffer.from("---\nname: invalid\ndescription: invalid bytes\n---\n\nINVALID-SKILL-"),
        Buffer.from([0x80]),
      ]),
    );
    writeFileSync(
      join(validSkill, "SKILL.md"),
      "---\nname: valid\ndescription: valid sibling\n---\n\nVALID-SKILL-BODY",
    );
    writeFileSync(
      join(project, ".omp", "mcp.json"),
      Buffer.concat([
        Buffer.from('{"mcpServers":{"invalid":{"type":"stdio","command":"INVALID-MCP-'),
        Buffer.from([0x80]),
        Buffer.from('"}}}'),
      ]),
    );

    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });

    expect(snapshot.contextFiles).toEqual([
      { path: join(project, "AGENTS.md"), content: "VALID-FALLBACK-INSTRUCTION" },
    ]);
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["valid"]);
    expect(snapshot.resources).toMatchObject({ instructions: 1, skills: 1, mcpServers: 0 });
    expect(snapshot.mcp.servers).toEqual([]);
    expect(snapshot.mcp.skipped).toContainEqual({
      path: ".omp/mcp.json",
      reason: "MCP config was rejected by the bounded project scan.",
    });
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(".omp/AGENTS.md was ignored because it is not valid UTF-8"),
      expect.stringContaining(".omp/skills/invalid/SKILL.md was ignored because it is not valid UTF-8"),
      expect.stringContaining(".omp/mcp.json was ignored because it is not valid UTF-8"),
    ]));
    expect(snapshot.mcpWarnings).toContainEqual(
      expect.stringContaining(".omp/mcp.json was ignored because it is not valid UTF-8"),
    );
    expect(JSON.stringify(snapshot.contextFiles)).toContain("VALID-FALLBACK-INSTRUCTION");
    expect(JSON.stringify(snapshot.skills)).toContain("VALID-SKILL-BODY");
    expect(JSON.stringify({
      contextFiles: snapshot.contextFiles,
      skills: snapshot.skills,
    })).not.toContain("\uFFFD");
  });

  it("bounds wide previews, rejects symlink resources, and traces only pinned paths", async () => {
    const { root, project } = fixture();
    const rules = join(project, ".omp", "rules");
    mkdirSync(rules, { recursive: true });
    for (let index = 0; index < PROJECT_SCAN_MAX_ENTRIES + 50; index += 1) {
      writeFileSync(join(rules, `rule-${index}.md`), `rule ${index}`);
    }
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "stolen.md"), "must not open");
    symlinkSync(outside, join(project, ".claude"));
    const opened: string[] = [];
    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: false,
      traceOpen: (path) => opened.push(path),
    });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.resources.rules).toBeLessThanOrEqual(PROJECT_SCAN_MAX_ENTRIES);
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("entry limit"),
      expect.stringContaining("symbolic"),
    ]));
    expect(opened.some((path) => path.includes("outside") || path.includes("stolen"))).toBe(false);
  });

  it("never admits a project file beyond the positional byte cap", async () => {
    const { project } = fixture();
    writeFileSync(join(project, "AGENTS.md"), "x".repeat(PROJECT_SCAN_MAX_FILE_BYTES + 1));
    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });
    expect(snapshot.resources.instructions).toBe(0);
    expect(snapshot.contextFiles).toEqual([]);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warnings).toContainEqual(expect.stringContaining("256 KiB"));
  });

  it("rejects project MCP files above the per-file cap from the immutable snapshot", async () => {
    const { project } = fixture();
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(
      join(project, ".omp", "mcp.json"),
      JSON.stringify({
        mcpServers: { oversized: { type: "stdio", command: "never" } },
        padding: "x".repeat(PROJECT_SCAN_MAX_FILE_BYTES),
      }),
    );

    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });

    expect(snapshot.resources.mcpServers).toBe(0);
    expect(snapshot.mcp.servers).toEqual([]);
    expect(snapshot.mcp.skipped).toEqual([
      {
        path: ".omp/mcp.json",
        reason: "MCP config was rejected by the bounded project scan.",
      },
    ]);
    expect(snapshot.warnings).toContainEqual(expect.stringContaining("256 KiB"));
  });

  it("admits fixed MCP before broad entry exhaustion", async () => {
    const { project } = fixture();
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { pinned: { type: "stdio", command: "pinned-command" } },
    }));
    for (let index = 0; index < PROJECT_SCAN_MAX_ENTRIES + 20; index += 1) {
      writeFileSync(join(project, ".omp", "rules", `wide-${index}.md`), `rule ${index}`);
    }
    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.mcp.servers.map((server) => server.name)).toEqual(["pinned"]);
    expect(snapshot.mcpWarnings).toEqual([]);
    expect(snapshot.resources.mcpServers).toBe(1);
    expect(snapshot.warnings).toContainEqual(expect.stringContaining("entry limit"));
  });

  it("admits fixed MCP before broad byte exhaustion", async () => {
    const { project } = fixture();
    mkdirSync(join(project, ".omp", "rules"), { recursive: true });
    mkdirSync(join(project, ".omp", "prompts"), { recursive: true });
    mkdirSync(join(project, ".omp", "commands"), { recursive: true });
    mkdirSync(join(project, ".omp", "skills", "large"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { pinned: { type: "stdio", command: "pinned-command" } },
    }));
    const skillPrefix = "---\nname: large\ndescription: large\n---\n";
    const skillBody = "x".repeat(
      PROJECT_SCAN_MAX_FILE_BYTES - Buffer.byteLength(skillPrefix),
    );
    const body = "x".repeat(PROJECT_SCAN_MAX_FILE_BYTES);
    writeFileSync(
      join(project, ".omp", "skills", "large", "SKILL.md"),
      `${skillPrefix}${skillBody}`,
    );
    writeFileSync(join(project, ".omp", "rules", "large.md"), body);
    writeFileSync(join(project, ".omp", "prompts", "large.md"), body);
    writeFileSync(join(project, ".omp", "commands", "large.md"), body);

    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.mcp.servers.map((server) => server.name)).toEqual(["pinned"]);
    expect(snapshot.mcpWarnings).toEqual([]);
    expect(snapshot.warnings).toContainEqual(expect.stringContaining("project byte limit"));
    expect(PROJECT_SCAN_MAX_BYTES).toBeGreaterThan(PROJECT_SCAN_MAX_FILE_BYTES);
  });

  it("admits fixed MCP before the cooperative deadline is exhausted by broad discovery", async () => {
    const { project } = fixture();
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: { pinned: { type: "stdio", command: "pinned-command" } },
    }));
    let reads = 0;
    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
      now: () => reads++ < 5 ? 0 : 1_000,
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.mcp.servers.map((server) => server.name)).toEqual(["pinned"]);
    expect(snapshot.mcpWarnings).toEqual([]);
    expect(snapshot.warnings).toContainEqual(expect.stringContaining("time limit"));
  });

  it("keeps exact validated MCP rows from one bounded scan", async () => {
    const { project } = fixture();
    mkdirSync(join(project, ".omp"), { recursive: true });
    const path = join(project, ".omp", "mcp.json");
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        pinned: { type: "stdio", command: "first", args: ["one"] },
        malformed: { type: "stdio" },
      },
    }));

    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });
    writeFileSync(path, JSON.stringify({
      mcpServers: { replacement: { type: "stdio", command: "second" } },
    }));

    expect(snapshot.mcp.servers.map((server) => server.name))
      .toEqual(["pinned"]);
    expect(snapshot.mcp.claimedNames).toEqual(["pinned", "malformed"]);
    expect(snapshot.mcp.servers[0]?.config).toEqual({
      type: "stdio",
      command: "first",
      args: ["one"],
    });
    expect(snapshot.mcp.skipped).toContainEqual(expect.objectContaining({
      path: ".omp/mcp.json#mcpServers.malformed",
    }));
    expect(snapshot.resources.mcpServers).toBe(1);
    expect(snapshot.mcpWarnings).toContainEqual(expect.stringContaining("malformed"));
    expect(snapshot.mcp.servers.some((server) => server.name === "replacement")).toBe(false);
  });

  it("persists malformed project MCP claims without admitting or hiding a valid sibling", async () => {
    const { sessionDir, project, store } = fixture();
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        valid: { type: "stdio", command: "valid-command" },
        malformed: null,
      },
    }));
    const initial = await store.read(sessionDir, "pi:mcp-rows", "pi", "mcp-rows");
    const preview = await store.preview("pi", "mcp-rows", project);
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "mcp-rows",
      current: initial,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const bound = await store.read(sessionDir, "pi:mcp-rows", "pi", "mcp-rows");
    const snapshot = await readPiProjectSnapshot({
      sessionDir,
      conversationId: "mcp-rows",
      generation: bound.generation,
      root: project,
      identity: await store.assertTrusted(project),
    });
    expect(snapshot.mcp.servers.map((server) => server.name)).toEqual(["valid"]);
    expect(snapshot.mcp.claimedNames).toEqual(["valid", "malformed"]);
    expect(snapshot.mcp.servers[0]?.errors).toEqual([]);
    expect(snapshot.mcp.skipped).toContainEqual(expect.objectContaining({
      path: ".omp/mcp.json#mcpServers.malformed",
    }));
    expect(snapshot.resources.mcpServers).toBe(1);
    expect(bound).toMatchObject({ status: "degraded", mcpStatus: "degraded" });
  });

  it("keeps disabled and malformed canonical names claimed while admitting valid siblings", async () => {
    const { project } = fixture();
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify({
      mcpServers: {
        valid: { type: "stdio", command: "valid" },
        disabled: { enabled: false, type: "stdio", command: "disabled" },
        malformed: { type: "stdio" },
      },
    }));
    writeFileSync(join(project, ".omp", ".mcp.json"), JSON.stringify({
      mcpServers: {
        disabled: { type: "stdio", command: "must-not-reactivate" },
        malformed: { type: "stdio", command: "must-not-repair" },
        legacy_only: { type: "stdio", command: "legacy" },
      },
    }));

    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });
    expect(snapshot.mcp.claimedNames)
      .toEqual(["valid", "disabled", "malformed", "legacy_only"]);
    expect(snapshot.mcp.servers.map((server) => server.name))
      .toEqual(["valid", "legacy_only"]);
    expect(snapshot.mcp.skipped).toEqual([
      expect.objectContaining({ path: ".omp/mcp.json#mcpServers.malformed" }),
    ]);
    expect(snapshot.resources.mcpServers).toBe(2);
    expect(snapshot.mcpWarnings).toHaveLength(1);
  });

  it.each(["pi", "claude-code"] as const)(
    "reports admitted MCP counts and initial health truthfully for %s bindings",
    async (runtime) => {
      const { sessionDir, project, store } = fixture();
      mkdirSync(join(project, ".omp"), { recursive: true });
      const config = join(project, ".omp", "mcp.json");
      writeFileSync(config, JSON.stringify({
        mcpServers: {
          disabled: { enabled: false, type: "stdio", command: "disabled" },
        },
      }));
      const id = `mcp-health-${runtime}`;
      const initial = await store.read(sessionDir, `${runtime}:${id}`, runtime, id);
      let preview = await store.preview(runtime, id, project);
      expect(preview.resources.mcpServers).toBe(0);
      expect(preview.warnings).not.toContainEqual(expect.stringContaining("disabled"));
      await store.write({
        sessionDir,
        runtime,
        conversationId: id,
        current: initial,
        root: project,
        trustToken: preview.trustToken,
        reason: "bound",
      });
      let state = await store.read(sessionDir, `${runtime}:${id}`, runtime, id);
      expect(state).toMatchObject({
        status: "ready",
        mcpStatus: "off",
        resources: { mcpServers: 0 },
      });

      writeFileSync(config, JSON.stringify({
        mcpServers: {
          valid: { type: "stdio", command: "valid" },
          malformed: { type: "stdio" },
        },
      }));
      preview = await store.preview(runtime, id, project);
      expect(preview.resources.mcpServers).toBe(1);
      expect(preview.warnings).toContainEqual(expect.stringContaining("malformed"));
      await store.write({
        sessionDir,
        runtime,
        conversationId: id,
        current: state,
        root: project,
        cwd: project,
        reason: "reloaded",
      });
      state = await store.read(sessionDir, `${runtime}:${id}`, runtime, id);
      expect(state).toMatchObject({
        status: "degraded",
        mcpStatus: "degraded",
        resources: { mcpServers: 1 },
        error: { code: "project_mcp_degraded" },
      });
    },
  );

  it("measures the scan depth from the project root", async () => {
    const { project } = fixture();
    const rules = join(project, ".omp", "rules");
    const acceptedParts = Array.from(
      { length: PROJECT_SCAN_MAX_DEPTH - 3 },
      (_, index) => `accepted-${index}`,
    );
    const accepted = join(rules, ...acceptedParts);
    mkdirSync(accepted, { recursive: true });
    writeFileSync(join(accepted, "at-limit.md"), "accepted");
    const rejected = join(accepted, "too-deep");
    mkdirSync(rejected);
    writeFileSync(join(rejected, "past-limit.md"), "rejected");

    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });
    expect(snapshot.resources.rules).toBe(1);
    expect(snapshot.rules.map((rule) => rule.name)).toEqual(["at-limit"]);
    expect(snapshot.warnings).toContainEqual(expect.stringContaining("project depth limit"));
  });

  it("revokes preview receipts across raw conversation id reuse", async () => {
    const { sessionDir, project, store } = fixture();
    const first = await store.preview("pi", "reused", project, "casper");
    const revocation = await store.beginRevocation(sessionDir, "casper", "pi", "reused");
    const current = await store.read(sessionDir, "pi:reused", "pi", "reused");
    await expect(store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "reused",
      current,
      root: project,
      trustToken: first.trustToken,
      reason: "bound",
      scope: "casper",
    })).rejects.toMatchObject({ code: "trust_token_invalid" });
    revocation.rollback();

    const second = await store.preview("pi", "reused", project, "casper");
    await expect(store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "reused",
      current,
      root: project,
      trustToken: second.trustToken,
      reason: "bound",
      scope: "casper",
    })).resolves.toBeUndefined();
  });

  it("admits exactly one project instruction file in Pi provider precedence", async () => {
    const { project } = fixture();
    writeFileSync(join(project, "CLAUDE.md"), "root claude");
    writeFileSync(join(project, "AGENTS.md"), "root agents");
    mkdirSync(join(project, ".agents"), { recursive: true });
    writeFileSync(join(project, ".agents", "AGENTS.md"), "agents provider");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "CLAUDE.md"), "claude provider");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "AGENTS.md"), "omp provider");

    const snapshot = await loadProjectDeclarativeSnapshot(project, {
      level: "project",
      includeContents: true,
    });
    expect(snapshot.resources.instructions).toBe(1);
    expect(snapshot.contextFiles).toEqual([
      { path: join(project, ".omp", "AGENTS.md"), content: "omp provider" },
    ]);
  });

  it.each([".agents", ".claude", ".pi", ".omp"])(
    "excludes the %s compatibility provider from a Ghost/user snapshot",
    async (provider) => {
      const { project: ghostHome } = fixture();
      const hiddenSkill = join(ghostHome, provider, "skills", "hidden");
      mkdirSync(hiddenSkill, { recursive: true });
      writeFileSync(
        join(hiddenSkill, "SKILL.md"),
        "---\nname: hidden\ndescription: hidden\n---\n\nHIDDEN-COMPATIBILITY-PROVIDER",
      );
      if (provider === ".agents") {
        writeFileSync(join(ghostHome, provider, "AGENTS.md"), "HIDDEN-AGENTS-INSTRUCTION");
      }
      if (provider === ".claude") {
        writeFileSync(join(ghostHome, provider, "CLAUDE.md"), "HIDDEN-CLAUDE-INSTRUCTION");
      }
      if (provider === ".omp") {
        writeFileSync(join(ghostHome, provider, "AGENTS.md"), "HIDDEN-OMP-INSTRUCTION");
        writeFileSync(join(ghostHome, provider, "mcp.json"), JSON.stringify({
          mcpServers: { hidden: { type: "stdio", command: "never" } },
        }));
      }
      const opened: string[] = [];

      const snapshot = await loadProjectDeclarativeSnapshot(ghostHome, {
        level: "user",
        includeContents: true,
        traceOpen: (path) => opened.push(path),
      });

      expect(snapshot.resources).toEqual({
        instructions: 0,
        skills: 0,
        rules: 0,
        prompts: 0,
        commands: 0,
        agents: 0,
        mcpServers: 0,
        ignoredExecutable: 0,
      });
      expect(snapshot.contextFiles).toEqual([]);
      expect(snapshot.skills).toEqual([]);
      expect(snapshot.rules).toEqual([]);
      expect(snapshot.promptTemplates).toEqual([]);
      expect(snapshot.slashCommands).toEqual([]);
      expect(snapshot.mcp).toEqual({ claimedNames: [], disabled: [], servers: [], skipped: [] });
      expect(opened.some((path) => path.includes(provider))).toBe(false);
    },
  );

  it("persists a canonical contained cwd, one-time trust, and rejects symlink escape", async () => {
    const { root, sessionDir, project, store } = fixture();
    const child = join(project, "packages", "app");
    mkdirSync(child, { recursive: true });
    const current = await store.read(sessionDir, "pi:draft", "pi", "draft");
    const preview = await store.preview("pi", "draft", project);
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "draft",
      current,
      root: project,
      cwd: child,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const bound = await store.read(sessionDir, "pi:draft", "pi", "draft");
    expect(bound).toMatchObject({
      root: project,
      cwd: child,
      relativeCwd: "packages/app",
      generation: 1,
      reason: "bound",
    });
    expect(statSync(projectBindingPath(sessionDir, "pi", "draft")).mode & 0o777).toBe(0o600);
    const snapshotPath = piProjectSnapshotPath(sessionDir, "draft", bound.generation);
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    const identity = await store.assertTrusted(project);
    const pinned = await readPiProjectSnapshot({
      sessionDir,
      conversationId: "draft",
      generation: bound.generation,
      root: project,
      identity,
    });
    expect(pinned.resources).toEqual(bound.resources);
    expect(statSync(store.trustPath).mode & 0o777).toBe(0o600);

    await expect(store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "draft",
      current: bound,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    })).rejects.toMatchObject({ code: "trust_token_invalid" });

    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(project, "escape"));
    await expect(store.writeOperationalCwd(
      sessionDir,
      "pi",
      "draft",
      bound,
      join(project, "escape"),
    )).rejects.toMatchObject({ code: "cwd_outside_project" });

    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "draft",
      current: bound,
      root: project,
      cwd: child,
      reason: "reloaded",
    });
    expect((await store.read(sessionDir, "pi:draft", "pi", "draft"))).toMatchObject({
      generation: 2,
      reason: "reloaded",
    });
  });

  it("never overwrites trusted roots after a failed ledger read and succeeds on explicit retry", async () => {
    const { root, sessionDir, project, store } = fixture();
    const second = join(root, "second-project");
    mkdirSync(second);
    const firstCurrent = await store.read(sessionDir, "claude-code:first", "claude-code", "first");
    const firstPreview = await store.preview("claude-code", "first", project);
    await store.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "first",
      current: firstCurrent,
      root: project,
      trustToken: firstPreview.trustToken,
      reason: "bound",
    });
    const original = readFileSync(store.trustPath);
    const originalLedger = JSON.parse(original.toString("utf8")) as {
      roots: Array<{ root: string; dev: string; ino: string; trustedAt: string }>;
    };
    const originalRoot = originalLedger.roots.find((row) => row.root === project);
    expect(originalRoot).toBeDefined();

    const secondCurrent = await store.read(
      sessionDir,
      "claude-code:second",
      "claude-code",
      "second",
    );
    const failedPreview = await store.preview("claude-code", "second", second);
    chmodSync(store.trustPath, 0o644);
    await expect(store.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "second",
      current: secondCurrent,
      root: second,
      trustToken: failedPreview.trustToken,
      reason: "bound",
    })).rejects.toMatchObject({ code: "project_trust_invalid", status: 500 });
    expect(readFileSync(store.trustPath)).toEqual(original);
    expect(await store.read(sessionDir, "claude-code:second", "claude-code", "second"))
      .toMatchObject({ root: null, generation: 0 });

    chmodSync(store.trustPath, 0o600);
    const retryPreview = await store.preview("claude-code", "second", second);
    await store.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "second",
      current: secondCurrent,
      root: second,
      trustToken: retryPreview.trustToken,
      reason: "bound",
    });
    await expect(store.assertTrusted(project)).resolves.toMatchObject({ root: project });
    await expect(store.assertTrusted(second)).resolves.toMatchObject({ root: second });
    const retried = JSON.parse(readFileSync(store.trustPath, "utf8")) as typeof originalLedger;
    expect(retried.roots).toContainEqual(originalRoot);
    expect(retried.roots.map((row) => row.root).sort()).toEqual([project, second].sort());
  });

  it("keeps the default trust ledger inside the test-only XDG state home", async () => {
    const { ownerHome, sessionDir, project } = fixture();
    const isolatedStateHome = process.env.GHOST_TEST_XDG_STATE_HOME;
    expect(isolatedStateHome).toBeTruthy();
    expect(process.env.XDG_STATE_HOME).toBe(isolatedStateHome);
    const fallbackPath = join(ownerHome, ".local", "state", "ghost", "project-trust.json");
    const sentinel = Buffer.from("LIVE-FALLBACK-LEDGER-MUST-NOT-BE-OPENED\n");
    mkdirSync(dirname(fallbackPath), { recursive: true });
    writeFileSync(fallbackPath, sentinel, { mode: 0o600 });
    const store = new ProjectBindingStore({ ownerHome });
    expect(store.trustPath).toBe(join(isolatedStateHome!, "ghost", "project-trust.json"));
    expect(store.trustPath).not.toBe(fallbackPath);
    const current = await store.read(
      sessionDir,
      "claude-code:isolated-default",
      "claude-code",
      "isolated-default",
    );
    const preview = await store.preview("claude-code", "isolated-default", project);

    await store.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "isolated-default",
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });

    expect(readFileSync(fallbackPath)).toEqual(sentinel);
    await expect(store.assertTrusted(project)).resolves.toMatchObject({ root: project });
  });

  it("serializes concurrent trust writes globally across store instances", async () => {
    const { root, ownerHome, sessionDir, project, store } = fixture();
    const secondProject = join(root, "second-project");
    mkdirSync(secondProject);
    const secondStore = new ProjectBindingStore({ ownerHome, trustPath: store.trustPath });
    const [firstCurrent, secondCurrent, firstPreview, secondPreview] = await Promise.all([
      store.read(sessionDir, "claude-code:global-first", "claude-code", "global-first"),
      secondStore.read(sessionDir, "claude-code:global-second", "claude-code", "global-second"),
      store.preview("claude-code", "global-first", project),
      secondStore.preview("claude-code", "global-second", secondProject),
    ]);

    await Promise.all([
      store.write({
        sessionDir,
        runtime: "claude-code",
        conversationId: "global-first",
        current: firstCurrent,
        root: project,
        trustToken: firstPreview.trustToken,
        reason: "bound",
      }),
      secondStore.write({
        sessionDir,
        runtime: "claude-code",
        conversationId: "global-second",
        current: secondCurrent,
        root: secondProject,
        trustToken: secondPreview.trustToken,
        reason: "bound",
      }),
    ]);

    await expect(store.assertTrusted(project)).resolves.toMatchObject({ root: project });
    await expect(secondStore.assertTrusted(secondProject))
      .resolves.toMatchObject({ root: secondProject });
    const ledger = JSON.parse(readFileSync(store.trustPath, "utf8")) as { roots: TestTrustRow[] };
    expect(ledger.roots.map((row) => row.root).sort())
      .toEqual([project, secondProject].sort());
  });

  it("publishes a valid trust ledger at the inclusive one-MiB boundary", async () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    const { sessionDir, project, store } = fixture(() => now);
    const projectRow = filesystemTrustRow(project, now);
    const roots = trustRowsForSerializedSize(PROJECT_TRUST_MAX_BYTES, [projectRow]);
    const priorBytes = trustLedgerBytes(roots);
    expect(priorBytes.byteLength).toBeLessThan(PROJECT_TRUST_MAX_BYTES);
    mkdirSync(dirname(store.trustPath), { recursive: true });
    writeFileSync(store.trustPath, priorBytes, { mode: 0o600 });
    const current = await store.read(
      sessionDir,
      "claude-code:trust-boundary",
      "claude-code",
      "trust-boundary",
    );
    const preview = await store.preview("claude-code", "trust-boundary", project);

    await store.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "trust-boundary",
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });

    const published = readFileSync(store.trustPath);
    expect(published).toEqual(trustLedgerBytes([...roots, projectRow]));
    expect(published).toHaveLength(PROJECT_TRUST_MAX_BYTES);
    await expect(store.assertTrusted(project)).resolves.toMatchObject({ root: project });
  });

  it("preserves the global ledger and recovers after a one-byte-overflow write", async () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    const { ownerHome, sessionDir, project, store } = fixture(() => now);
    const projectRow = filesystemTrustRow(project, now);
    const roots = trustRowsForSerializedSize(PROJECT_TRUST_MAX_BYTES + 1, [projectRow]);
    const original = trustLedgerBytes(roots);
    expect(original.byteLength).toBeLessThanOrEqual(PROJECT_TRUST_MAX_BYTES);
    mkdirSync(dirname(store.trustPath), { recursive: true });
    writeFileSync(store.trustPath, original, { mode: 0o600 });
    const current = await store.read(
      sessionDir,
      "claude-code:trust-overflow",
      "claude-code",
      "trust-overflow",
    );
    const preview = await store.preview("claude-code", "trust-overflow", project);

    await expect(store.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "trust-overflow",
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    })).rejects.toMatchObject({ code: "project_trust_invalid", status: 500 });
    expect(readFileSync(store.trustPath)).toEqual(original);
    await expect(store.assertTrusted(project))
      .rejects.toMatchObject({ code: "project_not_trusted", status: 403 });
    expect(statSync(projectBindingPath(sessionDir, "claude-code", "trust-overflow"), {
      throwIfNoEntry: false,
    })).toBeUndefined();

    const retainedRoots = roots.slice(1);
    writeFileSync(store.trustPath, trustLedgerBytes(retainedRoots), { mode: 0o600 });
    const retryStore = new ProjectBindingStore({ ownerHome, trustPath: store.trustPath, now: () => now });
    const retryPreview = await retryStore.preview("claude-code", "trust-overflow", project);
    await retryStore.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "trust-overflow",
      current,
      root: project,
      trustToken: retryPreview.trustToken,
      reason: "bound",
    });
    expect(readFileSync(store.trustPath))
      .toEqual(trustLedgerBytes([...retainedRoots, projectRow]));
    await expect(retryStore.assertTrusted(project)).resolves.toMatchObject({ root: project });
  });

  it("preserves and retries a writer candidate beyond the exact row-count bound", async () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    const { ownerHome, sessionDir, project, store } = fixture(() => now);
    const timestamp = new Date(now).toISOString();
    const roots = Array.from(
      { length: PROJECT_TRUST_MAX_ROOTS },
      (_, index): TestTrustRow => ({
        root: `/${index}`,
        dev: "1",
        ino: "1",
        trustedAt: timestamp,
      }),
    );
    const original = compactTrustLedgerBytes(roots);
    expect(original.byteLength).toBeLessThan(PROJECT_TRUST_MAX_BYTES);
    mkdirSync(dirname(store.trustPath), { recursive: true });
    writeFileSync(store.trustPath, original, { mode: 0o600 });
    const current = await store.read(
      sessionDir,
      "claude-code:trust-count-overflow",
      "claude-code",
      "trust-count-overflow",
    );
    const preview = await store.preview("claude-code", "trust-count-overflow", project);

    await expect(store.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "trust-count-overflow",
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    })).rejects.toMatchObject({ code: "project_trust_invalid", status: 500 });
    expect(readFileSync(store.trustPath)).toEqual(original);
    await expect(store.assertTrusted(project))
      .rejects.toMatchObject({ code: "project_not_trusted", status: 403 });

    const retainedRoots = roots.slice(1);
    writeFileSync(store.trustPath, compactTrustLedgerBytes(retainedRoots), { mode: 0o600 });
    const retryStore = new ProjectBindingStore({ ownerHome, trustPath: store.trustPath, now: () => now });
    const retryPreview = await retryStore.preview(
      "claude-code",
      "trust-count-overflow",
      project,
    );
    await retryStore.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "trust-count-overflow",
      current,
      root: project,
      trustToken: retryPreview.trustToken,
      reason: "bound",
    });
    const retried = JSON.parse(readFileSync(store.trustPath, "utf8")) as { roots: TestTrustRow[] };
    expect(retried.roots).toHaveLength(PROJECT_TRUST_MAX_ROOTS);
    expect(retried.roots.slice(0, -1)).toEqual(retainedRoots);
    expect(retried.roots.at(-1)).toEqual(filesystemTrustRow(project, now));
  });

  it("enforces exact trust root, identity, and ledger-count bounds", async () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    const { project, store } = fixture(() => now);
    const projectRow = filesystemTrustRow(project, now);
    const timestamp = new Date(now).toISOString();
    const boundaryRows: TestTrustRow[] = [
      projectRow,
      {
        root: paddingTrustRoot(0, PROJECT_TRUST_ROOT_MAX_BYTES),
        dev: "9".repeat(64),
        ino: "8".repeat(64),
        trustedAt: timestamp,
      },
    ];
    mkdirSync(dirname(store.trustPath), { recursive: true });
    writeFileSync(store.trustPath, trustLedgerBytes(boundaryRows), { mode: 0o600 });
    await expect(store.assertTrusted(project)).resolves.toMatchObject({ root: project });

    const countBoundary = [projectRow, ...Array.from(
      { length: PROJECT_TRUST_MAX_ROOTS - 1 },
      (_, index): TestTrustRow => ({
        root: `/trust-count/${index}`,
        dev: String(index + 1),
        ino: String(index + 10_000),
        trustedAt: timestamp,
      }),
    )];
    const exactCountBytes = compactTrustLedgerBytes(countBoundary);
    expect(exactCountBytes.byteLength).toBeLessThan(PROJECT_TRUST_MAX_BYTES);
    writeFileSync(store.trustPath, exactCountBytes, { mode: 0o600 });
    await expect(store.assertTrusted(project)).resolves.toMatchObject({ root: project });

    const invalidLedgers: TestTrustRow[][] = [
      [projectRow, {
        ...boundaryRows[1]!,
        root: `${paddingTrustRoot(1, PROJECT_TRUST_ROOT_MAX_BYTES)}x`,
      }],
      [projectRow, { ...boundaryRows[1]!, dev: "7".repeat(65) }],
      [projectRow, { ...boundaryRows[1]!, ino: "00" }],
      [...countBoundary, {
        root: "/trust-count/overflow",
        dev: "1",
        ino: "1",
        trustedAt: timestamp,
      }],
    ];
    for (const roots of invalidLedgers) {
      const bytes = compactTrustLedgerBytes(roots);
      expect(bytes.byteLength).toBeLessThan(PROJECT_TRUST_MAX_BYTES);
      writeFileSync(store.trustPath, bytes, { mode: 0o600 });
      await expect(store.assertTrusted(project))
        .rejects.toMatchObject({ code: "project_trust_invalid", status: 500 });
      expect(readFileSync(store.trustPath)).toEqual(bytes);
    }
  });

  it("fails closed for malformed, wrong-version, invalid-byte, oversized, linked, and unreadable ledgers", async () => {
    const { sessionDir, project, store } = fixture();
    const current = await store.read(sessionDir, "claude-code:strict", "claude-code", "strict");
    const preview = await store.preview("claude-code", "strict", project);
    await store.write({
      sessionDir,
      runtime: "claude-code",
      conversationId: "strict",
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const valid = readFileSync(store.trustPath);
    const invalidUtf8 = Buffer.from(valid);
    const trustedAt = invalidUtf8.indexOf(Buffer.from("trustedAt"));
    expect(trustedAt).toBeGreaterThanOrEqual(0);
    invalidUtf8[trustedAt + "trustedAt".length + 4] = 0x80;
    const invalidLedgers = [
      Buffer.from("{broken"),
      Buffer.from(`${JSON.stringify({ version: 2, roots: [] })}\n`),
      Buffer.from(`${JSON.stringify({ version: 1, roots: [{ root: project }] })}\n`),
      invalidUtf8,
      Buffer.alloc(PROJECT_TRUST_MAX_BYTES + 1, 0x20),
    ];
    for (const bytes of invalidLedgers) {
      writeFileSync(store.trustPath, bytes, { mode: 0o600 });
      await expect(store.assertTrusted(project))
        .rejects.toMatchObject({ code: "project_trust_invalid", status: 500 });
      expect(readFileSync(store.trustPath)).toEqual(bytes);
    }

    writeFileSync(store.trustPath, valid, { mode: 0o600 });
    const realLedger = `${store.trustPath}.real`;
    renameSync(store.trustPath, realLedger);
    symlinkSync(realLedger, store.trustPath);
    await expect(store.assertTrusted(project))
      .rejects.toMatchObject({ code: "project_trust_invalid", status: 500 });
    expect(readFileSync(realLedger)).toEqual(valid);
    rmSync(store.trustPath, { force: true });
    renameSync(realLedger, store.trustPath);

    const stateDirectory = dirname(store.trustPath);
    chmodSync(stateDirectory, 0o000);
    try {
      await expect(store.assertTrusted(project))
        .rejects.toMatchObject({ code: "project_trust_invalid", status: 500 });
    } finally {
      chmodSync(stateDirectory, 0o700);
    }
    expect(readFileSync(store.trustPath)).toEqual(valid);
    await expect(store.assertTrusted(project)).resolves.toMatchObject({ root: project });
  });

  it("keeps the committed Pi generation when a replacement snapshot cannot publish", async () => {
    const { sessionDir, project, store } = fixture();
    writeFileSync(join(project, "AGENTS.md"), "PINNED-FIRST");
    const initial = await store.read(sessionDir, "pi:atomic", "pi", "atomic");
    const preview = await store.preview("pi", "atomic", project);
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "atomic",
      current: initial,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const committed = await store.read(sessionDir, "pi:atomic", "pi", "atomic");
    writeFileSync(join(project, "AGENTS.md"), "UNPUBLISHED-SECOND");
    mkdirSync(piProjectSnapshotPath(sessionDir, "atomic", committed.generation + 1));

    await expect(store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "atomic",
      current: committed,
      root: project,
      cwd: project,
      reason: "reloaded",
    })).rejects.toThrow();

    expect(await store.read(sessionDir, "pi:atomic", "pi", "atomic"))
      .toMatchObject({ generation: committed.generation, root: project });
    const pinned = await readPiProjectSnapshot({
      sessionDir,
      conversationId: "atomic",
      generation: committed.generation,
      root: project,
      identity: await store.assertTrusted(project),
    });
    expect(pinned.contextFiles).toEqual([
      { path: join(project, "AGENTS.md"), content: "PINNED-FIRST" },
    ]);
    expect(JSON.stringify(pinned.contextFiles)).not.toContain("UNPUBLISHED-SECOND");
  });

  it("fails closed on a missing or corrupt immutable Pi snapshot", async () => {
    const { sessionDir, project, store } = fixture();
    writeFileSync(join(project, "AGENTS.md"), "PINNED-UTF8-CONTENT");
    const initial = await store.read(sessionDir, "pi:corrupt", "pi", "corrupt");
    const preview = await store.preview("pi", "corrupt", project);
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "corrupt",
      current: initial,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const bound = await store.read(sessionDir, "pi:corrupt", "pi", "corrupt");
    const identity = await store.assertTrusted(project);
    const path = piProjectSnapshotPath(sessionDir, "corrupt", bound.generation);
    const original = readFileSync(path);
    const invalidUtf8 = Buffer.from(original);
    const marker = invalidUtf8.indexOf(Buffer.from("PINNED-UTF8-CONTENT"));
    expect(marker).toBeGreaterThanOrEqual(0);
    invalidUtf8[marker + "PINNED-".length] = 0x80;
    writeFileSync(path, invalidUtf8, { mode: 0o600 });
    await expect(readPiProjectSnapshot({
      sessionDir,
      conversationId: "corrupt",
      generation: bound.generation,
      root: project,
      identity,
    })).rejects.toMatchObject({ code: "project_snapshot_invalid", status: 500 });

    writeFileSync(path, original, { mode: 0o600 });
    await expect(readPiProjectSnapshot({
      sessionDir,
      conversationId: "corrupt",
      generation: bound.generation,
      root: project,
      identity,
    })).resolves.toMatchObject({ contextFiles: [expect.objectContaining({
      content: "PINNED-UTF8-CONTENT",
    })] });

    writeFileSync(path, "{broken", { mode: 0o600 });
    await expect(readPiProjectSnapshot({
      sessionDir,
      conversationId: "corrupt",
      generation: bound.generation,
      root: project,
      identity,
    })).rejects.toMatchObject({ code: "project_snapshot_invalid", status: 500 });
    rmSync(path);
    await expect(readPiProjectSnapshot({
      sessionDir,
      conversationId: "corrupt",
      generation: bound.generation,
      root: project,
      identity,
    })).rejects.toMatchObject({ code: "project_snapshot_invalid", status: 500 });
  });

  it("binds receipts to one conversation, expires them, and notices inode replacement", async () => {
    let now = 1_000;
    const { root, project, store } = fixture(() => now);
    const preview = await store.preview("pi", "one", project);
    const otherHome = join(root, "other-ghost", "sessions");
    mkdirSync(otherHome, { recursive: true });
    const other = await store.read(otherHome, "pi:two", "pi", "two");
    await expect(store.write({
      sessionDir: otherHome,
      runtime: "pi",
      conversationId: "two",
      current: other,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    })).rejects.toMatchObject({ code: "trust_token_invalid" });

    const expired = await store.preview("pi", "two", project);
    now += 10 * 60_000;
    await expect(store.write({
      sessionDir: otherHome,
      runtime: "pi",
      conversationId: "two",
      current: other,
      root: project,
      trustToken: expired.trustToken,
      reason: "bound",
    })).rejects.toMatchObject({ code: "trust_token_expired" });

    now += 1;
    const valid = await store.preview("pi", "two", project);
    await store.write({
      sessionDir: otherHome,
      runtime: "pi",
      conversationId: "two",
      current: other,
      root: project,
      trustToken: valid.trustToken,
      reason: "bound",
    });
    renameSync(project, `${project}.old`);
    mkdirSync(project);
    chmodSync(project, 0o700);
    await expect(store.assertTrusted(project)).rejects.toMatchObject({ code: "project_not_trusted" });
    await expect(store.read(otherHome, "pi:two", "pi", "two"))
      .rejects.toMatchObject({ code: "project_not_trusted" });
  });

  it("does not transfer a preview receipt between ghost scopes", async () => {
    const { sessionDir, project, store } = fixture();
    const preview = await store.preview("pi", "shared-id", project, "first-ghost");
    const current = await store.read(sessionDir, "pi:shared-id", "pi", "shared-id");
    await expect(store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "shared-id",
      current,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
      scope: "second-ghost",
    })).rejects.toMatchObject({ code: "trust_token_invalid" });
  });

  it("serializes concurrent trust writes without losing either filesystem identity", async () => {
    const { root, sessionDir, store } = fixture();
    const first = join(root, "concurrent-first");
    const second = join(root, "concurrent-second");
    mkdirSync(first);
    mkdirSync(second);
    const [firstPreview, secondPreview, firstCurrent, secondCurrent] = await Promise.all([
      store.preview("pi", "first", first),
      store.preview("pi", "second", second),
      store.read(sessionDir, "pi:first", "pi", "first"),
      store.read(sessionDir, "pi:second", "pi", "second"),
    ]);
    await Promise.all([
      store.write({
        sessionDir,
        runtime: "pi",
        conversationId: "first",
        current: firstCurrent,
        root: first,
        trustToken: firstPreview.trustToken,
        reason: "bound",
      }),
      store.write({
        sessionDir,
        runtime: "pi",
        conversationId: "second",
        current: secondCurrent,
        root: second,
        trustToken: secondPreview.trustToken,
        reason: "bound",
      }),
    ]);

    await expect(store.assertTrusted(first)).resolves.toMatchObject({ root: first });
    await expect(store.assertTrusted(second)).resolves.toMatchObject({ root: second });
  });

  it("publishes runtime MCP status only against the exact trusted binding generation", async () => {
    const { sessionDir, project, store } = fixture();
    const initial = await store.read(sessionDir, "pi:status", "pi", "status");
    const preview = await store.preview("pi", "status", project);
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "status",
      current: initial,
      root: project,
      trustToken: preview.trustToken,
      reason: "bound",
    });
    const first = await store.read(sessionDir, "pi:status", "pi", "status");
    await store.write({
      sessionDir,
      runtime: "pi",
      conversationId: "status",
      current: first,
      root: project,
      reason: "reloaded",
    });

    await expect(store.updateRuntimeStatus(
      sessionDir,
      "pi",
      "status",
      first,
      {
        status: "degraded",
        error: { code: "stale", message: "stale callback" },
        mcpStatus: "degraded",
      },
    )).resolves.toBe(false);
    expect(await store.read(sessionDir, "pi:status", "pi", "status"))
      .toMatchObject({ generation: 2, status: "ready", error: null });
  });
});
