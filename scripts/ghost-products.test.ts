import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadCatalog, renderSkill, skillPath } from "./ghost-products";

test("the ghost-products table is the catalog (run bun scripts/ghost-products.ts)", () => {
  const skill = readFileSync(skillPath, "utf8");
  expect(skill).toBe(renderSkill(skill, loadCatalog()));
});

test("every catalog entry says how to get it, and each section it names exists", () => {
  const skill = readFileSync(skillPath, "utf8");
  for (const p of loadCatalog()) {
    expect(p.install ?? p.section, p.name).toBeDefined();
    if (p.section) expect(skill, p.name).toContain(`\n## ${p.section}\n`);
  }
});
