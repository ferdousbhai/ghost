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
  it("names the running clone as the one checkout and points at the recipes", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: RUNNING });
    expect(policy.startsWith("## Self-maintenance")).toBe(true);
    expect(policy).not.toContain(RUNNING.commit ?? "");
    expect(policy).toContain(`Your checkout is ${JSON.stringify(CHECKOUT)}`);
    // The same clone powers every ghost on the machine.
    expect(policy).toContain("shared by every ghost on this machine");
    // The long recipes live in `ghost help self`; the prompt points there.
    expect(policy).toContain("Read `ghost help self` before editing, restarting, or updating yourself");
    expect(policy).toContain("`ghost help` lists the rest of your CLI");
    expect(policy).not.toContain("systemd-run");
  });

  it("gives a packaged install no checkout and no edit loop", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: PACKAGED });
    expect(policy).toContain("/usr/lib/ghost/runtime");
    expect(policy).toContain("there is no checkout");
    expect(policy).toContain("https://github.com/ferdousbhai/ghost");
    expect(policy).toContain("Never edit a checkout you were not given.");
    expect(policy).not.toContain("systemd-run");
  });

  it("says the source is unknown when nothing resolved it", () => {
    const policy = renderSelfMaintenancePolicy({ ghostName: "aria", running: null });
    expect(policy).not.toContain("packaged install under");
    expect(policy).toContain("No checkout is known to this process");
    expect(policy).not.toContain("packaged install.");
  });
});
