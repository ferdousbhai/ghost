import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  fetchLatestReleaseVersion,
  parseReleaseTag,
  UpdateChecker,
  updateCommand,
  type UpdateFetch,
} from "../src/update-check.js";

function release(tag: unknown, ok = true): UpdateFetch {
  return async () => ({ ok, json: async () => ({ tag_name: tag }) });
}

describe("release versions", () => {
  it("reads a release tag with or without its v", () => {
    expect(parseReleaseTag("v0.2.0")).toBe("0.2.0");
    expect(parseReleaseTag("1.10.3")).toBe("1.10.3");
    expect(parseReleaseTag("v0.2.0-rc1")).toBeNull();
    expect(parseReleaseTag(42)).toBeNull();
  });

  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("garbage", "0.0.1")).toBe(-1);
  });
});

describe("the update command", () => {
  it.each([false, true])("restarts the shell only with an installed HUD (%s)", (hudInstalled) => {
    const root = mkdtempSync(join(tmpdir(), "ghost-update-command-"));
    try {
      const config = join(root, "config");
      if (hudInstalled) {
        const plugin = join(config, "omarchy/plugins/ferdousbhai.ghost");
        mkdirSync(plugin, { recursive: true });
        writeFileSync(join(plugin, "manifest.json"), "{}");
      }
      const script = `git() { :; }; pnpm() { :; };
systemctl() { echo daemon; }; omarchy-restart-shell() { echo shell; };
${updateCommand("/checkout")}`;
      const output = execFileSync("bash", ["-c", script], {
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: config },
        encoding: "utf8",
      });
      expect(output).toBe(hudInstalled ? "daemon\nshell\n" : "daemon\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is Omarchy's for the package and a pull, build, and restart for a checkout", () => {
    expect(updateCommand(null)).toBe("omarchy-update");
    const root = "/home/owner's ghost/$(echo unexpected)`echo expansion`";
    const output = execFileSync("bash", ["-c", `
git() { printf '%s\\n' "$2"; }; pnpm() { printf '%s\\n' "$2"; };
systemctl() { :; }; omarchy-restart-shell() { :; };
${updateCommand(root)}`], { encoding: "utf8" });
    expect(output.trimEnd().split("\n")).toEqual([root, root, root]);
  });
});

describe("the latest release fetch", () => {
  it("is null for a failed response, a bad body, or a thrown fetch", async () => {
    expect(await fetchLatestReleaseVersion(release("v1.0.0", false))).toBeNull();
    expect(await fetchLatestReleaseVersion(release("nightly"))).toBeNull();
    expect(await fetchLatestReleaseVersion(async () => { throw new Error("offline"); })).toBeNull();
  });

  it("asks GitHub for JSON and reads the tag", async () => {
    let seen: { url: string; accept: string } | undefined;
    const fetch: UpdateFetch = async (url, init) => {
      seen = { url, accept: init.headers.accept ?? "" };
      return { ok: true, json: async () => ({ tag_name: "v0.3.0" }) };
    };
    expect(await fetchLatestReleaseVersion(fetch)).toBe("0.3.0");
    expect(seen).toEqual({ url: "https://api.github.com/repos/ferdousbhai/ghost/releases/latest", accept: "application/vnd.github+json" });
  });
});

describe("UpdateChecker", () => {
  it("reports a newer release with this install's command, and nothing when current", async () => {
    const checker = new UpdateChecker({ version: "0.2.0", sourceRoot: null, fetch: release("v0.3.1") });
    expect(checker.current).toBeNull();
    expect(await checker.checkNow()).toEqual({
      latest: "0.3.1",
      command: "omarchy-update",
      url: "https://github.com/ferdousbhai/ghost/releases/tag/v0.3.1",
    });
    expect(checker.current?.latest).toBe("0.3.1");
    const current = new UpdateChecker({ version: "0.3.1", sourceRoot: null, fetch: release("v0.3.1") });
    expect(await current.checkNow()).toBeNull();
  });

  it("forgets an update the next check no longer sees", async () => {
    let tag = "v9.0.0";
    const checker = new UpdateChecker({ version: "0.2.0", sourceRoot: null, fetch: async () => ({ ok: true, json: async () => ({ tag_name: tag }) }) });
    await checker.checkNow();
    tag = "v0.2.0";
    expect(await checker.checkNow()).toBeNull();
    expect(checker.current).toBeNull();
  });

  it("checks on its timer and stops cleanly", async () => {
    let calls = 0;
    const checker = new UpdateChecker({
      version: "0.2.0",
      sourceRoot: null,
      fetch: async () => { calls += 1; return { ok: true, json: async () => ({ tag_name: "v0.2.1" }) }; },
      initialDelayMs: 5,
      intervalMs: 5,
    });
    checker.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    checker.stop();
    const settled = calls;
    expect(settled).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(settled);
    expect(checker.current?.latest).toBe("0.2.1");
  });
});
