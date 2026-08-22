/**
 * `ghost_screen`.
 *
 * grim and hyprctl are never actually run: the fake runner records the argv the
 * tool builds and writes the file grim would have written. That argv is the
 * point of most of these tests — every value the model supplies has to arrive
 * as a separate argument, never as shell text.
 */
import { readdir, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visitorScope } from "../src/scope.js";
import {
  captureScreen,
  createScreenExtension,
  GHOST_SCREEN,
  pruneScreenshots,
  screenToolNames,
  screenshotFileName,
} from "../src/extensions/screen.js";
import { SCREENSHOTS_DIRNAME, type VisionModel } from "../src/extensions/vision.js";
import { openGhostHome } from "../src/home.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";
import {
  fixtureModel,
  fixtureRegistry,
  fakeRunner,
  loadExtensionWith,
  makeContext,
  missingBinary,
  resultImages,
  resultText,
  TINY_PNG_BASE64,
  type FakeRunner,
} from "./support/desktop-harness.js";

const TEXT_ONLY = fixtureModel({ provider: "local", id: "text-only", input: ["text"] });
const FREE_VISION = fixtureModel({
  provider: "openrouter",
  id: "free-eyes:free",
  input: ["text", "image"],
  costInput: 0,
});
const VISION_CHAT = fixtureModel({
  provider: "openrouter",
  id: "sees-things",
  input: ["text", "image"],
  costInput: 5,
});

const WAYLAND_ENV: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: "wayland-1" };

const ACTIVE_WINDOW_JSON = JSON.stringify({
  address: "0xdeadbeef",
  class: "kitty",
  title: "nvim",
  at: [120, 64],
  size: [1280, 800],
});

/** A runner that behaves like grim: writes a PNG where it was told to. */
function grimRunner(extra: (command: string, args: readonly string[]) => string = () => ""): FakeRunner {
  return fakeRunner(async (command, args) => {
    if (command === "grim") {
      const path = args[args.length - 1];
      if (path) await writeFile(path, Buffer.from(TINY_PNG_BASE64, "base64"));
      return { stdout: "", stderr: "" };
    }
    return { stdout: extra(command, args), stderr: "" };
  });
}

describe("screenshotFileName", () => {
  it("sorts chronologically and is filesystem-safe", () => {
    const name = screenshotFileName(new Date("2026-08-22T10:11:12.345Z"));
    expect(name).toBe("screen-2026-08-22T10-11-12-345.png");
    expect(name).not.toMatch(/[:*?"<>|]/);
  });
});

describe("captureScreen", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
  });
  afterEach(() => fixture.cleanup());

  it("captures the whole output with no geometry", async () => {
    const runner = grimRunner();
    const result = await captureScreen({
      home: openGhostHome(fixture.dir),
      target: "screen",
      run: runner.run,
      env: WAYLAND_ENV,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toBe("grim");
    expect(runner.calls[0]?.args).toEqual([result.path]);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.path.startsWith(join(fixture.dir, SCREENSHOTS_DIRNAME))).toBe(true);
  });

  it("passes a validated region as a single -g argument", async () => {
    const runner = grimRunner();
    const result = await captureScreen({
      home: openGhostHome(fixture.dir),
      target: "region",
      region: "100,80 640x480",
      run: runner.run,
      env: WAYLAND_ENV,
    });
    expect(runner.calls[0]?.args).toEqual(["-g", "100,80 640x480", result.path]);
  });

  it("refuses a region that is not a geometry", async () => {
    await expect(
      captureScreen({
        home: openGhostHome(fixture.dir),
        target: "region",
        region: "0,0 10x10; rm -rf ~",
        run: grimRunner().run,
        env: WAYLAND_ENV,
      }),
    ).rejects.toThrowError(/is not a geometry/);
  });

  it("requires a region when the target is region", async () => {
    await expect(
      captureScreen({
        home: openGhostHome(fixture.dir),
        target: "region",
        run: grimRunner().run,
        env: WAYLAND_ENV,
      }),
    ).rejects.toThrowError(/needs region/);
  });

  it("refuses an output name that is not a monitor name", async () => {
    await expect(
      captureScreen({
        home: openGhostHome(fixture.dir),
        target: "screen",
        output: "DP-1 && curl evil.example",
        run: grimRunner().run,
        env: WAYLAND_ENV,
      }),
    ).rejects.toThrowError(/is not a monitor name/);
  });

  it("takes the focused window's geometry from hyprctl", async () => {
    const runner = grimRunner((command, args) =>
      command === "hyprctl" && args[1] === "activewindow" ? ACTIVE_WINDOW_JSON : "",
    );
    const result = await captureScreen({
      home: openGhostHome(fixture.dir),
      target: "focused_window",
      run: runner.run,
      env: WAYLAND_ENV,
    });
    expect(runner.calls[0]?.args).toEqual(["-j", "activewindow"]);
    expect(runner.calls[1]?.args).toEqual(["-g", "120,64 1280x800", result.path]);
    expect(result.geometry).toBe("120,64 1280x800");
  });

  it("says so when nothing is focused", async () => {
    const runner = grimRunner(() => "{}");
    await expect(
      captureScreen({
        home: openGhostHome(fixture.dir),
        target: "focused_window",
        run: runner.run,
        env: WAYLAND_ENV,
      }),
    ).rejects.toThrowError(/No window is focused/);
  });

  it("degrades with a clear error when grim is not installed", async () => {
    const runner = fakeRunner(() => {
      throw missingBinary("grim");
    });
    await expect(
      captureScreen({
        home: openGhostHome(fixture.dir),
        target: "screen",
        run: runner.run,
        env: WAYLAND_ENV,
      }),
    ).rejects.toThrowError(/grim is not installed/);
  });

  it("degrades with a clear error off Wayland", async () => {
    await expect(
      captureScreen({
        home: openGhostHome(fixture.dir),
        target: "screen",
        run: grimRunner().run,
        env: {},
      }),
    ).rejects.toThrowError(/no Wayland session/);
  });
});

describe("retention", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
  });
  afterEach(() => fixture.cleanup());

  it("keeps only the newest captures", async () => {
    const dir = join(fixture.dir, SCREENSHOTS_DIRNAME);
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < 25; index += 1) {
      const path = join(dir, `screen-${String(index).padStart(3, "0")}.png`);
      await writeFile(path, "x");
      const when = new Date(Date.now() - (25 - index) * 1000);
      await utimes(path, when, when);
    }
    const deleted = await pruneScreenshots(dir, 20);
    expect(deleted).toHaveLength(5);
    const remaining = (await readdir(dir)).sort();
    expect(remaining).toHaveLength(20);
    expect(remaining[0]).toBe("screen-005.png");
  });

  it("is applied after every capture", async () => {
    const home = openGhostHome(fixture.dir);
    const runner = grimRunner();
    for (let index = 0; index < 4; index += 1) {
      await captureScreen({
        home,
        target: "screen",
        run: runner.run,
        env: WAYLAND_ENV,
        retention: 2,
        now: new Date(Date.UTC(2026, 7, 22, 10, 0, index)),
      });
    }
    expect(await readdir(join(fixture.dir, SCREENSHOTS_DIRNAME))).toHaveLength(2);
  });
});

describe("ghost_screen tool", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
  });
  afterEach(() => fixture.cleanup());

  async function harnessFor(chatModel: VisionModel, models: readonly VisionModel[]) {
    const runner = grimRunner();
    const { registry, completions } = fixtureRegistry({
      models: [...models],
      completion: "a settings window with the Save button greyed out",
    });
    const ctx = makeContext({ cwd: fixture.dir, model: chatModel, modelRegistry: registry });
    const harness = await loadExtensionWith(
      createScreenExtension({ run: runner.run, env: WAYLAND_ENV, resize: false }),
      ctx,
    );
    return { harness, runner, completions };
  }

  it("returns the image itself when the chat model can see", async () => {
    const { harness, completions } = await harnessFor(VISION_CHAT, [VISION_CHAT, FREE_VISION]);
    const result = await harness.call(GHOST_SCREEN, { prompt: "What is on screen?" });
    const images = resultImages(result);
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data).toBe(TINY_PNG_BASE64);
    expect(result.details.routedThroughVisionModel).toBe(false);
    // No detour through a second model when the first one has eyes.
    expect(completions).toHaveLength(0);
    expect(resultText(result)).toContain("untrusted");
  });

  it("routes through the vision model, with the caller's question, when it cannot", async () => {
    const { harness, completions } = await harnessFor(TEXT_ONLY, [TEXT_ONLY, FREE_VISION]);
    const result = await harness.call(GHOST_SCREEN, {
      prompt: "Why is the Save button disabled?",
    });
    expect(resultImages(result)).toHaveLength(0);
    expect(resultText(result)).toContain("a settings window with the Save button greyed out");
    expect(result.details.routedThroughVisionModel).toBe(true);
    expect(result.details.visionModel).toBe("openrouter/free-eyes:free");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.prompt).toBe("Why is the Save button disabled?");
  });

  it("names the fix when the ghost has no vision model at all", async () => {
    const { harness } = await harnessFor(TEXT_ONLY, [TEXT_ONLY]);
    await expect(
      harness.call(GHOST_SCREEN, { prompt: "What is on screen?" }),
    ).rejects.toThrowError(/roles\.vision_model/);
  });

  it("saves the capture under the ghost home", async () => {
    const { harness } = await harnessFor(VISION_CHAT, [VISION_CHAT]);
    const result = await harness.call(GHOST_SCREEN, { prompt: "?" });
    expect(String(result.details.path).startsWith(`${SCREENSHOTS_DIRNAME}/`)).toBe(true);
    await expect(stat(join(fixture.dir, String(result.details.path)))).resolves.toBeTruthy();
  });

  it("gives a visitor no tool and blocks the name outright", async () => {
    const scope = visitorScope("visitor-1");
    const { registry } = fixtureRegistry({ models: [VISION_CHAT] });
    const harness = await loadExtensionWith(
      createScreenExtension({ scope, env: WAYLAND_ENV }),
      makeContext({ cwd: fixture.dir, model: VISION_CHAT, modelRegistry: registry }),
    );
    expect(harness.toolNames()).toEqual([]);
    expect(screenToolNames({ scope })).toEqual([]);
    const blocked = await harness.toolCall(GHOST_SCREEN);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/visitor conversation/);
  });

  it("offers exactly one tool to a creator", async () => {
    const { harness } = await harnessFor(VISION_CHAT, [VISION_CHAT]);
    expect(harness.toolNames()).toEqual([GHOST_SCREEN]);
    expect(screenToolNames()).toEqual([GHOST_SCREEN]);
  });
});
