import { chmodSync, existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GhostError } from "../src/errors.js";
import { listSource, listSources, pictureOf, readSource, searchSources, type SourceContext } from "../src/sources.js";
import { listConnections } from "../src/connections.js";
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

  it("lists notes newest first across folders, and reminders as one item per list, with no product installed", async () => {
    const context = owner({});
    // Nothing exists yet: Ghost's own folders are still sources, just empty.
    expect(listSources(context).filter((row) => row.id === "notes" || row.id === "reminders").map((row) => row.available)).toEqual([true, true]);
    expect(await listSource("notes", context, 10, null)).toEqual({ items: [], next: null });
    expect(await listSource("reminders", context, 10, null)).toEqual({ items: [], next: null });

    const notes = join(context.home, "Documents", "Notes");
    const reminders = join(context.home, "Documents", "Reminders");
    mkdirSync(join(notes, "Trips", ".icloud-notes"), { recursive: true });
    mkdirSync(reminders, { recursive: true });
    const old = join(notes, "Old.md");
    const fresh = join(notes, "Trips", "New.md");
    writeFileSync(old, "# Old\n\nfirst line\n");
    // As icloud-notes leaves a synced note: its id header on top.
    writeFileSync(fresh, "---\napple-note-id: 1234\n---\n\n# New\n\nThe boat leaves at nine.\n");
    writeFileSync(join(notes, "Trips", ".icloud-notes", "state.md"), "not a note");
    utimesSync(old, at("2026-01-01") / 1000, at("2026-01-01") / 1000);
    utimesSync(fresh, at("2026-06-01") / 1000, at("2026-06-01") / 1000);
    writeFileSync(join(reminders, "Groceries.md"), "- [ ] Milk\n- [x] Eggs\n- [ ] Bread\n");

    const listed = (await listSource("notes", context, 10, null)).items;
    expect(listed.map((item) => [item.title, item.snippet])).toEqual([["New", "The boat leaves at nine."], ["Old", "first line"]]);
    expect(await readSource({ source: "notes", id: fresh }, context)).toMatchObject({ text: "# New\n\nThe boat leaves at nine.\n", part: "whole" });
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
    expect(summary.find((row) => row.id === "mail")).toEqual({ id: "mail", label: "Mail", available: true, list: true, read: true, search: true, pictures: false });
    expect(summary.find((row) => row.id === "photos")?.available).toBe(false);
    await expect(listSource("photos", context, 10, null)).rejects.toMatchObject({ code: "source_unavailable", status: 409 });
    await expect(listSource("files", context, 10, null)).rejects.toMatchObject({ code: "not_listable", status: 405 });
    await expect(listSource("nope", context, 10, null)).rejects.toBeInstanceOf(GhostError);
  });

  it("hands a product a query or an id as a value, never as an option", async () => {
    // Each stand-in answers only when what follows `--` is the value alone.
    const context = owner({
      cloudmail: [
        `case "$*" in`,
        `  "search --quiet -n 8 -- -n 9999") printf '[{"id":"t1","subject":"found","snippet":"x","from":{"name":"A"},"last_at":1}]' ;;`,
        `  "thread read --quiet -- --all") printf '{"thread":{"subject":"read"},"messages":[]}' ;;`,
        `  *) echo "taken as an option: $*" >&2; exit 2 ;;`,
        `esac`,
      ].join("\n"),
      "icloud-photos": `[ "$*" = "info --quiet -- --data-dir=/x" ] && printf '{"filename":"a.jpg","created":"2026-11-13T06:40:22Z","kind":"photo","width":4032,"height":3024,"size":2100000,"albums":[{"id":"a1","name":"Trip"}]}' || exit 2`,
    });
    const found = await searchSources("-n 9999", context, { sources: ["mail"] });
    expect(found).toEqual({ items: [expect.objectContaining({ id: "t1", title: "found" })], failed: [] });
    expect((await readSource({ source: "mail", id: "--all" }, context)).title).toBe("read");
    expect(await readSource({ source: "photos", id: "--data-dir=/x" }, context)).toEqual({
      title: "a.jpg", part: "whole",
      text: "Taken: 2026-11-13T06:40:22Z\nKind: photo, 4032×3024, 2.1 MB\nAlbums: Trip\nNot downloaded to this computer.",
    });
  });

  it("serves a photo's thumbnail only when the file the product names is a picture", async () => {
    const context = owner({ "icloud-photos": `printf '{"id":"%s","path":"%s"}' "$4" "$HOME/$4"` });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    writeFileSync(join(context.home, "p1"), jpeg);
    writeFileSync(join(context.home, "secret"), "token=abc");
    expect(await pictureOf("photos", "p1", context)).toEqual({ type: "image/jpeg", bytes: jpeg });
    await expect(pictureOf("photos", "secret", context)).rejects.toMatchObject({ code: "not_found" });
    await expect(pictureOf("photos", "missing", context)).rejects.toMatchObject({ code: "not_found" });
    await expect(pictureOf("notes", "p1", context)).rejects.toMatchObject({ code: "no_pictures", status: 405 });
    expect(listSources(context).filter((source) => source.pictures).map((source) => source.id)).toEqual(["photos"]);
  });

  it("says what is missing, what is signed out and what is connected, with the product's own next step", async () => {
    const context = owner({
      "icloud-session": `printf '{"signed_in":false}'`,
      "cloud-calendar": `printf '{"accounts":[{"label":"Home","provider":"icloud","ok":true},{"label":"Work","provider":"google","ok":false}]}'`,
      wacli: "exit 1",
    });
    const rows = Object.fromEntries((await listConnections(context)).map((row) => [row.id, row]));
    expect(Object.keys(rows)).toEqual(["search", "icloud", "mail", "calendar", "contacts", "google", "google-drive", "google-workspace", "whatsapp", "lastbook"]);
    expect(rows.mail).toMatchObject({ state: "missing", actions: [{ label: "Install", command: "curl -fsSL https://ferdousbhai.com/cloudmail/install.sh | sudo bash" }] });
    expect(rows.icloud).toMatchObject({ state: "disconnected", detail: "", actions: [{ label: "Sign in", command: "icloud-session sign-in" }] });
    expect(rows.calendar).toMatchObject({ state: "connected", detail: "Home, Work (needs sign-in)" });
    expect(rows.calendar?.actions.map((action) => action.command)).toContain("cloud-calendar account add google");
    expect(rows.whatsapp).toMatchObject({ state: "disconnected", actions: [{ label: "Link WhatsApp", command: "wacli auth" }] });
  });

  it("connects Google through its own tools: the phone sign-in, rclone's remote, and gws", async () => {
    const signedOut = owner({
      "google-session": `printf '{"signed_in":false}'; exit 1`,
      rclone: `[ "$*" = "listremotes --type drive --json" ] && printf '[]'`,
      gws: `echo 'Using keyring backend: keyring' >&2; printf '{"client_config_exists":true,"has_refresh_token":true,"token_valid":false}'`,
    });
    const before = Object.fromEntries((await listConnections(signedOut)).map((row) => [row.id, row]));
    expect(before.google).toMatchObject({ state: "disconnected", actions: [{ label: "Sign in", command: "google-session sign-in" }] });
    expect(before["google-drive"]).toMatchObject({ state: "disconnected", actions: [{ label: "Connect", command: "rclone config create gdrive drive scope=drive" }] });
    expect(before["google-workspace"]).toMatchObject({ state: "disconnected", detail: "The sign-in expired.", actions: [{ label: "Sign in again", command: "gws auth login -s tasks,drive,docs,sheets,slides" }] });

    const signedIn = owner({
      "google-session": `printf '{"signed_in":true,"email":"me@example.com"}'`,
      rclone: `printf '[{"name":"gdrive","type":"drive"}]'`,
      gws: `printf '{"client_config_exists":true,"has_refresh_token":true,"token_valid":true}'`,
    });
    const after = Object.fromEntries((await listConnections(signedIn)).map((row) => [row.id, row]));
    expect(after.google).toMatchObject({ state: "connected", detail: "me@example.com", actions: [] });
    expect(after["google-drive"]).toMatchObject({ state: "connected", detail: "gdrive", actions: [] });
    expect(after["google-workspace"]).toMatchObject({ state: "connected", detail: "", actions: [] });

    const ended = Object.fromEntries((await listConnections(owner({ "google-session": `printf '{"signed_in":true,"email":"me@example.com","rejected":true}'; exit 1` }))).map((row) => [row.id, row]));
    expect(ended.google).toMatchObject({ state: "disconnected", detail: "Google ended the sign-in of me@example.com.", actions: [{ label: "Sign in again", command: "google-session sign-in" }] });

    const bare = Object.fromEntries((await listConnections(owner({ gws: `printf '{"client_config_exists":false}'` }))).map((row) => [row.id, row]));
    expect(bare["google-workspace"]?.actions).toEqual([{ label: "Set up", command: "gws auth setup" }]);
    expect(bare["google-drive"]).toMatchObject({ state: "missing", actions: [{ label: "Install", command: "omarchy pkg add rclone" }] });
  });

  it("lists Keep notes and Google Photos, and reads a Drive file, from what the Google tools keep here", async () => {
    const context = owner({
      "google-photos": [
        `case "$*" in`,
        `  "list --limit 5000 --quiet") printf '[{"id":"g1","filename":"IMG_1.HEIC","created":"2026-11-13T06:40:22Z","kind":"photo","width":4032,"height":3024,"local_path":null}]' ;;`,
        `  "info --quiet -- g1") printf '{"filename":"IMG_1.HEIC","created":"2026-11-13T06:40:22Z","kind":"photo","width":4032,"height":3024,"size":2100000,"place":"Helsinki","local_path":null}' ;;`,
        `  *) exit 2 ;;`,
        `esac`,
      ].join("\n"),
    });
    const note = join(context.home, "Documents", "Keep", "Archive", "Packing.md");
    const sheet = join(context.home, "Google Drive", "plan.txt");
    for (const [path, text] of [[note, "Passport\nCharger\n"], [sheet, "the plan\n"]] as const) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    }
    expect((await listSource("keep", context, 10, null)).items).toEqual([expect.objectContaining({ source: "keep", id: note, title: "Packing", snippet: "Passport" })]);
    expect((await readSource({ source: "keep", id: note }, context)).text).toBe("Passport\nCharger\n");
    await expect(readSource({ source: "keep", id: sheet }, context)).rejects.toMatchObject({ code: "not_found" });
    expect((await readSource({ source: "google-drive", id: sheet }, context)).text).toBe("the plan\n");
    expect((await listSource("google-photos", context, 10, null)).items).toEqual([
      { source: "google-photos", id: "g1", title: "IMG_1.HEIC", snippet: "photo · 4032×3024", at: at("2026-11-13T06:40:22Z") },
    ]);
    expect((await readSource({ source: "google-photos", id: "g1" }, context)).text)
      .toBe("Taken: 2026-11-13T06:40:22Z\nKind: photo, 4032×3024, 2.1 MB\nPlace: Helsinki\nNot downloaded to this computer.");
    await expect(pictureOf("google-photos", "g1", context)).rejects.toMatchObject({ code: "no_pictures" });
  });

  it("names a failing source and still returns the others", async () => {
    const context = owner({
      cloudmail: "echo 'worker unreachable' >&2; exit 5",
      "cloud-contacts": `printf '%s' '[{"id":"p1","name":"Sara","company":"Emy Terra","phones":[{"value":"+1 555"}]}]'`,
    });
    const result = await searchSources("Sara", context, { sources: ["mail", "contacts"] });
    expect(result.items).toEqual([expect.objectContaining({ source: "contacts", title: "Sara", snippet: "Emy Terra · +1 555" })]);
    expect(result.failed).toEqual([{ source: "mail", message: expect.stringContaining("worker unreachable") }]);
  });
});
