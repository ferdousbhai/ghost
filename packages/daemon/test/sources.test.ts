import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GhostError } from "../src/errors.js";
import { listSource, listSources, readSource, searchSources, type SourceContext } from "../src/sources.js";
import { tempDir } from "./helpers/fixtures.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

/**
 * A scratch owner home with the products' folders and stand-in CLIs first on
 * PATH, so no test reads the owner's real data or reaches a network.
 */
function owner(tools: Record<string, string>): SourceContext & { home: string } {
  const home = tempDir();
  const bin = tempDir();
  cleanups.push(home.cleanup, bin.cleanup);
  // Only the search tools Omarchy ships, so a product CLI installed on the
  // test machine never stands in for a missing one.
  for (const name of ["rg", "fd", "fzf"]) {
    if (existsSync(`/usr/bin/${name}`)) symlinkSync(`/usr/bin/${name}`, join(bin.path, name));
  }
  for (const [name, body] of Object.entries(tools)) {
    const path = join(bin.path, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return {
    home: home.path,
    env: { HOME: home.path, XDG_DOCUMENTS_DIR: join(home.path, "Documents"), PATH: bin.path },
    signal: new AbortController().signal,
  };
}

const at = (iso: string) => Date.parse(iso);

describe("sources", () => {
  it("labels a file hit with the source whose folder holds it", async () => {
    const context = owner({});
    const chat = join(context.home, "WhatsApp", "+1", "WhatsApp Chat - Sara", "_chat.txt");
    const note = join(context.home, "Documents", "Notes", "boat.md");
    const loose = join(context.home, "Downloads", "boat.txt");
    for (const path of [chat, note, loose]) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "the boat leaves at nine\n");
    }
    const recall = [
      `case "$1" in`,
      `  search) printf '%s' '{"hits":[{"path":"${note}","excerpt":"boat","modified":1700000000},{"path":"${chat}","excerpt":"boat"}]}' ;;`,
      `  config) printf '%s' '{"roots":["${context.home}"]}' ;;`,
      `esac`,
    ].join("\n");
    const withRecall = owner({ recall });
    const sameHome = { ...withRecall, home: context.home, env: { ...withRecall.env, HOME: context.home, XDG_DOCUMENTS_DIR: join(context.home, "Documents") } };

    const { items } = await searchSources("boat", sameHome, { sources: ["files"] });
    expect(items.map((item) => [item.source, item.title])).toEqual(expect.arrayContaining([
      ["notes", "boat.md"],
      ["whatsapp", "Sara"],
      ["files", "boat.txt"],
    ]));
    expect(items.find((item) => item.source === "notes")?.at).toBe(1_700_000_000_000);
    // One source's search is the shared index cut to that source's folder.
    expect((await searchSources("boat", sameHome, { sources: ["whatsapp"] })).items.map((item) => item.title)).toEqual(["Sara"]);
  });

  it("reads only files inside the folders Ghost searches", async () => {
    const context = owner({ recall: `printf '%s' '{"roots":["'"$HOME"'/Documents"],"excluded_folders":["'"$HOME"'/Documents/private"]}'` });
    mkdirSync(join(context.home, "Documents", "private"), { recursive: true });
    writeFileSync(join(context.home, "Documents", "plan.md"), "the plan");
    writeFileSync(join(context.home, "Documents", "private", "key.md"), "secret");
    writeFileSync(join(context.home, "outside.md"), "outside");

    expect(await readSource({ source: "files", id: join(context.home, "Documents", "plan.md") }, context))
      .toMatchObject({ text: "the plan", part: "whole" });
    for (const path of [join(context.home, "outside.md"), join(context.home, "Documents", "private", "key.md"), join(context.home, "Documents", "..", "outside.md")]) {
      await expect(readSource({ source: "files", id: path }, context)).rejects.toMatchObject({ code: "not_found", status: 404 });
    }
  });

  it("pages mail with cloudmail's own --before cursor", async () => {
    const thread = (id: string, last: number) => `{"id":"${id}","subject":"s${id}","snippet":"x","from":{"name":"A"},"last_at":${last}}`;
    const context = owner({
      cloudmail: [
        `case "$*" in`,
        `  *--before\\ 2000*) printf '[%s]' '${thread("c", 1000)}' ;;`,
        `  inbox*) printf '[%s,%s,%s]' '${thread("a", 3000)}' '${thread("b", 2000)}' '${thread("c", 1000)}' ;;`,
        `esac`,
      ].join("\n"),
    });
    const first = await listSource("mail", context, 2, null);
    expect(first.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(first.next).toBe("2000");
    const second = await listSource("mail", context, 2, first.next);
    expect(second).toEqual({ items: [expect.objectContaining({ id: "c", title: "sc", at: 1000 })], next: null });
  });

  it("lists notes newest first across folders, and reminders as one item per list", async () => {
    const context = owner({
      "icloud-notes": `printf '%s' '[{"id":"n1","path":"/v/a.md","title":"Old","modified_ms":${at("2026-01-01")}},{"id":"n2","path":"/v/b.md","title":"New","modified_ms":${at("2026-06-01")}}]'`,
    });
    const reminders = join(context.home, "Documents", "Reminders");
    mkdirSync(reminders, { recursive: true });
    writeFileSync(join(reminders, "Groceries.md"), "- [ ] Milk\n- [x] Eggs\n- [ ] Bread\n");

    expect((await listSource("notes", context, 10, null)).items.map((item) => item.title)).toEqual(["New", "Old"]);
    const chat = join(context.home, "WhatsApp", "+1", "WhatsApp Chat - Sara", "_chat.txt");
    mkdirSync(join(chat, ".."), { recursive: true });
    writeFileSync(chat, "[1/1/26, 09:00:00] Sara: first\n[1/2/26, 10:00:00] Sara: latest\n");
    expect((await listSource("whatsapp", context, 10, null)).items).toEqual([expect.objectContaining({ id: chat, title: "Sara", snippet: "+1" })]);
    expect(await readSource({ source: "whatsapp", id: chat }, context)).toMatchObject({ part: "latest", text: expect.stringContaining("Sara: latest") });
    await expect(readSource({ source: "whatsapp", id: join(context.home, "Documents", "x.md") }, context)).rejects.toMatchObject({ code: "not_found" });
    expect((await listSource("reminders", context, 10, null)).items).toEqual([
      expect.objectContaining({ source: "reminders", title: "Groceries", snippet: "2 open: Milk" }),
    ]);
  });

  it("says what a source cannot do, and which sources are set up", async () => {
    const context = owner({ cloudmail: "printf '[]'" });
    const summary = listSources(context);
    expect(summary.find((row) => row.id === "mail")).toEqual({ id: "mail", label: "Mail", available: true, list: true, read: true, search: true });
    expect(summary.find((row) => row.id === "photos")?.available).toBe(false);
    await expect(listSource("photos", context, 10, null)).rejects.toMatchObject({ code: "source_unavailable", status: 409 });
    await expect(listSource("files", context, 10, null)).rejects.toMatchObject({ code: "not_listable", status: 405 });
    await expect(listSource("nope", context, 10, null)).rejects.toBeInstanceOf(GhostError);
  });

  it("names a failing source and still returns the others", async () => {
    const context = owner({
      cloudmail: "echo 'worker unreachable' >&2; exit 5",
      "icloud-contacts": `printf '%s' '[{"id":"p1","name":"Sara","company":"Emy Terra","phones":[{"value":"+1 555"}]}]'`,
    });
    const result = await searchSources("Sara", context, { sources: ["mail", "contacts"] });
    expect(result.items).toEqual([expect.objectContaining({ source: "contacts", title: "Sara", snippet: "Emy Terra · +1 555" })]);
    expect(result.failed).toEqual([{ source: "mail", message: expect.stringContaining("worker unreachable") }]);
  });
});
