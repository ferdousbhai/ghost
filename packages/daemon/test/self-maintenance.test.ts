import { describe, expect, it } from "vitest";
import type { RunningSource } from "../src/running-source.js";
import { renderSelfMaintenancePolicy } from "../src/self-maintenance.js";

const CHECKOUT = "/home/owner/src/ghost";
const RUNNING: RunningSource = {
  version: "1.4.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  root: CHECKOUT,
};
const PACKAGED: RunningSource = { version: "1.4.0", commit: null, root: null };

describe("renderSelfMaintenancePolicy", () => {
  it("names the version, commit, and the running clone as the one checkout", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: RUNNING });
    expect(policy.startsWith("## Self-maintenance")).toBe(true);
    expect(policy).toContain("ghostd 1.4.0");
    expect(policy).toContain(RUNNING.commit ?? "");
    expect(policy).toContain(`Your checkout is ${JSON.stringify(CHECKOUT)}`);
    // The same clone powers every ghost on the machine.
    expect(policy).toContain("shared by every ghost on this machine");
    // Updates are reported by `ghost status` and applied only on the owner's word.
    expect(policy).toContain("`ghost status` names a newer Ghost release");
    expect(policy).toContain("only when they ask for the update");
  });

  it("gives a packaged install no checkout and no edit loop", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: PACKAGED });
    expect(policy).toContain("/usr/lib/ghost/runtime");
    expect(policy).toContain("commit unknown");
    expect(policy).toContain("There is no checkout to edit");
    expect(policy).toContain("https://github.com/ferdousbhai/ghost");
    expect(policy).toContain("Never edit a checkout you were not given.");
    expect(policy).not.toContain("The loop:");
    expect(policy).not.toContain("CONTRIBUTING.md");
  });

  it("says the source is unknown when nothing resolved it", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: null });
    expect(policy).toContain("What runs you is unknown");
    expect(policy).not.toContain("You are ghostd");
    expect(policy).toContain("There is no checkout to edit");
  });

  it("points a fix in shared code upstream and gates the push on the owner", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: RUNNING });
    expect(policy).toContain("branch from upstream master");
    expect(policy).toContain("`CONTRIBUTING.md` in the checkout");
    expect(policy).toContain("ask before you push");
  });

  it("keeps the restart wake in this conversation when the session id is known", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: RUNNING, sessionId: "cli-abc123" });
    expect(policy).toContain("ghost say --ghost aria --session cli-abc123");
    expect(policy).toContain('--unit="ghost-restart-$(date +%s)"');
    expect(policy).not.toContain("your latest conversation");
  });

  it("omits the session flag and says where the wake lands without one", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: RUNNING });
    expect(policy).toContain("ghost say --ghost aria \"You restarted ghostd");
    expect(policy).not.toContain("--session");
    expect(policy).toContain("your latest conversation");
  });

  it("does not offer a shell reload that would not reload QML", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: RUNNING });
    expect(policy).toContain("systemctl --user restart ghost-shell.service");
    expect(policy).not.toContain("reload ghost-shell.service");
  });

  it("names where history lives and how to undo", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: RUNNING });
    expect(policy).toContain("journalctl --user -t ghostd");
    expect(policy).toContain("`git revert`");
    expect(policy).toContain("Never `rm -rf` a checkout.");
  });
});
