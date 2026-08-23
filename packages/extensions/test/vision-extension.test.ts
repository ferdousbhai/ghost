/**
 * The vision fallback.
 *
 * The rules under test are the ones that decide whether a ghost sees an image
 * at all, so they are exercised against a fixture catalogue with real `input`
 * and `cost` values rather than against a mock that already agrees with them.
 * The adversarial cases are the two that would be silent in production: a
 * provider entry with no `input` field (must read as text-only) and a ghost
 * with no vision model at all (must be loud).
 */
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhostError } from "../src/errors.js";
import { GhostHome } from "../src/home.js";
import { visitorScope } from "../src/scope.js";
import {
  createVisionExtension,
  GHOST_LOOK_AT_IMAGE,
  hasVision,
  IMAGES_DIRNAME,
  rankVisionModels,
  readImageFile,
  readVisionModelRole,
  resolveVisionModel,
  SCREENSHOTS_DIRNAME,
  visionToolNames,
  VisionUnavailableError,
  type VisionModel,
  type VisionModelCatalog,
} from "../src/extensions/vision.js";
import { createGhostFixture, type GhostFixture } from "./support/fixture.js";
import {
  fixtureModel,
  fixtureRegistry,
  loadExtensionWith,
  makeContext,
  resultText,
  TINY_PNG_BASE64,
} from "./support/desktop-harness.js";

const TEXT_ONLY = fixtureModel({ provider: "local", id: "text-only", input: ["text"] });
const NO_INPUT_FIELD = fixtureModel({ provider: "ollama", id: "llama-hand-written" });
const CHEAP_VISION = fixtureModel({
  provider: "openrouter",
  id: "cheap-eyes",
  input: ["text", "image"],
  costInput: 0.03,
});
const FREE_VISION = fixtureModel({
  provider: "openrouter",
  id: "free-eyes:free",
  input: ["text", "image"],
  costInput: 0,
  costOutput: 0,
});
const PRICEY_VISION = fixtureModel({
  provider: "anthropic",
  id: "expensive-eyes",
  input: ["text", "image"],
  costInput: 3,
});
const VISION_CHAT = fixtureModel({
  provider: "openrouter",
  id: "sees-things",
  input: ["text", "image"],
  costInput: 5,
});

function catalogOf(
  models: readonly VisionModel[],
  credentialed?: readonly string[],
): VisionModelCatalog {
  const allowed = new Set(credentialed ?? models.map((model) => model.provider));
  return {
    available: () => models.filter((model) => allowed.has(model.provider)),
    find: (provider, modelId) =>
      models.find((model) => model.provider === provider && model.id === modelId),
    hasCredentials: (model) => allowed.has(model.provider),
  };
}

describe("hasVision", () => {
  it("is true only when input names image", () => {
    expect(hasVision(VISION_CHAT)).toBe(true);
    expect(hasVision(TEXT_ONLY)).toBe(false);
  });

  it("treats a missing input field as text-only", () => {
    // A hand-written OpenAI-compatible provider entry may omit `input`
    // entirely. Guessing "probably vision" here is how images get dropped.
    expect(hasVision(NO_INPUT_FIELD)).toBe(false);
  });

  it("treats an unknown model as text-only", () => {
    expect(hasVision(undefined)).toBe(false);
    expect(hasVision(null)).toBe(false);
  });
});

describe("resolveVisionModel", () => {
  it("raises a loud, actionable error when no model can see", () => {
    const catalog = catalogOf([TEXT_ONLY, NO_INPUT_FIELD]);
    let thrown: unknown;
    try {
      resolveVisionModel(catalog);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VisionUnavailableError);
    expect(thrown).toBeInstanceOf(GhostError);
    const error = thrown as VisionUnavailableError;
    expect(error.message).toContain("roles.vision_model");
    expect(error.message).toContain("image");
    expect(error.details["fix"]).toBe("roles.vision_model");
    expect(error.details["reason"]).toBe("none_available");
  });

  it("picks the only vision model when there is exactly one", () => {
    const resolved = resolveVisionModel(catalogOf([TEXT_ONLY, PRICEY_VISION]));
    expect(resolved.model.id).toBe("expensive-eyes");
    expect(resolved.via).toBe("cheapest");
  });

  it("picks the cheapest by cost.input when there are several", () => {
    const resolved = resolveVisionModel(
      catalogOf([PRICEY_VISION, CHEAP_VISION, FREE_VISION, TEXT_ONLY]),
    );
    expect(resolved.model.id).toBe("free-eyes:free");
    expect(rankVisionModels(catalogOf([PRICEY_VISION, CHEAP_VISION, FREE_VISION])).map(
      (model) => model.id,
    )).toEqual(["free-eyes:free", "cheap-eyes", "expensive-eyes"]);
  });

  it("breaks ties deterministically, on output cost then name", () => {
    const b = fixtureModel({ provider: "b", id: "m", input: ["text", "image"], costInput: 1, costOutput: 9 });
    const a = fixtureModel({ provider: "a", id: "m", input: ["text", "image"], costInput: 1, costOutput: 9 });
    const cheaperOutput = fixtureModel({
      provider: "z",
      id: "m",
      input: ["text", "image"],
      costInput: 1,
      costOutput: 2,
    });
    const ranked = rankVisionModels(catalogOf([b, a, cheaperOutput]));
    expect(ranked.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "z/m",
      "a/m",
      "b/m",
    ]);
  });

  it("ignores vision models whose provider has no credentials", () => {
    const catalog = catalogOf([FREE_VISION, PRICEY_VISION], ["anthropic"]);
    const resolved = resolveVisionModel(catalog);
    expect(resolved.model.id).toBe("expensive-eyes");
  });

  it("honours roles.vision_model even when it is not the cheapest", () => {
    const resolved = resolveVisionModel(
      catalogOf([FREE_VISION, PRICEY_VISION]),
      { provider: "anthropic", modelId: "expensive-eyes" },
    );
    expect(resolved.model.id).toBe("expensive-eyes");
    expect(resolved.via).toBe("role");
  });

  it("refuses a role that names a model the ghost does not have", () => {
    expect(() =>
      resolveVisionModel(catalogOf([FREE_VISION]), { provider: "openai", modelId: "gpt-9" }),
    ).toThrowError(/openai\/gpt-9/);
  });

  it("refuses a role that names a text-only model rather than silently switching", () => {
    let thrown: unknown;
    try {
      resolveVisionModel(catalogOf([TEXT_ONLY, FREE_VISION]), {
        provider: "local",
        modelId: "text-only",
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as VisionUnavailableError).details["reason"]).toBe("no_image_input");
  });

  it("refuses a role whose provider has no credentials", () => {
    let thrown: unknown;
    try {
      resolveVisionModel(catalogOf([FREE_VISION], []), {
        provider: "openrouter",
        modelId: "free-eyes:free",
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as VisionUnavailableError).details["reason"]).toBe("no_credentials");
  });
});

describe("readVisionModelRole", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
  });
  afterEach(() => fixture.cleanup());

  it("is undefined when there is no models.json", async () => {
    expect(await readVisionModelRole(fixture.dir)).toBeUndefined();
  });

  it("reads roles.vision_model", async () => {
    await mkdir(join(fixture.dir, ".pi"), { recursive: true });
    await writeFile(
      join(fixture.dir, ".pi", "models.json"),
      JSON.stringify({
        providers: {},
        roles: {
          chat_model: { provider: "openrouter", modelId: "text-only" },
          vision_model: { provider: "openrouter", modelId: "free-eyes:free" },
        },
      }),
      "utf8",
    );
    expect(await readVisionModelRole(fixture.dir)).toEqual({
      provider: "openrouter",
      modelId: "free-eyes:free",
    });
  });

  it("is undefined, not a throw, when models.json is malformed", async () => {
    await mkdir(join(fixture.dir, ".pi"), { recursive: true });
    await writeFile(join(fixture.dir, ".pi", "models.json"), "{ not json", "utf8");
    expect(await readVisionModelRole(fixture.dir)).toBeUndefined();
  });
});

describe("readImageFile", () => {
  // The harness calls the read/validation path directly, exactly as the audit
  // notes the tool harness does — schema coercion is not what is under test.
  // What is under test is the P0: look_at_image must never base64 a non-image
  // (a private note, `.pi/auth.json`) and ship it to a vision provider.
  let fixture: GhostFixture;
  let home: GhostHome;

  beforeEach(async () => {
    fixture = await createGhostFixture();
    home = new GhostHome(fixture.dir);
    await mkdir(join(fixture.dir, SCREENSHOTS_DIRNAME), { recursive: true });
  });
  afterEach(() => fixture.cleanup());

  it("reads a real PNG and labels it by its true type", async () => {
    await writeFile(
      join(fixture.dir, SCREENSHOTS_DIRNAME, "real.png"),
      Buffer.from(TINY_PNG_BASE64, "base64"),
    );
    const { image } = await readImageFile(home, `${SCREENSHOTS_DIRNAME}/real.png`);
    expect(image.type).toBe("image");
    expect(image.mimeType).toBe("image/png");
    expect(image.data).toBe(TINY_PNG_BASE64);
  });

  it("rejects a non-image file wearing a spoofed .png name", async () => {
    // A secret note renamed to look like a screenshot. Magic-byte sniffing must
    // catch it before the bytes are handed to the provider.
    await writeFile(
      join(fixture.dir, SCREENSHOTS_DIRNAME, "secret.png"),
      "these are private credentials, not pixels",
      "utf8",
    );
    let thrown: unknown;
    try {
      await readImageFile(home, `${SCREENSHOTS_DIRNAME}/secret.png`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GhostError);
    expect((thrown as GhostError).code).toBe("invalid_format");
    expect((thrown as GhostError).message).toMatch(/not a supported image/);
  });

  it("refuses .pi/auth.json outright — this is the exfiltration path", async () => {
    await mkdir(join(fixture.dir, ".pi"), { recursive: true });
    await writeFile(
      join(fixture.dir, ".pi", "auth.json"),
      JSON.stringify({ anthropic: { apiKey: "sk-secret" } }),
      "utf8",
    );
    let thrown: unknown;
    try {
      await readImageFile(home, ".pi/auth.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GhostError);
    expect((thrown as GhostError).code).toBe("invalid_path");
    expect((thrown as GhostError).message).toMatch(/\.pi\/ config directory/);
  });

  it("refuses a file in .pi even when it is a genuine image", async () => {
    // The directory is excluded outright, before any read: a valid PNG dropped
    // into .pi is still refused, so no credential-adjacent file is ever a source.
    await mkdir(join(fixture.dir, ".pi"), { recursive: true });
    await writeFile(
      join(fixture.dir, ".pi", "decoy.png"),
      Buffer.from(TINY_PNG_BASE64, "base64"),
    );
    await expect(readImageFile(home, ".pi/decoy.png")).rejects.toThrowError(
      /\.pi\/ config directory/,
    );
  });

  it("rejects an unknown, non-image extension", async () => {
    await writeFile(
      join(fixture.dir, "notes.txt"),
      "a private note the model tried to look at",
      "utf8",
    );
    let thrown: unknown;
    try {
      await readImageFile(home, "notes.txt");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GhostError);
    expect((thrown as GhostError).code).toBe("invalid_path");
    expect((thrown as GhostError).message).toMatch(/not a supported image/);
  });
});

describe("look_at_image registration", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
  });
  afterEach(() => fixture.cleanup());

  function context(model: VisionModel | undefined) {
    const { registry } = fixtureRegistry({ models: [TEXT_ONLY, FREE_VISION, VISION_CHAT] });
    return makeContext({ cwd: fixture.dir, model, modelRegistry: registry });
  }

  it("registers the tool for a creator on a text-only chat model", async () => {
    const harness = await loadExtensionWith(
      createVisionExtension({ resize: false }),
      context(TEXT_ONLY),
    );
    expect(harness.toolNames()).toEqual([GHOST_LOOK_AT_IMAGE]);
    expect(await harness.toolCall(GHOST_LOOK_AT_IMAGE)).toBeUndefined();
  });

  it("hides and blocks the tool when the chat model can already see", async () => {
    const harness = await loadExtensionWith(
      createVisionExtension({ resize: false }),
      context(VISION_CHAT),
    );
    await harness.sessionStart();
    expect(harness.activeTools).not.toContain(GHOST_LOOK_AT_IMAGE);
    const blocked = await harness.toolCall(GHOST_LOOK_AT_IMAGE);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/reads images directly/);
  });

  it("keeps the tool on a vision chat model when mode is on", async () => {
    const harness = await loadExtensionWith(
      createVisionExtension({ mode: "on", resize: false }),
      context(VISION_CHAT),
    );
    await harness.sessionStart();
    expect(harness.activeTools).toContain(GHOST_LOOK_AT_IMAGE);
    expect(await harness.toolCall(GHOST_LOOK_AT_IMAGE)).toBeUndefined();
  });

  it("registers nothing when mode is off", async () => {
    const harness = await loadExtensionWith(
      createVisionExtension({ mode: "off" }),
      context(TEXT_ONLY),
    );
    expect(harness.toolNames()).toEqual([]);
    expect(visionToolNames({ mode: "off" })).toEqual([]);
  });

  it("gives a visitor no tool and blocks the name outright", async () => {
    const scope = visitorScope("visitor-1");
    const harness = await loadExtensionWith(
      createVisionExtension({ scope, resize: false }),
      context(TEXT_ONLY),
    );
    expect(harness.toolNames()).toEqual([]);
    expect(visionToolNames({ scope })).toEqual([]);
    const blocked = await harness.toolCall(GHOST_LOOK_AT_IMAGE);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/visitor conversation/);
  });
});

describe("look_at_image", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
    await mkdir(join(fixture.dir, SCREENSHOTS_DIRNAME), { recursive: true });
  });
  afterEach(() => fixture.cleanup());

  async function writeShot(name: string, mtime: Date): Promise<string> {
    const path = join(fixture.dir, SCREENSHOTS_DIRNAME, name);
    await writeFile(path, Buffer.from(TINY_PNG_BASE64, "base64"));
    await utimes(path, mtime, mtime);
    return path;
  }

  async function harnessFor(completion = "a red square") {
    const { registry, completions } = fixtureRegistry({
      models: [TEXT_ONLY, FREE_VISION, PRICEY_VISION],
      completion,
    });
    const ctx = makeContext({ cwd: fixture.dir, model: TEXT_ONLY, modelRegistry: registry });
    const harness = await loadExtensionWith(createVisionExtension({ resize: false }), ctx);
    return { harness, completions };
  }

  it("describes an image by path, through the cheapest vision model", async () => {
    await writeShot("screen-1.png", new Date());
    const { harness, completions } = await harnessFor("a terminal with an error");
    const result = await harness.call(GHOST_LOOK_AT_IMAGE, {
      prompt: "What does the error say?",
      path: `${SCREENSHOTS_DIRNAME}/screen-1.png`,
    });
    expect(resultText(result)).toBe("a terminal with an error");
    expect(result.details.model).toBe("openrouter/free-eyes:free");
    expect(result.details.resolvedVia).toBe("cheapest");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.prompt).toBe("What does the error say?");
  });

  it("uses the most recent screenshot when asked for it", async () => {
    await writeShot("screen-old.png", new Date(Date.now() - 60_000));
    await writeShot("screen-new.png", new Date());
    const { harness } = await harnessFor();
    const result = await harness.call(GHOST_LOOK_AT_IMAGE, {
      prompt: "What is on screen?",
      source: "latest_screenshot",
    });
    expect(result.details.path).toBe(`${SCREENSHOTS_DIRNAME}/screen-new.png`);
  });

  it("says so when there are no screenshots yet", async () => {
    const { harness } = await harnessFor();
    await expect(
      harness.call(GHOST_LOOK_AT_IMAGE, { prompt: "?", source: "latest_screenshot" }),
    ).rejects.toThrowError(/no screenshots yet/);
  });

  it("refuses a path outside the ghost home", async () => {
    const { harness } = await harnessFor();
    await expect(
      harness.call(GHOST_LOOK_AT_IMAGE, { prompt: "?", path: "../../etc/hostname" }),
    ).rejects.toThrowError(/outside this ghost's home/);
  });

  it("refuses a path-source call with no path", async () => {
    const { harness } = await harnessFor();
    await expect(
      harness.call(GHOST_LOOK_AT_IMAGE, { prompt: "?" }),
    ).rejects.toThrowError(/Pass path/);
  });

  it("names the fix when no vision model exists", async () => {
    await writeShot("screen-1.png", new Date());
    const { registry } = fixtureRegistry({ models: [TEXT_ONLY] });
    const ctx = makeContext({ cwd: fixture.dir, model: TEXT_ONLY, modelRegistry: registry });
    const harness = await loadExtensionWith(createVisionExtension({ resize: false }), ctx);
    await expect(
      harness.call(GHOST_LOOK_AT_IMAGE, {
        prompt: "?",
        path: `${SCREENSHOTS_DIRNAME}/screen-1.png`,
      }),
    ).rejects.toThrowError(/roles\.vision_model/);
  });
});

describe("pre-turn image substitution", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
  });
  afterEach(() => fixture.cleanup());

  const imageMessage = () => ({
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
    ],
    timestamp: 1,
  });

  async function harnessFor(chatModel: VisionModel, models: readonly VisionModel[]) {
    const { registry, completions } = fixtureRegistry({
      models: [...models],
      completion: "a one-pixel transparent square",
    });
    const ctx = makeContext({ cwd: fixture.dir, model: chatModel, modelRegistry: registry });
    const harness = await loadExtensionWith(createVisionExtension({ resize: false }), ctx);
    return { harness, completions };
  }

  it("leaves images alone when the chat model can see", async () => {
    const { harness, completions } = await harnessFor(VISION_CHAT, [VISION_CHAT, FREE_VISION]);
    const messages = [imageMessage()];
    expect(await harness.transformContext(messages)).toBe(messages);
    expect(completions).toHaveLength(0);
  });

  it("replaces an image with a path and a description for a text-only model", async () => {
    const { harness, completions } = await harnessFor(TEXT_ONLY, [TEXT_ONLY, FREE_VISION]);
    const [message] = (await harness.transformContext([imageMessage()])) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(message?.content).toHaveLength(2);
    expect(message?.content[0]?.text).toBe("what is this?");
    const substituted = message?.content[1];
    expect(substituted?.type).toBe("text");
    expect(substituted?.text).toMatch(/^<image path="\.images\/image-[0-9a-f]{16}\.png">/);
    expect(substituted?.text).toContain("a one-pixel transparent square");
    expect(completions).toHaveLength(1);

    // The bytes are parked in the home, so the path in the transcript is real.
    const match = /path="([^"]+)"/.exec(substituted?.text ?? "");
    const parked = await readFile(join(fixture.dir, match?.[1] ?? ""), "base64");
    expect(parked).toBe(TINY_PNG_BASE64);
    expect(match?.[1]?.startsWith(`${IMAGES_DIRNAME}/`)).toBe(true);
  });

  it("describes each image once, however many turns it survives", async () => {
    const { harness, completions } = await harnessFor(TEXT_ONLY, [TEXT_ONLY, FREE_VISION]);
    await harness.transformContext([imageMessage()]);
    await harness.transformContext([imageMessage()]);
    await harness.transformContext([imageMessage()]);
    expect(completions).toHaveLength(1);
  });

  it("says so in the transcript when it cannot read the image", async () => {
    const { harness } = await harnessFor(TEXT_ONLY, [TEXT_ONLY]);
    const [message] = (await harness.transformContext([imageMessage()])) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    const substituted = message?.content[1];
    expect(substituted?.type).toBe("text");
    // Loud, in-band, and naming the fix — never a silently dropped image.
    expect(substituted?.text).toContain("could not read it");
    expect(substituted?.text).toContain("roles.vision_model");
  });

  it("caps how many images one request may rewrite", async () => {
    const { registry, completions } = fixtureRegistry({
      models: [TEXT_ONLY, FREE_VISION],
      completion: "described",
    });
    const ctx = makeContext({ cwd: fixture.dir, model: TEXT_ONLY, modelRegistry: registry });
    const harness = await loadExtensionWith(
      createVisionExtension({ resize: false, maxImagesPerRequest: 1 }),
      ctx,
    );
    const many = {
      role: "user",
      content: [
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: `${TINY_PNG_BASE64.slice(0, -4)}AA==`, mimeType: "image/png" },
      ],
      timestamp: 1,
    };
    const [message] = (await harness.transformContext([many])) as Array<{
      content: Array<{ text?: string }>;
    }>;
    expect(completions).toHaveLength(1);
    expect(message?.content[1]?.text).toContain("more than 1 images");
  });
});

/**
 * The suite above drives a scripted stand-in for pi's extension runtime. This
 * loads the real thing — pi's own loader, compiling these files from source and
 * registering against the real `ExtensionAPI` — so the harness is not testing a
 * fiction about how tools get registered.
 */
describe("pi's own extension loader", () => {
  let fixture: GhostFixture;

  beforeEach(async () => {
    fixture = await createGhostFixture();
  });
  afterEach(() => fixture.cleanup());

  it("loads vision, screen, and desktop with no errors", async () => {
    const src = fileURLToPath(new URL("../src/extensions", import.meta.url));
    const result = await discoverAndLoadExtensions(
      ["vision", "screen", "hyprland"].map((name) => join(src, `${name}.ts`)),
      fixture.dir,
      // A directory that does not exist, so no ambient user extensions load.
      join(fixture.root, "no-agent-dir"),
    );
    expect(result.errors).toEqual([]);
    const byFile = new Map(
      result.extensions.map((extension) => [extension.path.split("/").at(-1), extension]),
    );
    expect([...byFile.get("vision.ts")!.tools.keys()]).toEqual([GHOST_LOOK_AT_IMAGE]);
    expect([...byFile.get("screen.ts")!.tools.keys()]).toEqual(["ghost_screen"]);
    expect([...byFile.get("hyprland.ts")!.tools.keys()]).toEqual(["ghost_desktop"]);
  });
});
