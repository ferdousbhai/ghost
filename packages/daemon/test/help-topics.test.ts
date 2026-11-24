import { describe, expect, it } from "vitest";
import { PRODUCTS } from "../src/help-guides.js";
import { HELP_TOPICS, isHelpTopic, renderHelpTopic } from "../src/help-topics.js";

describe("ghost help products", () => {
  it("tables every product but Ghost, each saying how to get it, and each section it points at exists", () => {
    const text = renderHelpTopic("products");
    for (const product of PRODUCTS) {
      if (product.host) {
        expect(text, product.name).not.toContain(`[${product.name}](`);
        continue;
      }
      expect(text, product.name).toContain(`[${product.name}](${product.source})`);
      expect(product.install ?? product.section, product.name).toBeDefined();
      if (product.section) expect(text, product.name).toContain(`\n## ${product.section}\n`);
    }
  });
});

describe("ghost help topics", () => {
  it("knows its topics", () => {
    expect(HELP_TOPICS).toEqual(["self", "background", "memory", "dictation", "notifications", "browser", "products"]);
    expect(isHelpTopic("self")).toBe(true);
    expect(isHelpTopic("status")).toBe(false);
  });

  it("self: follows repository rules and restarts without a model prompt", () => {
    const text = renderHelpTopic("self");
    expect(text).toContain("AGENTS.md and CONTRACTS.md");
    expect(text).toContain("preserve other sessions' edits");
    expect(text).toContain('systemctl --user restart ghostd.service');
    expect(text).toContain('journalctl --user -t ghostd');
    expect(text).not.toContain('ghost say');
    expect(text).not.toContain('git restore');
    expect(text).not.toContain('branch from upstream master');
  });

  it("background: the detached recipe that wakes the conversation", () => {
    const text = renderHelpTopic("background");
    expect(text).toContain("systemd-run --user --scope --quiet --unit=\"ghost-job-<name>-$(date +%s)\" -p CPUWeight=20");
    expect(text).toContain("setsid -f bash -c");
    expect(text).toContain("$XDG_RUNTIME_DIR/<name>.log");
    expect(text).not.toContain("/tmp/job.log");
    expect(text).toContain("`systemctl --user stop <unit>` ends it");
    expect(text).toContain("ghost say --follow-up");
    expect(text).toContain("`$GHOST_SESSION` is set");
    expect(text).toContain("A command you start ends when this turn does.");
  });

  it("memory: exact search first, Recall for unknown wording, the source file over any index", () => {
    const text = renderHelpTopic("memory");
    expect(text).toContain("`rg -n -i '<term>'` in `Notes` and `Reminders`");
    expect(text).toContain("They are yours to keep whether or not iCloud syncs them");
    expect(text).toContain("`Reminders/<List>.md`, `- [ ] text 📅 YYYY-MM-DD`");
    expect(text).toContain("Recall through its `recall` skill");
    expect(text).toContain("without it, use filenames and `rg`");
    expect(text).toContain("then the source file itself before relying on one");
    expect(text).toContain("whenever a task needs them, from the first turn on");
    expect(text).toContain("keep both claims and tell the owner which is uncertain");
    expect(text).toContain("dead end (what was tried, why it failed)");
    expect(text).toContain("dating what you add");
    expect(text).toContain("Tidying, only when the owner asks, is the one time you read a folder whole");
    expect(text).toContain("Trash with `gio trash`, never `rm`");
    expect(text).toContain("keep its original restorable: `cp -p \"$f\" \"$f~\" && gio trash \"$f~\"`");
    expect(text).toContain("mark a superseded fact with what replaced it and when");
    expect(text).toContain("only an empty note or a duplicate you merged. Then report each changed and trashed path");
    expect(text).toContain("Never preload the directory, read it wholesale, or keep an index or memory store of your own");
    expect(text).toContain("A Recall index over folders the owner chose, the whole directory included, is theirs to search");
    expect(text).toContain("save its steps, commands, and pitfalls as a how-to");
    expect(text).not.toContain("SKILL.md");
  });

  it("dictation: transcribes audio with the installed Voxtype and toggles spoken submit only on request", () => {
    const text = renderHelpTopic("dictation");
    expect(text).toContain("ffmpeg -i <input> -ar 16000 -ac 1 /tmp/<name>.wav");
    expect(text).toContain("voxtype -q transcribe /tmp/<name>.wav");
    expect(text).toContain("Read the output before using it");
    expect(text).not.toContain("Processing");
    expect(text).not.toMatch(/video/iu);
    expect(text).toContain("Only when the owner asks");
    expect(text).toContain("`voxtype config set text.smart_auto_submit true`");
    expect(text).toContain("`voxtype config set text.smart_auto_submit false`");
    expect(text).toContain("`systemctl --user restart voxtype`");
  });
});
