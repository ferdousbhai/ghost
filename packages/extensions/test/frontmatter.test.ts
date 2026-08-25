import { describe, expect, it } from "vitest";
import {
  parseDocument,
  parseFrontmatterLines,
  renderDocument,
  splitFrontmatter,
  yamlFlowList,
  yamlScalar,
} from "../src/frontmatter.js";
import { GhostError } from "../src/errors.js";

describe("yamlScalar", () => {
  it("leaves safe plain scalars unquoted", () => {
    expect(yamlScalar("Paper notes")).toBe("Paper notes");
    expect(yamlScalar("craft/paper-notes")).toBe("craft/paper-notes");
  });

  it("quotes values YAML would read back as something else", () => {
    expect(yamlScalar("true")).toBe('"true"');
    expect(yamlScalar("42")).toBe('"42"');
    expect(yamlScalar("no")).toBe('"no"');
    expect(yamlScalar("")).toBe('""');
    expect(yamlScalar(" leading")).toBe('" leading"');
  });

  it("escapes quotes, backslashes, and newlines", () => {
    expect(yamlScalar('say "hi"')).toBe('"say \\"hi\\""');
    expect(yamlScalar("a\nb")).toBe('"a\\nb"');
  });
});

describe("splitFrontmatter", () => {
  it("keeps the body byte-for-byte", () => {
    const body = "  leading spaces\n\nand a trailing newline\n";
    const text = renderDocument(["title: Example"], body);
    expect(splitFrontmatter(text).body).toBe(body);
  });

  it("consumes exactly one separator newline", () => {
    const body = "\nbody that starts with a blank line";
    expect(splitFrontmatter(renderDocument(["title: Example"], body)).body).toBe(body);
  });

  it("treats a document without frontmatter as all body", () => {
    const split = splitFrontmatter("# Just a note\n");
    expect(split.hadFrontmatter).toBe(false);
    expect(split.body).toBe("# Just a note\n");
    expect(split.lines).toEqual([]);
  });

  it("tolerates CRLF frontmatter", () => {
    const parsed = parseDocument("---\r\narchived: true\r\n---\r\n\r\nbody\r\n");
    expect(parsed.frontmatter["archived"]).toBe(true);
    expect(parsed.body).toBe("body\r\n");
  });

  it("rejects unterminated frontmatter", () => {
    expect(() => splitFrontmatter("---\ntitle: Example\n")).toThrow(GhostError);
  });
});

describe("parseFrontmatterLines", () => {
  it("parses the export's vocabulary", () => {
    const record = parseFrontmatterLines([
      'title: "Restoring the Vandercook 4: notes"',
      "tags: [paper, press]",
      "archived: true",
      "path: Craft/Paper: notes",
    ]);
    expect(record).toEqual({
      title: "Restoring the Vandercook 4: notes",
      tags: ["paper", "press"],
      archived: true,
      path: "Craft/Paper: notes",
    });
  });

  it("keeps unknown keys so a newer app's documents round-trip", () => {
    expect(parseFrontmatterLines(["future: 7"])["future"]).toBe(7);
  });

  it("handles quoted list items containing commas", () => {
    expect(parseFrontmatterLines(['tags: ["one, two", three]'])["tags"])
      .toEqual(["one, two", "three"]);
  });

  it("rejects a line that is not key: value", () => {
    expect(() => parseFrontmatterLines(["nonsense"])).toThrow(GhostError);
  });
});

describe("round trip", () => {
  it("re-renders a document produced by the hosted export unchanged", () => {
    const original = [
      "---",
      'title: "Restoring the Vandercook 4: notes"',
      "tags: [paper, press]",
      "---",
      "",
      "The carriage was frozen.\n",
    ].join("\n");
    const split = splitFrontmatter(original);
    expect(renderDocument(split.lines, split.body)).toBe(original);
  });

  it("round-trips a flow list through write and read", () => {
    const line = `tags: ${yamlFlowList(["a b", "c,d"])}`;
    expect(parseFrontmatterLines([line])["tags"]).toEqual(["a b", "c,d"]);
  });
});

describe("cross-check against pi's YAML frontmatter parser", () => {
  // Our writer is hand-rolled, so the values it emits must still be valid YAML
  // as pi (and any other reader of these files) understands it.
  it("emits scalars pi reads back unchanged", async () => {
    const { parseFrontmatter } = await import("@oh-my-pi/pi-utils/frontmatter");
    const values = [
      "Paper notes",
      "Restoring the Vandercook 4: notes",
      'say "hi"',
      "true",
      "42",
      "  padded  ",
      "line\nbreak",
      "back\\slash",
      "#hash",
      "- dash",
    ];
    for (const value of values) {
      const text = renderDocument([`title: ${yamlScalar(value)}`], "body");
      expect(
        (parseFrontmatter(text).frontmatter as { title: string }).title,
        JSON.stringify(value),
      ).toBe(value);
      expect(parseFrontmatterLines([`title: ${yamlScalar(value)}`])["title"]).toBe(value);
    }
  });

  it("emits tag lists pi reads back unchanged", async () => {
    const { parseFrontmatter } = await import("@oh-my-pi/pi-utils/frontmatter");
    const tags = ["paper", "press work", "one, two", "3"];
    const text = renderDocument([`tags: ${yamlFlowList(tags)}`], "body");
    expect((parseFrontmatter(text).frontmatter as { tags: string[] }).tags).toEqual(tags);
    expect(parseFrontmatterLines([`tags: ${yamlFlowList(tags)}`])["tags"]).toEqual(tags);
  });
});
