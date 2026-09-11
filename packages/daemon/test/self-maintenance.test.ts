import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGhostSettings } from "../src/ghost-settings.js";
import { ghostPaths } from "../src/ghosts.js";
import type { RunningSource } from "../src/running-source.js";
import { renderSelfMaintenancePolicy, resolveSelfCheckout } from "../src/self-maintenance.js";

const OWNER_HOME = "/home/owner";
const CHECKOUT = "/home/owner/src/ghost";
const RUNNING: RunningSource = {
  version: "1.4.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  root: CHECKOUT,
};

let home: string | null = null;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function settingsWith(yaml: string): ReturnType<typeof loadGhostSettings> {
  home = mkdtempSync(join(tmpdir(), "self-maintenance-"));
  const paths = ghostPaths(home);
  mkdirSync(home, { recursive: true });
  writeFileSync(paths.settingsFile, yaml, "utf8");
  return loadGhostSettings(home);
}

describe("resolveSelfCheckout", () => {
  it("accepts a nested self.checkout under the owner home", () => {
    const settings = settingsWith(`self:\n  checkout: ${CHECKOUT}\n`);
    expect(resolveSelfCheckout(settings, OWNER_HOME)).toBe(CHECKOUT);
  });

  it("reads a relative, outside-home, owner-home, or missing value as unset", () => {
    expect(resolveSelfCheckout(settingsWith("self:\n  checkout: src/ghost\n"), OWNER_HOME)).toBeNull();
    expect(resolveSelfCheckout(settingsWith("self:\n  checkout: /srv/ghost\n"), OWNER_HOME)).toBeNull();
    expect(resolveSelfCheckout(settingsWith(`self:\n  checkout: ${OWNER_HOME}\n`), OWNER_HOME)).toBeNull();
    expect(resolveSelfCheckout(settingsWith("self:\n  checkout: /home/owner/../etc\n"), OWNER_HOME)).toBeNull();
    expect(resolveSelfCheckout(settingsWith("review:\n  mode: off\n"), OWNER_HOME)).toBeNull();
  });
});

describe("renderSelfMaintenancePolicy", () => {
  it("names the version, commit, and running root", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: CHECKOUT,
      running: RUNNING,
    });
    expect(policy.startsWith("## Self-maintenance")).toBe(true);
    expect(policy).toContain("ghostd 1.4.0");
    expect(policy).toContain(RUNNING.commit ?? "");
    expect(policy).toContain(JSON.stringify(CHECKOUT));
    expect(policy).toContain("This checkout is what runs you");
  });

  it("says a checkout that is not the running root cannot be adopted alone", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: "/home/owner/src/fork",
      running: { ...RUNNING, root: CHECKOUT },
    });
    expect(policy).toContain("This checkout is not what runs you");
    expect(policy).not.toContain("This checkout is what runs you");
  });

  it("names the packaged install when there is no running root", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: CHECKOUT,
      running: { version: "1.4.0", commit: null, root: null },
    });
    expect(policy).toContain("/usr/lib/ghost/runtime");
    expect(policy).toContain("commit unknown");
    expect(policy).toContain("This checkout is not what runs you");
  });

  it("says the source is unknown when nothing resolved it", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: null,
      running: null,
    });
    expect(policy).toContain("What runs you is unknown");
    expect(policy).not.toContain("You are ghostd");
  });

  it("points an unconfigured ghost at the repository and the nested settings key", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: null,
      running: RUNNING,
    });
    expect(policy).toContain("https://github.com/ferdousbhai/ghost");
    expect(policy).toContain("`self:`");
    expect(policy).toContain("Never edit a checkout you were not given.");
    // Nothing to edit means no edit loop to describe.
    expect(policy).not.toContain("The loop:");
  });

  it("points a fix in shared code upstream and gates the push on the owner", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: CHECKOUT,
      running: RUNNING,
    });
    expect(policy).toContain("branch from upstream master");
    expect(policy).toContain("`CONTRIBUTING.md` in the checkout");
    expect(policy).toContain("ask before you push");
    // No checkout means nothing to send upstream.
    expect(renderSelfMaintenancePolicy({ ghostName: "aria", checkout: null, running: RUNNING }))
      .not.toContain("CONTRIBUTING.md");
  });

  it("keeps the restart wake in this conversation when the session id is known", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: CHECKOUT,
      running: RUNNING,
      sessionId: "cli-abc123",
    });
    expect(policy).toContain("ghost say --ghost aria --session cli-abc123");
    expect(policy).toContain('--unit="ghost-restart-$(date +%s)"');
    expect(policy).not.toContain("your latest conversation");
  });

  it("omits the session flag and says where the wake lands without one", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: null,
      running: RUNNING,
    });
    expect(policy).toContain("ghost say --ghost aria \"You restarted ghostd");
    expect(policy).not.toContain("--session");
    expect(policy).toContain("your latest conversation");
  });

  it("does not offer a shell reload that would not reload QML", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: CHECKOUT,
      running: RUNNING,
    });
    expect(policy).toContain("systemctl --user restart ghost-shell.service");
    expect(policy).not.toContain("reload ghost-shell.service");
  });

  it("names where history lives and how to undo", () => {
    const policy = renderSelfMaintenancePolicy({
      ghostName: "aria",
      checkout: CHECKOUT,
      running: RUNNING,
    });
    expect(policy).toContain("journalctl --user -t ghostd");
    expect(policy).toContain("`git revert`");
    expect(policy).toContain("Never `rm -rf` a checkout.");
  });
});
