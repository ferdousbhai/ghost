import { describe, expect, it } from "vitest";
import { HELP_TOPICS, isHelpTopic, renderHelpTopic } from "../src/help-topics.js";

const INPUT = { ghostName: "aria", unitDir: "/home/owner/.config/systemd/user", cliPath: "/usr/bin/ghost" };

describe("ghost help topics", () => {
  it("knows its topics", () => {
    expect(HELP_TOPICS).toEqual(["timers", "self", "harnesses"]);
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

  it("self: the loop, the upstream nudge, the restart unit, the HUD restart, history, and undo", () => {
    const text = renderHelpTopic("self", INPUT);
    expect(text).toContain("branch from upstream master");
    expect(text).toContain("consider offering it upstream");
    expect(text).toContain("`CONTRIBUTING.md` in the checkout");
    expect(text).toContain("ask before you push");
    expect(text).toContain('--unit="ghost-restart-$(date +%s)"');
    expect(text).toContain("ghost say --ghost aria \"You restarted ghostd");
    expect(text).not.toContain("--session");
    expect(text).toContain("your latest conversation");
    expect(text).toContain("omarchy-restart-shell");
    expect(text).not.toContain("rescanPlugins");
    expect(text).not.toContain("ghost-shell.service");
    expect(text).toContain("journalctl --user -t ghostd");
    expect(text).toContain("`git revert`");
    expect(text).toContain("Never `rm -rf` a checkout.");
  });

  it("self: the restart wakes this conversation when the session is known", () => {
    const text = renderHelpTopic("self", { ...INPUT, sessionId: "cli-abc123" });
    expect(text).toContain("ghost say --ghost aria --session cli-abc123");
    expect(text).not.toContain("your latest conversation");
  });

  it("harnesses: the eligibility verb, the refresh command, and the handoff note", () => {
    const text = renderHelpTopic("harnesses", INPUT);
    expect(text).toContain("Your own cwd is always the owner home");
    expect(text).toContain("you are the orchestrator");
    expect(text).toContain("cd <project-dir> && <harness>");
    expect(text).toContain("respects that project's settings");
    expect(text).toContain("run `ghost harnesses`");
    expect(text).toContain("hand work only to one it marks eligible");
    expect(text).toContain("`omarchy agent usage update <agent>`");
    expect(text).not.toContain("~/.local/state/omarchy");
    expect(text).toContain("handoff note");
    expect(text).toContain("Never spend a window you were not asked to spend.");
  });
});
