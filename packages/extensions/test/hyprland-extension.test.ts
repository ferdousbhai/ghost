/**
 * `ghost_desktop`.
 *
 * The tool routes everything but `notify` through the desktop-helper sidecar,
 * which is injected here as a {@link fakeHelper} — no process is spawned and no
 * desktop is touched. What is asserted is the op + args the tool sends, the
 * ax_query→ref→ax_perform semantic flow, how honesty metadata reaches the model,
 * and how the tool degrades when a backend (AT-SPI, ydotool) is missing.
 */
import { describe, expect, it } from "vitest";
import { visitorScope } from "../src/scope.js";
import {
  condenseDesktopState,
  createHyprlandExtension,
  desktopToolNames,
  GHOST_DESKTOP,
  MAX_LISTED_WINDOWS,
  MAX_TITLE_LENGTH,
} from "../src/extensions/hyprland.js";
import { GhostError } from "../src/errors.js";
import {
  fakeHelper,
  fakeRunner,
  loadExtensionWith,
  makeContext,
  missingBinary,
  resultText,
  type FakeHelper,
} from "./support/desktop-harness.js";

const CLIENTS = [
  {
    address: "0xaaa",
    class: "firefox",
    title: "Cloudflare Workers docs — Mozilla Firefox",
    workspace: { id: 1, name: "1" },
    pid: 4242,
    xwayland: false,
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
  { id: 1, name: "1", monitor: "DP-1", windows: 1 },
  { id: 2, name: "code", monitor: "DP-1", windows: 1 },
];

const ACTIVE = CLIENTS[1];

/** The default sidecar answers for the read/act ops the tests exercise. */
function desktopHandler(op: string): unknown {
  switch (op) {
    case "state":
      return {
        clients: CLIENTS,
        workspaces: WORKSPACES,
        activeworkspace: WORKSPACES[1],
        activewindow: ACTIVE,
        monitors: [{ name: "DP-1", focused: true }],
      };
    case "see":
      return { windows: [CLIENTS[0]], count: 1 };
    case "layers":
      return { layers: [], count: 0 };
    case "focus":
      return {
        backend: "hyprland-dispatch",
        background_safe: false,
        interference: ["focus-change"],
        warnings: [],
        grammar: "lua-table",
      };
    case "workspace":
      return {
        backend: "hyprland-dispatch",
        background_safe: false,
        interference: ["workspace-switch"],
        warnings: [],
      };
    case "ax_query":
      return {
        app: "firefox",
        pid: 4242,
        elements: [
          {
            ref: 7,
            role: "push button",
            name: "Save",
            states: ["enabled", "focusable"],
            actions: ["click", "press"],
          },
        ],
        count: 1,
        truncated: false,
        warnings: [],
      };
    case "ax_roles":
      return { app: "firefox", pid: 4242, roles: { "push button": 3, text: 2 } };
    case "ax_perform":
      return { backend: "atspi", background_safe: true, interference: [], warnings: [] };
    case "ax_set":
      return { backend: "atspi", background_safe: true, interference: [], warnings: [] };
    case "key":
      return {
        backend: "hyprland-sendshortcut",
        background_safe: true,
        interference: [],
        warnings: [],
      };
    case "type":
      return { backend: "atspi", background_safe: true, interference: [], warnings: [] };
    case "click":
      return {
        backend: "ydotool",
        background_safe: false,
        interference: ["pointer-move"],
        warnings: [],
      };
    default:
      return {};
  }
}

async function harness(
  helperOverride?: FakeHelper,
  runner = fakeRunner(),
) {
  const helper = helperOverride ?? fakeHelper({ handle: desktopHandler });
  const extension = await loadExtensionWith(
    createHyprlandExtension({ helper, run: runner.run }),
    makeContext({ cwd: "/tmp/ghost-does-not-matter" }),
  );
  return { extension, helper, runner };
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
    expect(state.windows[0]?.address).toBe("0xaaa");
    expect(state.windows[1]?.focused).toBe(true);
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
  });

  it("survives the sidecar returning nothing useful", () => {
    const state = condenseDesktopState(null, undefined, {});
    expect(state.activeWindow).toBeNull();
    expect(state.windows).toEqual([]);
    expect(state.workspaces).toEqual([]);
  });
});

describe("ghost_desktop read ops", () => {
  it("reads and condenses state from the sidecar", async () => {
    const { extension, helper } = await harness();
    const result = await extension.call(GHOST_DESKTOP, { action: "state" });
    expect(helper.requests.map((r) => r.op)).toEqual(["state"]);
    const state = JSON.parse(resultText(result));
    expect(state.activeWindow.class).toBe("kitty");
    expect(result.details.windows).toBe(2);
  });

  it("finds a window with see", async () => {
    const { extension, helper } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "see", target: "firefox" });
    expect(helper.requests[0]).toEqual({ op: "see", args: { name: "firefox" } });
  });
});

describe("ghost_desktop dispatch", () => {
  it("focuses by address", async () => {
    const { extension, helper } = await harness();
    const result = await extension.call(GHOST_DESKTOP, { action: "focus", target: "0xaaa" });
    expect(helper.requests[0]).toEqual({ op: "focus", args: { address: "0xaaa" } });
    // Honesty metadata reaches the model.
    expect(resultText(result)).toMatch(/changed what the user sees/);
    expect(result.details.interference).toContain("focus-change");
  });

  it("focuses by class or title when it is not an address", async () => {
    const { extension, helper } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "focus", target: "firefox" });
    expect(helper.requests[0]).toEqual({ op: "focus", args: { name: "firefox" } });
  });

  it("needs a target to focus", async () => {
    const { extension } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "focus" }),
    ).rejects.toThrowError(/needs target/);
  });

  it("switches workspace through the grammar-correct sidecar", async () => {
    const { extension, helper } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "workspace", workspace: "+1" });
    expect(helper.requests[0]).toEqual({ op: "workspace", args: { id: "+1" } });
  });

  it("needs a workspace", async () => {
    const { extension } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "workspace" }),
    ).rejects.toThrowError(/needs workspace/);
  });
});

describe("ghost_desktop AT-SPI semantic flow", () => {
  it("ax_query returns elements with refs and a usage hint", async () => {
    const { extension, helper } = await harness();
    const result = await extension.call(GHOST_DESKTOP, {
      action: "ax_query",
      target: "firefox",
      role: "button",
      match: "Save",
      states: "enabled, focusable",
      limit: 5,
    });
    expect(helper.requests[0]).toEqual({
      op: "ax_query",
      args: {
        app: "firefox",
        role: "button",
        text: "Save",
        attributes: ["enabled", "focusable"],
        limit: 5,
      },
    });
    expect(resultText(result)).toMatch(/ref/);
    expect(result.details.count).toBe(1);
  });

  it("drives ax_query → ref → ax_perform", async () => {
    const { extension, helper } = await harness();
    const query = await extension.call(GHOST_DESKTOP, { action: "ax_query", target: "firefox" });
    const elements = JSON.parse(resultText(query).split("\n").slice(1).join("\n")).elements;
    const ref = elements[0].ref;
    expect(ref).toBe(7);
    const result = await extension.call(GHOST_DESKTOP, {
      action: "ax_perform",
      ref,
      ax_action: "press",
    });
    expect(helper.requests[1]).toEqual({
      op: "ax_perform",
      args: { ref: 7, action: "press" },
    });
    expect(resultText(result)).toMatch(/Background-safe/);
  });

  it("ax_perform needs a ref", async () => {
    const { extension } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "ax_perform" }),
    ).rejects.toThrowError(/needs ref/);
  });

  it("ax_set writes an attribute by ref", async () => {
    const { extension, helper } = await harness();
    await extension.call(GHOST_DESKTOP, {
      action: "ax_set",
      ref: 7,
      attribute: "text",
      value: "hello",
    });
    expect(helper.requests[0]).toEqual({
      op: "ax_set",
      args: { ref: 7, attribute: "text", value: "hello" },
    });
  });

  it("ax_roles reports the roles an app exposes", async () => {
    const { extension, helper } = await harness();
    const result = await extension.call(GHOST_DESKTOP, { action: "ax_roles", target: "firefox" });
    expect(helper.requests[0]).toEqual({ op: "ax_roles", args: { app: "firefox" } });
    expect(resultText(result)).toContain("push button");
  });
});

describe("ghost_desktop input", () => {
  it("sends a key chord", async () => {
    const { extension, helper } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "key", chord: "ctrl+s" });
    expect(helper.requests[0]).toEqual({ op: "key", args: { chord: "ctrl+s" } });
  });

  it("types into a ref", async () => {
    const { extension, helper } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "type", text: "hello", ref: 7 });
    expect(helper.requests[0]).toEqual({ op: "type", args: { text: "hello", ref: 7 } });
  });

  it("clicks a ref", async () => {
    const { extension, helper } = await harness();
    await extension.call(GHOST_DESKTOP, { action: "click", ref: 7 });
    expect(helper.requests[0]).toEqual({ op: "click", args: { ref: 7 } });
  });

  it("clicks a coordinate with its space", async () => {
    const { extension, helper } = await harness();
    await extension.call(GHOST_DESKTOP, {
      action: "click",
      x: 100,
      y: 200,
      coordinate_space: "window",
      target: "firefox",
    });
    expect(helper.requests[0]).toEqual({
      op: "click",
      args: { x: 100, y: 200, coordinate_space: "window", app: "firefox" },
    });
  });

  it("needs a ref or coordinates to click", async () => {
    const { extension } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "click" }),
    ).rejects.toThrowError(/needs either ref/);
  });
});

describe("ghost_desktop degradation", () => {
  it("refuses ax ops and suggests vision when AT-SPI is unavailable", async () => {
    const helper = fakeHelper({
      handle: desktopHandler,
      backends: {
        atspi: {
          available: false,
          reason: "PyGObject is installed for 3.14 but running on 3.11",
          remediation: ["rebuild on Python 3.14"],
        },
      },
    });
    const { extension } = await harness(helper);
    await expect(
      extension.call(GHOST_DESKTOP, { action: "ax_query", target: "firefox" }),
    ).rejects.toThrowError(/ghost_screen/);
    // It never reached the sidecar.
    expect(helper.requests).toHaveLength(0);
  });

  it("refuses coordinate clicks when ydotool is unusable", async () => {
    const helper = fakeHelper({
      handle: desktopHandler,
      backends: {
        ydotool: { available: false, usable: false, socket: { problem: "socket missing" } },
      },
    });
    const { extension } = await harness(helper);
    await expect(
      extension.call(GHOST_DESKTOP, { action: "click", x: 1, y: 2 }),
    ).rejects.toThrowError(/ax_perform/);
    expect(helper.requests).toHaveLength(0);
  });

  it("says so off a Hyprland session", async () => {
    const helper = fakeHelper({ handle: desktopHandler, inHyprland: false });
    const { extension } = await harness(helper);
    await expect(
      extension.call(GHOST_DESKTOP, { action: "state" }),
    ).rejects.toThrowError(/not a Hyprland session/);
  });

  it("surfaces a sidecar refusal as a GhostError", async () => {
    const helper = fakeHelper({
      handle: (op) => {
        if (op === "focus") {
          throw new GhostError("not_found", "No open window matches 'ghostzilla'", {
            sidecarCode: "harness",
          });
        }
        return desktopHandler(op);
      },
    });
    const { extension } = await harness(helper);
    await expect(
      extension.call(GHOST_DESKTOP, { action: "focus", target: "ghostzilla" }),
    ).rejects.toThrowError(/No open window matches/);
  });
});

describe("ghost_desktop notify (local, not the sidecar)", () => {
  it("shows a notification without touching the helper", async () => {
    const runner = fakeRunner();
    const { extension, helper } = await harness(undefined, runner);
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
    expect(helper.requests).toHaveLength(0);
  });

  it("needs a message", async () => {
    const { extension } = await harness();
    await expect(
      extension.call(GHOST_DESKTOP, { action: "notify" }),
    ).rejects.toThrowError(/needs message/);
  });

  it("degrades clearly when notify-send is missing", async () => {
    const runner = fakeRunner(() => {
      throw missingBinary("notify-send");
    });
    const { extension } = await harness(undefined, runner);
    await expect(
      extension.call(GHOST_DESKTOP, { action: "notify", message: "hi" }),
    ).rejects.toThrowError(/notify-send, which is not installed/);
  });
});

describe("ghost_desktop scope", () => {
  it("gives a visitor no tool and blocks the name outright", async () => {
    const scope = visitorScope("visitor-1");
    const helper = fakeHelper({ handle: desktopHandler });
    const extension = await loadExtensionWith(
      createHyprlandExtension({ scope, helper }),
      makeContext({ cwd: "/tmp/ghost-does-not-matter" }),
    );
    expect(extension.toolNames()).toEqual([]);
    expect(desktopToolNames({ scope })).toEqual([]);
    const blocked = await extension.toolCall(GHOST_DESKTOP);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/visitor conversation/);
    expect(helper.requests).toHaveLength(0);
  });

  it("offers exactly one tool to a creator", async () => {
    const { extension } = await harness();
    expect(extension.toolNames()).toEqual([GHOST_DESKTOP]);
    expect(desktopToolNames()).toEqual([GHOST_DESKTOP]);
    expect(await extension.toolCall(GHOST_DESKTOP)).toBeUndefined();
  });
});
