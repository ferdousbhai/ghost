/**
 * `ghost_screen`.
 *
 * Capture goes through the desktop-helper sidecar, injected here as a
 * {@link fakeHelper} — no `grim`, no process, no desktop. The assertions are:
 * the op + args the tool sends for each target, that the PNG the sidecar returns
 * is saved under the ghost home with retention, that a vision-capable chat model
 * gets the pixels while a text-only model gets text that names the saved file
 * and tells it to call `inspect_image` (a tool-result image block would be
 * silently dropped for such a model), and that the capture's honesty metadata
 * (which backend, background-safe or not, warnings) reaches the model.
 */
import { readdir, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visitorScope } from "../src/scope.js";
import {
  captureViaHelper,
  createScreenExtension,
  GHOST_SCREEN,
  MAX_WATCH_FRAMES,
  parseRegion,
  pruneScreenshots,
  SCREENSHOTS_DIRNAME,
  screenToolNames,
  screenshotFileName,
} from "../src/extensions/screen.js";
import { openGhostHome } from "../src/home.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";
import {
  fixtureModel,
  fakeHelper,
  loadExtensionWith,
  makeContext,
  resultImages,
  resultText,
  TINY_PNG_BASE64,
  type FakeHelper,
  type FixtureModel,
} from "./support/desktop-harness.js";

const TEXT_ONLY = fixtureModel({ provider: "local", id: "text-only", input: ["text"] });
const VISION_CHAT = fixtureModel({
  provider: "openrouter",
  id: "sees-things",
  input: ["text", "image"],
  costInput: 5,
});

/** A sidecar that answers state + capture; capture honesty is configurable. */
function captureHelper(capture: Record<string, unknown> = {}): FakeHelper {
  return fakeHelper({
    handle: (op) => {
      if (op === "state") {
        return { activewindow: { address: "0xdeadbeef", class: "kitty" } };
      }
      if (op === "capture") {
        return {
          png_base64: TINY_PNG_BASE64,
          width: 1,
          height: 1,
          backend: "grim-foreign-toplevel",
          background_safe: true,
          interference: [],
          warnings: [],
          ...capture,
        };
      }
      return {};
    },
  });
}

describe("screenshotFileName", () => {
  it("sorts chronologically and is filesystem-safe", () => {
    const name = screenshotFileName(new Date("2026-08-22T10:11:12.345Z"));
    expect(name).toBe("screen-2026-08-22T10-11-12-345.png");
    expect(name).not.toMatch(/[:*?"<>|]/);
  });
});

describe("parseRegion", () => {
  it("parses X,Y WxH into the sidecar rect", () => {
    expect(parseRegion("100,80 640x480")).toEqual({ x: 100, y: 80, width: 640, height: 480 });
  });

  it("refuses anything that is not a geometry", () => {
    expect(() => parseRegion("0,0 10x10; rm -rf ~")).toThrowError(/is not a geometry/);
  });
});

describe("captureViaHelper", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
  });
  afterEach(() => fixture.cleanup());

  it("captures a whole screen and saves the PNG under the home", async () => {
    const helper = captureHelper();
    const capture = await captureViaHelper({
      helper,
      home: openGhostHome(fixture.dir),
      target: "screen",
    });
    expect(helper.requests).toEqual([{ op: "capture", args: { target: "screen" } }]);
    expect(capture.bytes).toBeGreaterThan(0);
    expect(capture.image.data).toBe(TINY_PNG_BASE64);
    expect(capture.path.startsWith(join(fixture.dir, SCREENSHOTS_DIRNAME))).toBe(true);
    await expect(stat(capture.path)).resolves.toBeTruthy();
  });

  it("captures a named window through the background-safe ladder", async () => {
    const helper = captureHelper();
    await captureViaHelper({
      helper,
      home: openGhostHome(fixture.dir),
      target: "window",
      window: "firefox",
    });
    expect(helper.requests[0]).toEqual({
      op: "capture",
      args: { target: "window", name: "firefox" },
    });
  });

  it("captures the focused window by resolving its address from state", async () => {
    const helper = captureHelper();
    await captureViaHelper({
      helper,
      home: openGhostHome(fixture.dir),
      target: "window",
    });
    expect(helper.requests.map((r) => r.op)).toEqual(["state", "capture"]);
    expect(helper.requests[1]).toEqual({
      op: "capture",
      args: { target: "window", address: "0xdeadbeef" },
    });
  });

  it("passes a validated region through", async () => {
    const helper = captureHelper();
    await captureViaHelper({
      helper,
      home: openGhostHome(fixture.dir),
      target: "region",
      region: "100,80 640x480",
    });
    expect(helper.requests[0]).toEqual({
      op: "capture",
      args: { target: "region", region: { x: 100, y: 80, width: 640, height: 480 } },
    });
  });

  it("refuses a region that is not a geometry", async () => {
    await expect(
      captureViaHelper({
        helper: captureHelper(),
        home: openGhostHome(fixture.dir),
        target: "region",
        region: "nope",
      }),
    ).rejects.toThrowError(/is not a geometry/);
  });

  it("refuses an output name that is not a monitor name", async () => {
    await expect(
      captureViaHelper({
        helper: captureHelper(),
        home: openGhostHome(fixture.dir),
        target: "screen",
        output: "DP-1 && curl evil.example",
      }),
    ).rejects.toThrowError(/is not a monitor name/);
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
    expect((await readdir(dir)).sort()[0]).toBe("screen-005.png");
  });

  it("is applied after every capture", async () => {
    const home = openGhostHome(fixture.dir);
    const helper = captureHelper();
    for (let index = 0; index < 4; index += 1) {
      await captureViaHelper({
        helper,
        home,
        target: "screen",
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

  async function harnessFor(
    chatModel: FixtureModel,
    helper: FakeHelper = captureHelper(),
  ) {
    const ctx = makeContext({ cwd: fixture.dir, model: chatModel });
    const harness = await loadExtensionWith(createScreenExtension({ helper }), ctx);
    return { harness, helper };
  }

  it("returns the image itself when the chat model can see", async () => {
    const { harness, helper } = await harnessFor(VISION_CHAT);
    const result = await harness.call(GHOST_SCREEN, { prompt: "What is on screen?" });
    expect(helper.requests).toEqual([{ op: "capture", args: { target: "screen" } }]);
    const images = resultImages(result);
    expect(images).toHaveLength(1);
    expect(images[0]?.data).toBe(TINY_PNG_BASE64);
    expect(result.details.backend).toBe("grim-foreign-toplevel");
    expect(result.details.mimeType).toBe("image/png");
    expect(resultText(result)).toContain("untrusted");
  });

  it("gives a text-only model the file and an inspect_image instruction", async () => {
    const { harness } = await harnessFor(TEXT_ONLY);
    const result = await harness.call(GHOST_SCREEN, {
      prompt: "Why is the Save button disabled?",
      target: "window",
      window: "firefox",
    });
    // A tool-result image block would be replaced by a placeholder at the
    // provider layer for this model, so there must not be one.
    expect(resultImages(result)).toHaveLength(0);

    const saved = String(result.details.savedTo);
    expect(saved.startsWith(join(fixture.dir, SCREENSHOTS_DIRNAME))).toBe(true);
    await expect(stat(saved)).resolves.toBeTruthy();
    const text = resultText(result);
    expect(text).toContain(`saved to ${saved}`);
    expect(text).toContain('window "firefox"');
    expect(text).toContain("image/png");
    expect(text).toContain(`${result.details.bytes} bytes`);
    expect(text).toContain(`call inspect_image with path="${saved}"`);
    expect(text).toContain("Why is the Save button disabled?");
    expect(text).toContain("untrusted");
    expect(result.details.routedThroughVisionModel).toBeUndefined();
  });

  it("still reports honesty metadata to a text-only model", async () => {
    const { harness } = await harnessFor(
      TEXT_ONLY,
      captureHelper({
        backend: "grim-region",
        background_safe: false,
        warnings: ["region capture reads only currently-composited pixels"],
      }),
    );
    const result = await harness.call(GHOST_SCREEN, {
      prompt: "?",
      target: "region",
      region: "0,0 10x10",
    });
    expect(resultText(result)).toMatch(/changed what the user sees/);
    expect(result.details.background_safe).toBe(false);
  });

  it("surfaces honesty metadata when the shot disturbed the desktop", async () => {
    const helper = captureHelper({
      backend: "grim-region",
      background_safe: false,
      warnings: ["region capture reads only currently-composited pixels"],
      interference: ["focus-region"],
    });
    const { harness } = await harnessFor(VISION_CHAT, helper);
    const result = await harness.call(GHOST_SCREEN, { prompt: "?", target: "region", region: "0,0 10x10" });
    expect(resultText(result)).toMatch(/changed what the user sees/);
    expect(result.details.background_safe).toBe(false);
    expect(result.details.warnings).toContain(
      "region capture reads only currently-composited pixels",
    );
  });

  it("passes a window target and window through to the sidecar", async () => {
    const { harness, helper } = await harnessFor(VISION_CHAT);
    await harness.call(GHOST_SCREEN, { prompt: "?", target: "window", window: "firefox" });
    expect(helper.requests[0]).toEqual({
      op: "capture",
      args: { target: "window", name: "firefox" },
    });
  });

  it("saves the capture under the ghost home", async () => {
    const { harness } = await harnessFor(VISION_CHAT);
    const result = await harness.call(GHOST_SCREEN, { prompt: "?" });
    expect(String(result.details.path).startsWith(`${SCREENSHOTS_DIRNAME}/`)).toBe(true);
    await expect(stat(join(fixture.dir, String(result.details.path)))).resolves.toBeTruthy();
  });

  it("gives a visitor no tool and blocks the name outright", async () => {
    const scope = visitorScope("visitor-1");
    const harness = await loadExtensionWith(
      createScreenExtension({ scope, helper: captureHelper() }),
      makeContext({ cwd: fixture.dir, model: VISION_CHAT }),
    );
    expect(harness.toolNames()).toEqual([]);
    expect(screenToolNames({ scope })).toEqual([]);
    const blocked = await harness.toolCall(GHOST_SCREEN);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/visitor conversation/);
  });

  it("offers exactly one tool to a creator", async () => {
    const { harness } = await harnessFor(VISION_CHAT);
    expect(harness.toolNames()).toEqual([GHOST_SCREEN]);
    expect(screenToolNames()).toEqual([GHOST_SCREEN]);
  });

  it("watch hands a vision model a sequence of frames", async () => {
    const { harness, helper } = await harnessFor(VISION_CHAT);
    const result = await harness.call(GHOST_SCREEN, {
      prompt: "Did the spinner finish?",
      mode: "watch",
      frames: 3,
      interval: 0,
    });
    // three capture ops, one per frame
    expect(helper.requests.filter((r) => r.op === "capture")).toHaveLength(3);
    const images = resultImages(result);
    expect(images).toHaveLength(3);
    expect(result.details.mode).toBe("watch");
    expect(result.details.frames).toBe(3);
    expect(Array.isArray(result.details.savedTo)).toBe(true);
    expect((result.details.savedTo as string[])).toHaveLength(3);
    expect(resultText(result)).toContain("untrusted");
  });

  it("watch saves every frame under the ghost home", async () => {
    const { harness } = await harnessFor(VISION_CHAT);
    const result = await harness.call(GHOST_SCREEN, {
      prompt: "?",
      mode: "watch",
      frames: 3,
      interval: 0,
    });
    for (const saved of result.details.savedTo as string[]) {
      await expect(stat(saved)).resolves.toBeTruthy();
    }
  });

  it("watch gives a text-only model the paths and an inspect_image instruction", async () => {
    const { harness } = await harnessFor(TEXT_ONLY);
    const result = await harness.call(GHOST_SCREEN, {
      prompt: "What changed?",
      mode: "watch",
      frames: 2,
      interval: 0,
    });
    expect(resultImages(result)).toHaveLength(0);
    const text = resultText(result);
    expect(text).toContain("inspect_image");
    expect(text).toContain("What changed?");
    expect(text).toContain("untrusted");
    for (const saved of result.details.savedTo as string[]) {
      expect(text).toContain(saved);
    }
  });

  it("watch clamps the frame count to the ceiling", async () => {
    const { harness, helper } = await harnessFor(VISION_CHAT);
    const result = await harness.call(GHOST_SCREEN, {
      prompt: "?",
      mode: "watch",
      frames: 999,
      interval: 0,
    });
    expect(helper.requests.filter((r) => r.op === "capture")).toHaveLength(MAX_WATCH_FRAMES);
    expect(result.details.frames).toBe(MAX_WATCH_FRAMES);
  });
});
