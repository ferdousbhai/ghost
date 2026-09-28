import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadDeclarativeSnapshot } from "../src/declarative-resources.js";
import { mergeDeclarativeSnapshots, renderPiDeclarativePrompt } from "@ghost/runtime/declarative-snapshot";
import { parseFrontmatter } from "../src/declarative-types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "ghost-resources-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}
const skill = (description: string, extra = "") => `---\nname: example\ndescription: ${description}\n${extra}---\nExact skill body\n`;

it("admits only explicit resources and retains immutable skill bytes", async () => {
  const bytes = skill("Useful skill");
  const root = await fixture({ "AGENTS.md": "primary", "CLAUDE.md": "fallback", "README.md": "ordinary data", "skills/example/SKILL.md": bytes, "skills/example/notes.md": "not a skill", "rules/bad.md": "---\n- invalid\n---\nbody", "skills/missing/SKILL.md": "---\nname: missing\n---\nbody" });
  const snapshot = await loadDeclarativeSnapshot(root, { level: "user" });
  await writeFile(join(root, "skills/example/SKILL.md"), "changed after admission");
  expect(snapshot.contextFiles).toEqual([{ path: join(root, "AGENTS.md"), content: "primary" }]);
  expect(snapshot.skills).toHaveLength(1);
  expect(snapshot.skills[0]).toMatchObject({ name: "example", snapshotContent: bytes, baseDir: join(root, "skills/example") });
  expect(snapshot.rules).toEqual([]);
  expect(snapshot.warnings).toHaveLength(2);
  expect(JSON.stringify(snapshot)).not.toContain("ordinary data");
});

it("does not follow linked resources or linked roots", async () => {
  const outside = await fixture({ "secret.md": "outside instructions" });
  const root = await fixture({ "CLAUDE.md": "fallback", "rules/local.md": "local" });
  await symlink(join(outside, "secret.md"), join(root, "AGENTS.md"));
  await symlink(outside, join(root, "skills"));
  const snapshot = await loadDeclarativeSnapshot(root, { level: "user" });
  expect(snapshot.contextFiles[0]?.content).toBe("fallback");
  expect(snapshot.skills).toEqual([]);
  expect(snapshot.warnings).toHaveLength(2);
  const linkedRoot = join(root, "linked");
  await symlink(outside, linkedRoot);
  await expect(loadDeclarativeSnapshot(linkedRoot, { level: "user" })).rejects.toMatchObject({ code: "invalid_resource_root" });
});

it("preserves precedence, hidden skills and conditional rule visibility", async () => {
  const machine = await fixture({ "skills/a/SKILL.md": skill("machine"), "prompts/do.md": "machine prompt" });
  const root = await fixture({
    "skills/a/SKILL.md": skill("earlier"), "skills/z/SKILL.md": skill("hidden", "hide: true\n"),
    "rules/always.md": "---\nalwaysApply: true\n---\nAlways body",
    "rules/conditional.md": "---\nalwaysApply: true\ncondition: test\n---\nConditional body",
    "rules/discover.md": "---\ndescription: discover me\nglobs: ['*.ts']\n---\nDiscover body",
    "rules/disabled.md": "---\nalwaysApply: true\n---\nDisabled body",
    "prompts/do.md": "---\ndescription: custom description\n---\nuser prompt",
    "commands/do.md": "Command first line\nrest",
  });
  const snapshot = mergeDeclarativeSnapshots([await loadDeclarativeSnapshot(machine, { level: "native" }), await loadDeclarativeSnapshot(root, { level: "user" })]);
  expect(snapshot.skills).toHaveLength(1);
  expect(snapshot.skills[0]?.description).toBe("hidden");
  expect(snapshot.promptTemplates[0]).toMatchObject({ name: "do", content: "user prompt", description: "custom description (user:ghost-pinned)" });
  expect(snapshot.slashCommands[0]).toMatchObject({ name: "do", description: "Command first line" });
  const prompt = renderPiDeclarativePrompt(snapshot, { disabledRules: ["disabled"] });
  expect(prompt).toContain("Always body");
  expect(prompt).toContain("discover (*.ts): discover me");
  for (const excluded of ["Conditional body", "Disabled body", "Discover body", "## Skills"]) expect(prompt).not.toContain(excluded);
});

it("uses Pi's BOM/newline handling and rejects non-mapping metadata", () => {
  expect(parseFrontmatter("\uFEFF---\r\nname: test\r\n---\r\n body \r\n")).toEqual({ frontmatter: { name: "test" }, body: "body" });
  expect(() => parseFrontmatter("---\n- item\n---\nbody")).toThrow("Frontmatter must be a mapping.");
  expect(() => parseFrontmatter("---\nname: [broken\n---\nbody")).toThrow();
});
