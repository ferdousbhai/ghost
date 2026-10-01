import { describe, expect, it } from "vitest";
import { DESKTOP_LEASE_IDLE_MS, DesktopLease } from "../src/extensions/desktop-lease.js";
import { createHyprlandExtension, GHOST_DESKTOP } from "../src/extensions/hyprland.js";
import { fakeHelper, loadExtensionWith, makeContext, resultText } from "./support/desktop-harness.js";

function clock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("DesktopLease", () => {
  it("lets the holder renew and refuses anyone else until it goes idle", () => {
    const time = clock();
    const lease = new DesktopLease(time.now);
    lease.claim("a");
    time.advance(DESKTOP_LEASE_IDLE_MS - 1);
    lease.claim("a");
    time.advance(DESKTOP_LEASE_IDLE_MS - 1);
    expect(() => lease.claim("b")).toThrow(expect.objectContaining({ code: "conflict", details: expect.objectContaining({ holder: "a" }) }));
    time.advance(1);
    lease.claim("b");
    expect(lease.peek()).toEqual({ holder: "b", idleMs: 0 });
  });
});

describe("ghost_desktop lease", () => {
  async function agents() {
    const time = clock();
    const lease = new DesktopLease(time.now);
    const helper = fakeHelper({ handle: (op) => (op === "state" ? { clients: [], workspaces: [], activewindow: null } : {}) });
    const load = (caller: string) => loadExtensionWith(
      createHyprlandExtension({ helper, lease }),
      makeContext({ cwd: "/tmp/ghost-does-not-matter", caller }),
    );
    return { time, helper, ghost: await load("conversation x"), claude: await load("claude-code 1234abcd") };
  }

  it("refuses a second agent's input while the first is steering, but not its reads", async () => {
    const { helper, ghost, claude } = await agents();
    await ghost.call(GHOST_DESKTOP, { action: "key", chord: "ctrl+s" });
    await expect(claude.call(GHOST_DESKTOP, { action: "type", text: "hi" }))
      .rejects.toThrow(/conversation x\) is steering the desktop/);
    expect(helper.requests.filter((request) => request.op === "type")).toHaveLength(0);
    const state = resultText(await claude.call(GHOST_DESKTOP, { action: "state" }));
    expect(state).toContain('"heldBy":"conversation x"');
  });

  it("hands the desktop over once the holder has gone idle", async () => {
    const { time, ghost, claude } = await agents();
    await ghost.call(GHOST_DESKTOP, { action: "focus", target: "kitty" });
    time.advance(DESKTOP_LEASE_IDLE_MS);
    await claude.call(GHOST_DESKTOP, { action: "key", chord: "Return" });
    await expect(ghost.call(GHOST_DESKTOP, { action: "key", chord: "Return" })).rejects.toThrow(/claude-code 1234abcd/);
  });
});
