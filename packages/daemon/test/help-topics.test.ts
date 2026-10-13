import { describe, expect, it } from "vitest";
import { HELP_TOPICS, isHelpTopic, renderHelpTopic } from "../src/help-topics.js";

const INPUT = { ghostName: "aria", unitDir: "/home/owner/.config/systemd/user", cliPath: "/usr/bin/ghost" };

describe("ghost help topics", () => {
  it("knows its topics", () => {
    expect(HELP_TOPICS).toEqual(["timers", "self", "harnesses", "background"]);
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
    expect(text).toContain("`ghost delegate` gives claude and codex runs your own tools");
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
});
