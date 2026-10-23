import { describe, expect, it } from "vitest";
import { HELP_TOPICS, isHelpTopic, renderHelpTopic } from "../src/help-topics.js";

const INPUT = { ghostName: "aria", unitDir: "/home/owner/.config/systemd/user", cliPath: "/usr/bin/ghost" };

describe("ghost help topics", () => {
  it("knows its topics", () => {
    expect(HELP_TOPICS).toEqual(["timers", "self", "harnesses", "background", "memory", "dictation", "events", "notifications"]);
    expect(isHelpTopic("timers")).toBe(true);
    expect(isHelpTopic("status")).toBe(false);
  });

  it("timers: both units in the ghost's namespace, the CLI path, and what Persistent= does", () => {
    const text = renderHelpTopic("timers", { ...INPUT, ghostName: "aria-ops", unitDir: "/srv/owner config/systemd/user" });
    expect(text).toContain('"/srv/owner config/systemd/user"');
    expect(text).toContain("ghost-timer-v1-8-aria-ops-<slug>");
    expect(text).toContain("[a-z0-9]+(?:-[a-z0-9]+)*");
    expect(text).toContain("ExecStart=/usr/bin/ghost say --new --ghost aria-ops");
    expect(text).toContain("`Persistent=true` runs one catch-up");
    expect(text).toContain("`Persistent=false` drops them");
    expect(text).toContain("not a timer primitive");
    expect(text).toContain("systemctl --user list-timers");
  });

  it("self: follows repository rules and restarts without a model prompt", () => {
    const text = renderHelpTopic("self", INPUT);
    expect(text).toContain("AGENTS.md and CONTRACTS.md");
    expect(text).toContain("preserve other sessions' edits");
    expect(text).toContain('systemctl --user restart ghostd.service');
    expect(text).toContain('journalctl --user -t ghostd');
    expect(text).toContain('omarchy-restart-shell');
    expect(text).not.toContain('ghost say');
    expect(text).not.toContain('git restore');
    expect(text).not.toContain('branch from upstream master');
  });

  it("background: the detached recipe that wakes the conversation", () => {
    const text = renderHelpTopic("background", INPUT);
    expect(text).toContain("setsid -f bash -c");
    expect(text).toContain("ghost say --follow-up");
    expect(text).toContain("`$GHOST` and `$GHOST_SESSION`");
    expect(text).toContain("end when this turn's headless run does");
  });

  it("harnesses: the delegate launch path, its refusals, and the handoff note", () => {
    const text = renderHelpTopic("harnesses", INPUT);
    expect(text).toContain("Your turns run in this conversation's own directory");
    expect(text).toContain("only when it needs those; otherwise do it yourself");
    expect(text).not.toContain("orchestrator");
    expect(text).toContain("cd <project-dir> && ghost delegate <harness> -- <args>");
    expect(text).toContain("respects that project's settings");
    expect(text).toContain("refuses an uninstalled harness (exit 5)");
    expect(text).toContain("exits with its status");
    expect(text).toContain("`ghost harnesses` lists installed agents and informational usage");
    expect(text).toContain("`ghost delegate` gives claude and codex runs your desktop tools");
    expect(text).toContain("--owner-named");
    expect(text).toContain("--permission-mode acceptEdits");
    expect(text).toContain("--allowedTools Bash");
    expect(text).not.toContain("~/.local/state/omarchy");
    expect(text).toContain("handoff note");
    expect(text).toContain("Never spend a window you were not asked to spend.");
  });

  it("harnesses: herdr runs in Ghost's own session with owner-named, owner-authenticated harnesses", () => {
    const text = renderHelpTopic("harnesses", INPUT);
    expect(text).toContain("every command takes `--session ghost`");
    expect(text).toContain("systemd-run --user --unit=herdr-ghost herdr --session ghost server");
    expect(text).toContain("Install only harnesses the owner names, with `mise use -g <harness>`");
    expect(text).toContain("never read, type, or store a credential");
    expect(text).toContain("`--wait` alone is not proof");
    expect(text).toContain("after `ghost harnesses` confirms it is installed");
  });

  it("memory: exact search first, Recall for unknown wording, the source file over any index", () => {
    const text = renderHelpTopic("memory", INPUT);
    expect(text).toContain("`board.md` at its root");
    expect(text).toContain("rg -n -i '<term>' <folder>");
    expect(text).toContain("Recall through its `recall` skill");
    expect(text).toContain("without it, use filenames and `rg`");
    expect(text).toContain("then the source file itself before relying on one");
    expect(text).toContain("whenever a task needs them, from the first turn on");
    expect(text).toContain("keep both claims and tell the owner which is uncertain");
    expect(text).toContain("dead end (what was tried, why it failed)");
    expect(text).toContain("dating what you add");
    expect(text).toContain("only when the owner asks or a timer they approved runs it");
    expect(text).toContain("Trash with `gio trash`, never `rm`");
    expect(text).toContain("keep its original restorable: `cp -p \"$f\" \"$f~\" && gio trash \"$f~\"`");
    expect(text).toContain("mark a superseded fact with what replaced it and when");
    expect(text).toContain("only an empty note or a duplicate you merged. Then report each changed and trashed path");
    expect(text).toContain("daily timer (`ghost help timers`, `OnCalendar=daily`)");
    expect(text).toContain("only if `systemctl --user list-timers --all '*-tidy-notes.timer'` lists none; never install it unasked");
    expect(text).toContain("Never preload the directory, read it wholesale, or keep an index or memory store of your own");
    expect(text).toContain("A Recall index over folders the owner chose, the whole directory included, is theirs to search");
    expect(text).toContain("`skills/<name>/SKILL.md`");
  });

  it("dictation: transcribes audio with the installed Voxtype and toggles spoken submit only on request", () => {
    const text = renderHelpTopic("dictation", INPUT);
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
