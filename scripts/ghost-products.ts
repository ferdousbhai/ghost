// The ghost-products skill's product table is rendered from products.json,
// the one catalog of recommended products. `bun scripts/ghost-products.ts`
// rewrites the table; the test fails while the two differ.
import { readFileSync, writeFileSync } from "node:fs";

export type Product = {
  need: string;
  name: string;
  source: string;
  cli: string;
  skill?: string;
  install?: string;
  note?: string;
  section?: string;
};

const dir = new URL("../skills/ghost-products/", import.meta.url);
export const catalogPath = new URL("products.json", dir);
export const skillPath = new URL("SKILL.md", dir);
const BEGIN = "<!-- products: generated from products.json by scripts/ghost-products.ts -->";
const END = "<!-- /products -->";

export function loadCatalog(): Product[] {
  return (JSON.parse(readFileSync(catalogPath, "utf8")) as { products: Product[] }).products;
}

/** Inline code in a table cell: a pipe would end the cell. */
const code = (s: string) => `\`${s.replaceAll("|", "\\|")}\``;

export function renderTable(products: Product[]): string {
  const rows = products.map((p) => {
    const ids = p.skill && p.skill !== p.cli ? `${code(p.cli)}, skill ${code(p.skill)}` : code(p.cli);
    const install = [
      p.install ? code(p.install) : "",
      p.note ?? "",
      p.section ? `see [${p.section}](#${p.section.toLowerCase()})` : "",
    ].filter(Boolean).join("; ");
    return `| ${p.need} | [${p.name}](${p.source}) (${ids}) | ${install} |`;
  });
  return ["| Need | Product (`<cli>`, skill) | Install the product |", "| --- | --- | --- |", ...rows].join("\n");
}

/** SKILL.md with its table replaced by one rendered from the catalog. */
export function renderSkill(skill: string, products: Product[]): string {
  const start = skill.indexOf(BEGIN);
  const end = skill.indexOf(END);
  if (start < 0 || end < start) throw new Error(`SKILL.md needs the ${BEGIN} … ${END} markers`);
  return `${skill.slice(0, start + BEGIN.length)}\n${renderTable(products)}\n${skill.slice(end)}`;
}

if (import.meta.main) {
  writeFileSync(skillPath, renderSkill(readFileSync(skillPath, "utf8"), loadCatalog()));
}
