/**
 * `ghost_desktop`.
 *
 * hyprctl and notify-send are never actually run. What is asserted is the argv:
 * every value the model supplies must arrive as its own argument, and anything
 * that could break out of an argv once Hyprland's own `exec` dispatcher hands
 * the string to a shell must be refused before it gets that far.
 */
import { describe, expect, it } from "vitest";
import { visitorScope } from "../src/scope.js";
import {
  condenseDesktopState,
  createHyprlandExtension,
  desktopToolNames,
  focusSelector,
  GHOST_DESKTOP,
  HYPRLAND_SIGNATURE_ENV,
  MAX_LISTED_WINDOWS,
  MAX_TITLE_LENGTH,
} from "../src/extensions/hyprland.js";
import {
  fakeRunner,
  loadExtensionWith,
  makeContext,
  missingBinary,
  resultText,
  type FakeRunner,
} from "./support/desktop-harness.js";

const HYPR_ENV: NodeJS.ProcessEnv = { [HYPRLAND_SIGNATURE_ENV]: "sig_123" };

const CLIENTS = [
  {
    address: "0xaaa",
    class: "firefox",
    title: "Cloudflare Workers docs — Mozilla Firefox",
    workspace: { id: 1, name: "1" },
    pid: 4242,
    xwayland: false,
    fullscreenClientMode: 0,
  },
  {
    address: "0xbbb",
    class: "kitty",
    title: "nvim ~/src/ghost",
    workspace: { id: 2, name: "code" },
    pid: 4243,
  },
];

const WORKSPACES = [
  { id: 1, name: "1", monitor: "DP-1", windows: 1, hasfullscreen: false },
  { id: 2, name: "code", monitor: "DP-1", windows: 1 },
];

const ACTIVE = CLIENTS[1];

function hyprRunner(): FakeRunner {
  return fakeRunner((command, args) => {
    if (command !== "hyprctl") return { stdout: "", stderr: "" };
    if (args[0] === "-j") {
      const which = args[1];
      if (which === "clients") return { stdout: JSON.stringify(CLIENTS), stderr: "" };
      if (which === "workspaces") return { stdout: JSON.stringify(WORKSPACES), stderr: "" };
      if (which === "activewindow") return { stdout: JSON.stringify(ACTIVE), stderr: "" };
    }
    return { stdout: "ok\n", stderr: "" };
  });
}

async function harness(options: Parameters<typeof createHyprlandExtension>[0] = {}) {
  const runner = options.run ? undefined : hyprRunner();
  const merged = { env: HYPR_ENV, ...(runner ? { run: runner.run } : {}), ...options };
  const extension = await loadExtensionWith(
    createHyprlandExtension(merged),
    makeContext({ cwd: "/tmp/ghost-does-not-matter" }),
  );
  return { extension, runner };
}

describe("condenseDesktopState", () => {
  it("keeps only what a persona can act on", () => {
    const state = condenseDesktopState(CLIENTS, WORKSPACES, ACTIVE);
    expect(state.activeWindow).toEqual({
      address: "0xbbb",
      class: "kitty",
      title: "nvim ~/src/ghost",
      workspace: "code",
    });
    expect(state.windows).toEqual([
      {
        address: "0xaaa",
        class: "firefox",
        title: "Cloudflare Workers docs — Mozilla Firefox",
        workspace: "1",
        focused: false,
      },
      {
        address: "0xbbb",
        class: "kitty",
        title: "nvim ~/src/ghost",
        workspace: "code",
        focused: true,
      },
    ]);
    expect(state.workspaces).toEqual([
      { id: 1, name: "1", windows: 1, monitor: "DP-1" },
      { id: 2, name: "code", windows: 1, monitor: "DP-1" },
    ]);
    // pid, xwayland, fullscreenClientMode and friends are billed per token and
    // mean nothing to a persona.
    expect(JSON.stringify(state)).not.toContain("pid");
    expect(JSON.stringify(state)).not.toContain("xwayland");
  });

  it("truncates long titles and caps the window list", () => {
    const many = Array.from({ length: MAX_LISTED_WINDOWS + 5 }, (_unused, index) => ({
      address: `0x${index}`,
      class: "c",
      title: "t".repeat(MAX_TITLE_LENGTH + 40),
      workspace: { id: 1, name: "1" },
    }));
    const state = condenseDesktopState(many, [], null);
    expect(state.windows).toHaveLength(MAX_LISTED_WINDOWS);
    expect(state.omitted).toBe(5);
    expect(state.windows[0]?.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(state.windows[0]?.title.endsWith("…")).toBe(true);
  });

  it("survives hyprctl returning nothing useful", () => {
    const state = condenseDesktopState(null, undefined, {});
    expect(state.activeWindow).toBeNull();
    expect(state.windows).toEqual([]);
    expect(state.workspaces).toEqual([]);
  });
});

describe("focusSelector", () => {
  it("recognises an address", () => {
    expect(focusSelector("0xdeadbeef")).toBe("address:0xdeadbeef");
  });

  it("falls back to a window class", () => {
    expect(focusSelector("firefox")).toBe("class:firefox");
  });

  it("refuses anything that is neither", () => {
    expect(() => focusSelector("firefox; rm -rf ~")).toThrowError(/not a window address/);
    expect(() => focusSelector("$(id)")).toThrowError(/not a window address/);
  });
});

describe("ghost_desktop", () => {
  it("reads the desktop with three hyprctl -j calls", async () => {
    const { extension, runner } = await harness();
    const result = await extension.call(GHOST_DESKTOP, { action: "state" });
    expect(runner?.lines().sort()).toEqual([
      "hyprctl -j activewindow",
      "hyprctl -j clients",
      "hyprctl -j workspaces",
    ]);
    const state = JSON.parse(resultText(result));
    expect(state.activeWindow.class).toBe("kitty");
    expect(result.details.windows).toBe(2);
  });

  it("focuses a window by address", async () => {
    const { extension, runner } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "focus", window: "0xaaa" });
    expect(runner?.lines()).toEqual(["hyprctl dispatch focuswindow address:0xaaa"]);
  });

  it("focuses a window by class", async () => {
    const { extension, runner } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "focus", window: "firefox" });
    expect(runner?.lines()).toEqual(["hyprctl dispatch focuswindow class:firefox"]);
  });

  it("needs a window to focus", async () => {
    const { extension } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "focus" }),
    ).rejects.toThrowError(/needs window/);
  });

  it("switches workspace", async () => {
    const { extension, runner } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "workspace", workspace: "+1" });
    expect(runner?.lines()).toEqual(["hyprctl dispatch workspace +1"]);
  });

  it("refuses a workspace that is not a workspace", async () => {
    const { extension } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "workspace", workspace: "1; reboot" }),
    ).rejects.toThrowError(/is not a workspace/);
  });

  it("surfaces Hyprland's own refusal", async () => {
    const runner = fakeRunner(() => ({ stdout: "Invalid dispatcher\n", stderr: "" }));
    const { extension } = await harness({ run: runner.run });
    await expect(
      extension.call(GHOST_DESKTOP, { action: "workspace", workspace: "99" }),
    ).rejects.toThrowError(/Hyprland refused that: Invalid dispatcher/);
  });

  it("shows a notification without needing Hyprland", async () => {
    const runner = fakeRunner();
    const { extension } = await harness({ run: runner.run, env: {} });
    const result = await extension.call(GHOST_DESKTOP, {
      action: "notify",
      message: "the build finished",
      title: "Casper",
      urgency: "low",
    });
    expect(runner.calls[0]?.command).toBe("notify-send");
    expect(runner.calls[0]?.args).toEqual([
      "--app-name=ghost",
      "--urgency=low",
      "Casper",
      "the build finished",
    ]);
    expect(resultText(result)).toBe("Notification shown.");
  });

  it("needs a message to notify", async () => {
    const { extension } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "notify" }),
    ).rejects.toThrowError(/needs message/);
  });

  it("degrades clearly when notify-send is missing", async () => {
    const runner = fakeRunner(() => {
      throw missingBinary("notify-send");
    });
    const { extension } = await harness({ run: runner.run });
    await expect(
      extension.call(GHOST_DESKTOP, { action: "notify", message: "hi" }),
    ).rejects.toThrowError(/notify-send, which is not installed/);
  });
});

describe("ghost_desktop off Hyprland", () => {
  it("says so when the session is not Hyprland", async () => {
    const { extension } = await harness({ env: {} });
    await expect(
      extension.call(GHOST_DESKTOP, { action: "state" }),
    ).rejects.toThrowError(new RegExp(`${HYPRLAND_SIGNATURE_ENV} is not set`));
  });

  it("says so when hyprctl is not installed", async () => {
    const runner = fakeRunner(() => {
      throw missingBinary("hyprctl");
    });
    const { extension } = await harness({ run: runner.run });
    await expect(
      extension.call(GHOST_DESKTOP, { action: "state" }),
    ).rejects.toThrowError(/hyprctl is not installed/);
  });
});

describe("ghost_desktop exec", () => {
  it("is switched off by default", async () => {
    const { extension, runner } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "exec", command: "firefox" }),
    ).rejects.toThrowError(/switched off for this ghost/);
    expect(runner?.calls).toHaveLength(0);
  });

  it("launches a program when the creator enabled it", async () => {
    const { extension, runner } = await harness({ allowExec: true });
    await extension.call(GHOST_DESKTOP, {
      action: "exec",
      command: "firefox",
      args: ["https://example.com/docs"],
    });
    expect(runner?.calls[0]?.args).toEqual([
      "dispatch",
      "exec",
      "firefox",
      "https://example.com/docs",
    ]);
  });

  it("refuses shell syntax in the command", async () => {
    const { extension, runner } = await harness({ allowExec: true });
    await expect(
      extension.call(GHOST_DESKTOP, { action: "exec", command: "firefox; curl evil.example" }),
    ).rejects.toThrowError(/not allowed in a launched command/);
    expect(runner?.calls).toHaveLength(0);
  });

  it("refuses shell syntax in an argument", async () => {
    const { extension, runner } = await harness({ allowExec: true });
    await expect(
      extension.call(GHOST_DESKTOP, {
        action: "exec",
        command: "kitty",
        args: ["$(cat ~/.ssh/id_ed25519)"],
      }),
    ).rejects.toThrowError(/not allowed in a launched command/);
    expect(runner?.calls).toHaveLength(0);
  });

  it("needs a command", async () => {
    const { extension } = await harness({ allowExec: true });
    await expect(
      extension.call(GHOST_DESKTOP, { action: "exec" }),
    ).rejects.toThrowError(/needs command/);
  });
});

describe("ghost_desktop scope", () => {
  it("gives a visitor no tool and blocks the name outright", async () => {
    const scope = visitorScope("visitor-1");
    const runner = hyprRunner();
    const extension = await loadExtensionWith(
      createHyprlandExtension({ scope, run: runner.run, env: HYPR_ENV, allowExec: true }),
      makeContext({ cwd: "/tmp/ghost-does-not-matter" }),
    );
    expect(extension.toolNames()).toEqual([]);
    expect(desktopToolNames({ scope })).toEqual([]);
    const blocked = await extension.toolCall(GHOST_DESKTOP);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/visitor conversation/);
    expect(runner.calls).toHaveLength(0);
  });

  it("offers exactly one tool to a creator", async () => {
    const { extension } = await harness();
    expect(extension.toolNames()).toEqual([GHOST_DESKTOP]);
    expect(desktopToolNames()).toEqual([GHOST_DESKTOP]);
    expect(await extension.toolCall(GHOST_DESKTOP)).toBeUndefined();
  });
});
