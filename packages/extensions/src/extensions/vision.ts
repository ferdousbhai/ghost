/**
 * Vision fallback: how a ghost sees an image when its own chat model cannot.
 *
 * A ghost is model-agnostic, and the cheapest onboarding models are text-only.
 * pi's provider layer drops image blocks for such a model **silently** — the
 * turn simply proceeds as if no image had been attached. This module closes
 * that hole in two places:
 *
 * 1. **`look_at_image`** — a tool the ghost can call on a file path or on the
 *    screenshot it just took. One round-trip to a resolved vision model, text
 *    back. Registered only when the session's chat model lacks vision; when the
 *    chat model *can* see, the tool is hidden so images keep flowing natively.
 * 2. **Pre-turn substitution** — before each provider request, every image block
 *    in the outgoing context is replaced with
 *    `<image path="…">…description…</image>`. Nothing is dropped, and when no
 *    vision model can be resolved the substitution says so **in the transcript**
 *    rather than pretending the image was seen.
 *
 * Provenance: the two-mechanism design (auto-activated inspect tool + attached-
 * image fallback) is ported from oh-my-pi (MIT, © 2025 Mario Zechner,
 * © 2025-2026 Can Bölük) — `packages/coding-agent/src/tools/inspect-image.ts`,
 * `src/utils/inspect-image-mode.ts`, `src/utils/image-vision-fallback.ts`, and
 * the `@vision` role in `src/config/model-roles.ts`. The pattern is ported; no
 * code is vendored. We differ deliberately in one place: oh-my-pi's `@vision`
 * role has no default chain at all, so a ghost with no `roles.vision_model`
 * would fall through to an arbitrary model. Here the fallback is the *cheapest
 * credentialed vision-capable model in the ghost's own catalogue*, ranked by
 * `cost.input`, and a ghost with none gets a loud, actionable error.
 *
 * Scope: creator only. A visitor session registers no tool and gets a
 * `tool_call` gate that blocks the name outright.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type {
  AgentToolResult,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { GhostError } from "../errors.js";
import type { GhostHome } from "../home.js";
import { isVisitorScope } from "../scope.js";
import { stringEnum } from "../tool-schema.js";
import {
  resolveHome,
  resolveScope,
  textResult,
  type GhostExtensionOptions,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Types borrowed structurally from OMP
// ---------------------------------------------------------------------------

/**
 * OMP's `Model`. Taken structurally off `ExtensionContext` so the extension
 * follows the exact model type supplied by its harness context.
 */
export type VisionModel = NonNullable<ExtensionContext["model"]>;

type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

type ToolContent = ElementOf<AgentToolResult<unknown>["content"]>;

/** OMP's `ImageContent`: base64 `data` plus a `mimeType`. */
export type GhostImageContent = Extract<ToolContent, { type: "image" }>;

type ContextMessage = ElementOf<ContextEvent["messages"]>;

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * Can this model be handed an image?
 *
 * `input` is required on OMP's `Model` type but **optional in its models.json
 * config schema**, so a hand-written OpenAI-compatible provider entry (Ollama,
 * vLLM, a relay) can omit it, and a purely dynamic provider has no static row
 * at all until a catalogue refresh that `PI_OFFLINE` blocks. Missing `input` is
 * therefore read as text-only: guessing "probably vision" would resurrect the
 * silent-drop bug this module exists to remove.
 */
export function hasVision(model: VisionModel | null | undefined): boolean {
  return model?.input?.includes("image") ?? false;
}

// ---------------------------------------------------------------------------
// The vision_model role
// ---------------------------------------------------------------------------

/** A provider/model pair, the same shape the daemon's `roles` block stores. */
export interface VisionModelRef {
  readonly provider: string;
  readonly modelId: string;
}

/** The role name in `<home>/.pi/models.json`. Mirrors `GhostModelRole`. */
export const VISION_MODEL_ROLE = "vision_model";

/** pi's per-ghost config directory inside the ghost home. */
export const GHOST_AGENT_DIRNAME = ".pi";
export const GHOST_MODELS_FILENAME = "models.json";

/**
 * Read `roles.vision_model` from the ghost's own `models.json`.
 *
 * The file belongs to the daemon (`packages/daemon/src/models.ts` owns its
 * schema); this reads the one field it needs rather than importing the daemon,
 * which depends on this package and not the other way round. A missing or
 * malformed file yields `undefined` — the resolution chain then falls through
 * to the cheapest credentialed vision model, which is a better outcome than an
 * unreadable ghost.
 */
export async function readVisionModelRole(
  homeDir: string,
): Promise<VisionModelRef | undefined> {
  let text: string;
  try {
    text = await readFile(
      join(homeDir, GHOST_AGENT_DIRNAME, GHOST_MODELS_FILENAME),
      "utf8",
    );
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const roles = (parsed as { roles?: Record<string, unknown> } | null)?.roles;
  const bound = roles?.[VISION_MODEL_ROLE] as
    | { provider?: unknown; modelId?: unknown }
    | undefined;
  if (typeof bound?.provider !== "string" || typeof bound.modelId !== "string") {
    return undefined;
  }
  if (!bound.provider || !bound.modelId) return undefined;
  return { provider: bound.provider, modelId: bound.modelId };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The slice of pi's `ModelRegistry` this module needs. Narrowed to an interface
 * so the resolution rules can be tested against a fixture registry with no pi
 * runtime at all.
 */
export interface VisionModelCatalog {
  /** Models whose provider has credentials configured for this ghost. */
  available(): readonly VisionModel[];
  find(provider: string, modelId: string): VisionModel | undefined;
  hasCredentials(model: VisionModel): boolean;
}

/** The live catalogue, from the session's own registry. */
export function catalogFromContext(ctx: ExtensionContext): VisionModelCatalog {
  const registry = ctx.modelRegistry;
  return {
    available: () => registry.getAvailable(),
    find: (provider, modelId) => registry.find(provider, modelId),
    hasCredentials: (model) => registry.hasConfiguredAuth(model),
  };
}

export interface ResolvedVisionModel {
  readonly model: VisionModel;
  /** `role` when `roles.vision_model` named it, `cheapest` when ranked. */
  readonly via: "role" | "cheapest";
}

/**
 * No model can look at this image, and the ghost must be told why and how to
 * fix it. Carries `code: "not_found"` so it travels as a `GhostError`, and a
 * `fix` detail naming the exact config key.
 */
export class VisionUnavailableError extends GhostError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("not_found", message, { fix: `roles.${VISION_MODEL_ROLE}`, ...details });
    this.name = "VisionUnavailableError";
  }
}

function modelLabel(model: VisionModel): string {
  return `${model.provider}/${model.id}`;
}

function inputCost(model: VisionModel): number {
  const cost = model.cost?.input;
  return typeof cost === "number" && Number.isFinite(cost)
    ? cost
    : Number.POSITIVE_INFINITY;
}

function outputCost(model: VisionModel): number {
  const cost = model.cost?.output;
  return typeof cost === "number" && Number.isFinite(cost)
    ? cost
    : Number.POSITIVE_INFINITY;
}

/**
 * Every vision-capable, credentialed model this ghost could use, cheapest
 * first. Ties break on output cost and then on `provider/id`, so the choice is
 * stable across runs — a ghost that silently changed which model reads its
 * screenshots between turns would be very hard to reason about.
 */
export function rankVisionModels(
  catalog: VisionModelCatalog,
): readonly VisionModel[] {
  return catalog
    .available()
    .filter((model) => hasVision(model) && catalog.hasCredentials(model))
    .slice()
    .sort((a, b) => {
      const byInput = inputCost(a) - inputCost(b);
      if (byInput !== 0 && Number.isFinite(byInput)) return byInput;
      if (inputCost(a) !== inputCost(b)) return inputCost(a) < inputCost(b) ? -1 : 1;
      const byOutput = outputCost(a) - outputCost(b);
      if (byOutput !== 0 && Number.isFinite(byOutput)) return byOutput;
      if (outputCost(a) !== outputCost(b)) return outputCost(a) < outputCost(b) ? -1 : 1;
      return modelLabel(a).localeCompare(modelLabel(b));
    });
}

/**
 * The resolution chain, in full:
 *
 * 1. `roles.vision_model` — the creator's explicit choice. If it names a model
 *    that is missing, text-only, or uncredentialed, that is an **error**, not a
 *    reason to quietly pick something else: the creator asked for that model.
 * 2. otherwise the cheapest credentialed vision-capable model in the ghost's
 *    catalogue (`rankVisionModels`).
 * 3. otherwise a loud `VisionUnavailableError` naming `roles.vision_model`.
 */
export function resolveVisionModel(
  catalog: VisionModelCatalog,
  ref?: VisionModelRef | undefined,
): ResolvedVisionModel {
  if (ref) {
    const model = catalog.find(ref.provider, ref.modelId);
    if (!model) {
      throw new VisionUnavailableError(
        `This ghost's ${VISION_MODEL_ROLE} role names ${ref.provider}/${ref.modelId}, `
        + "which is not in its model catalogue. Fix roles.vision_model in "
        + `${GHOST_AGENT_DIRNAME}/${GHOST_MODELS_FILENAME}, or declare that provider `
        + "and model there.",
        { provider: ref.provider, modelId: ref.modelId, reason: "unknown_model" },
      );
    }
    if (!hasVision(model)) {
      throw new VisionUnavailableError(
        `This ghost's ${VISION_MODEL_ROLE} role names ${modelLabel(model)}, which does `
        + "not accept image input. Point roles.vision_model at a model whose "
        + '"input" includes "image".',
        { model: modelLabel(model), reason: "no_image_input" },
      );
    }
    if (!catalog.hasCredentials(model)) {
      throw new VisionUnavailableError(
        `This ghost's ${VISION_MODEL_ROLE} role names ${modelLabel(model)}, but there `
        + `are no credentials for "${model.provider}". Add an apiKey to that provider `
        + `in ${GHOST_AGENT_DIRNAME}/${GHOST_MODELS_FILENAME}, or sign in so it lands `
        + `through Ghost's provider login (stored in ${GHOST_AGENT_DIRNAME}/agent.db).`,
        { model: modelLabel(model), reason: "no_credentials" },
      );
    }
    return { model, via: "role" };
  }

  const ranked = rankVisionModels(catalog);
  const cheapest = ranked[0];
  if (!cheapest) {
    throw new VisionUnavailableError(
      "This ghost cannot look at images: no model in its catalogue accepts image "
      + `input with credentials configured. Set roles.${VISION_MODEL_ROLE} in `
      + `${GHOST_AGENT_DIRNAME}/${GHOST_MODELS_FILENAME} to a vision-capable model `
      + "(one whose \"input\" includes \"image\") and make sure that provider is "
      + "authenticated.",
      { candidates: catalog.available().length, reason: "none_available" },
    );
  }
  return { model: cheapest, via: "cheapest" };
}

// ---------------------------------------------------------------------------
// The one round-trip
// ---------------------------------------------------------------------------

export interface VisionRequest {
  readonly model: VisionModel;
  readonly image: GhostImageContent;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly signal?: AbortSignal | undefined;
}

/** One completion against the vision model. Injectable for tests. */
export type VisionCompleter = (
  request: VisionRequest,
  ctx: ExtensionContext,
) => Promise<string>;

export const VISION_SYSTEM_PROMPT =
  "You are describing an image for someone who cannot see it. Answer the "
  + "question directly and concretely: name what is actually visible, quote text "
  + "verbatim when it is legible, and say \"not visible\" rather than guessing. "
  + "No preamble.";

/**
 * The default completer: one non-streaming call through the session's own
 * registry, which resolves the provider's credentials the same way a chat turn
 * would. Deliberately not a sub-agent — a loop, a tool allowlist, and a second
 * transcript buy nothing for "describe this image".
 */
export const completeWithRegistry: VisionCompleter = async (request, ctx) => {
  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "image" as const, data: request.image.data, mimeType: request.image.mimeType },
        { type: "text" as const, text: request.prompt },
      ],
      timestamp: Date.now(),
    },
  ];
  // Keep accepting the completion seam exposed by older/custom registries.
  // OMP 18's native registry resolves credentials and completeSimple owns the
  // provider call; deterministic extension tests intentionally use this seam.
  const compatibleComplete = (ctx.modelRegistry as unknown as {
    complete?: (model: VisionModel, context: {
      systemPrompt: string;
      messages: typeof messages;
    }) => ReturnType<typeof completeSimple>;
  }).complete;
  const response = compatibleComplete
    ? await compatibleComplete(request.model, {
        systemPrompt: request.systemPrompt,
        messages,
      })
    : await completeSimple(
        request.model,
        { systemPrompt: [request.systemPrompt], messages },
        {
          apiKey: ctx.modelRegistry.resolver(request.model),
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
  if (response.stopReason === "error") {
    throw new VisionUnavailableError(
      `${modelLabel(request.model)} failed to read the image: `
      + (response.errorMessage ?? "the provider returned an error."),
      { model: modelLabel(request.model), reason: "provider_error" },
    );
  }
  if (response.stopReason === "aborted") {
    throw new VisionUnavailableError(
      `${modelLabel(request.model)} was interrupted before it described the image.`,
      { model: modelLabel(request.model), reason: "aborted" },
    );
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (!text) {
    throw new VisionUnavailableError(
      `${modelLabel(request.model)} returned no text for the image.`,
      { model: modelLabel(request.model), reason: "empty_response" },
    );
  }
  return text;
};

// ---------------------------------------------------------------------------
// Images on disk
// ---------------------------------------------------------------------------

/**
 * Where `ghost_screen` writes its captures. Declared here, not in `screen.ts`,
 * so `look_at_image` can offer "the screenshot you just took" without importing
 * the capture module — the dependency runs screen → vision, never back.
 */
export const SCREENSHOTS_DIRNAME = ".screenshots";

/** Where pre-turn substitution parks attached images, content-addressed. */
export const IMAGES_DIRNAME = ".images";

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Largest image we will read off disk and hand to a provider. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The screenshot resize contract, from oh-my-pi's browser and computer tools:
 * 1024×1024 / 150 KB / JPEG q70. Providers that silently downscale a larger
 * image break coordinates and cost real money for pixels nobody reads.
 */
export const IMAGE_RESIZE_OPTIONS = {
  maxWidth: 1024,
  maxHeight: 1024,
  maxBytes: 150 * 1024,
  jpegQuality: 70,
} as const;

/** Shrink an image toward the resize contract. Injectable for tests. */
export type ImageResizer = (
  image: GhostImageContent,
) => Promise<GhostImageContent>;

/**
 * pi ships a Photon/WASM resizer and returns `null` when it is unavailable, so
 * a failure here degrades to the original bytes rather than to no image.
 */
export const resizeWithPi: ImageResizer = async (image) => {
  try {
    const resized = await resizeImage(image, { ...IMAGE_RESIZE_OPTIONS });
    return { type: "image", data: resized.data, mimeType: resized.mimeType };
  } catch {
    return image;
  }
};

/**
 * The MIME a path's extension claims, or `undefined` when the extension is not a
 * known image type. It must NEVER default-guess `image/png`: on the send path an
 * unknown extension is an error the model sees, not a silent relabel that would
 * ship arbitrary bytes (a note, `.pi/agent.db`) to the vision provider.
 */
function mimeForPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXTENSION_MIMES[ext];
}

/**
 * The image formats `EXTENSION_MIMES` covers, keyed by their leading magic
 * bytes. Returns the detected MIME, or `undefined` when the bytes are not one of
 * them — an extension is a claim, and this is the proof.
 */
function sniffImageMime(bytes: Buffer): string | undefined {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: "GIF87a" / "GIF89a"
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 4) === "GIF8") {
    return "image/gif";
  }
  // WebP: "RIFF" <4-byte size> "WEBP"
  if (
    bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function extensionForMime(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? "png";
}

/**
 * Read an image the ghost named. Paths are resolved inside the ghost home and
 * must stay there: a ghost that can point its vision model at `/etc/shadow`
 * renders the whole no-filesystem stance decorative.
 */
export async function readImageFile(
  home: GhostHome,
  path: string,
): Promise<{ image: GhostImageContent; absolutePath: string }> {
  const absolute = isAbsolute(path) ? resolvePath(path) : resolvePath(home.dir, path);
  if (absolute !== home.dir && !absolute.startsWith(home.dir + sep)) {
    throw new GhostError(
      "invalid_path",
      `${JSON.stringify(path)} is outside this ghost's home. Images must live under `
      + "the ghost home, such as .screenshots/…",
      { path },
    );
  }
  // The `.pi/` directory holds this ghost's credentials and model config
  // (`agent.db`, legacy `auth.json`, `models.json`), never an image. A prompt-injected
  // look_at_image({ path: ".pi/agent.db" }) must not be able to base64 those
  // secrets and ship them to a vision provider — refuse the directory outright,
  // before any bytes are read, even if a file in it somehow had an image name.
  const piDir = join(home.dir, GHOST_AGENT_DIRNAME);
  if (absolute === piDir || absolute.startsWith(piDir + sep)) {
    throw new GhostError(
      "invalid_path",
      `${JSON.stringify(path)} is inside the ${GHOST_AGENT_DIRNAME}/ config directory, which `
      + "holds credentials, not images. Point at a real image, such as .screenshots/…",
      { path },
    );
  }
  // The extension must be a known image type. An unknown extension is an error
  // the model sees, not a silent relabel to image/png that hands arbitrary
  // bytes to the vision provider.
  if (!mimeForPath(absolute)) {
    throw new GhostError(
      "invalid_path",
      `${JSON.stringify(path)} is not a supported image. Supported extensions: `
      + `${Object.keys(EXTENSION_MIMES).sort().join(", ")}.`,
      { path },
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GhostError("not_found", `There is no image at ${JSON.stringify(path)}.`, {
        path,
      });
    }
    throw error;
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new GhostError(
      "limit_exceeded",
      `${JSON.stringify(path)} is ${Math.round(bytes.byteLength / 1024)} KB, over the `
      + `${Math.round(MAX_IMAGE_BYTES / 1024)} KB limit for one image.`,
      { path, bytes: bytes.byteLength },
    );
  }
  // Defense in depth: an image extension is a claim, the leading bytes are the
  // proof. A note or credential database renamed `something.png` is rejected here rather
  // than base64'd and posted to the provider (which would 400 — after the secret
  // has already left the machine). The sniffed type, not the extension, is what
  // we label the payload, so a real JPEG named `.png` is sent honestly.
  const sniffedMime = sniffImageMime(bytes);
  if (!sniffedMime) {
    throw new GhostError(
      "invalid_format",
      `${JSON.stringify(path)} has an image extension but its contents are not a supported `
      + "image (PNG, JPEG, GIF, or WebP).",
      { path },
    );
  }
  return {
    image: { type: "image", data: bytes.toString("base64"), mimeType: sniffedMime },
    absolutePath: absolute,
  };
}

/** The newest file in the ghost home's `.screenshots/`, or null. */
export async function findLatestScreenshot(home: GhostHome): Promise<string | null> {
  const dir = join(home.dir, SCREENSHOTS_DIRNAME);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!(name.slice(name.lastIndexOf(".") + 1).toLowerCase() in EXTENSION_MIMES)) continue;
    const path = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path ?? null;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const GHOST_LOOK_AT_IMAGE = "look_at_image";

export const GHOST_VISION_TOOL_NAMES = [GHOST_LOOK_AT_IMAGE] as const;

/**
 * `auto` mirrors oh-my-pi's `inspect_image.mode`: register the tool only when
 * the chat model cannot see. Exposing it to a model that *can* see is not
 * harmless — it teaches the model to route images through a second, weaker
 * model instead of just looking at them.
 */
export type VisionMode = "auto" | "on" | "off";

/** How the extension finds `roles.vision_model`. */
export type VisionModelResolver = (
  home: GhostHome,
  ctx: ExtensionContext,
) => Promise<VisionModelRef | undefined> | VisionModelRef | undefined;

export interface VisionExtensionOptions extends GhostExtensionOptions {
  /** Defaults to `auto`. */
  readonly mode?: VisionMode;
  /**
   * The vision model binding. A ref pins it; a resolver computes it. Omitted,
   * `roles.vision_model` is read from the ghost's own `models.json`.
   */
  readonly visionModel?: VisionModelRef | VisionModelResolver;
  /** Test seam: the catalogue to resolve against. */
  readonly catalog?: (ctx: ExtensionContext) => VisionModelCatalog;
  /** Test seam: the completion call. */
  readonly complete?: VisionCompleter;
  /** Test seam: image downscaling. `false` sends the original bytes. */
  readonly resize?: ImageResizer | false;
  /** Cap on images rewritten per provider request. Defaults to 4. */
  readonly maxImagesPerRequest?: number;
}

export const DEFAULT_MAX_IMAGES_PER_REQUEST = 4;

function refResolver(
  options: VisionExtensionOptions,
): VisionModelResolver {
  const configured = options.visionModel;
  if (typeof configured === "function") return configured;
  if (configured) return () => configured;
  return (home) => readVisionModelRole(home.dir);
}

function resizerFor(options: VisionExtensionOptions): ImageResizer {
  if (options.resize === false) return async (image) => image;
  return options.resize ?? resizeWithPi;
}

export interface LookAtImageInput {
  readonly home: GhostHome;
  readonly image: GhostImageContent;
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Resolve a vision model and describe one image. Exported because `ghost_screen`
 * routes through exactly this when the chat model cannot see its capture.
 */
export async function lookAtImage(
  input: LookAtImageInput,
  options: VisionExtensionOptions,
  ctx: ExtensionContext,
): Promise<{ description: string; model: string; via: "role" | "cheapest" }> {
  const catalog = (options.catalog ?? catalogFromContext)(ctx);
  const ref = await refResolver(options)(input.home, ctx);
  const resolved = resolveVisionModel(catalog, ref);
  const complete = options.complete ?? completeWithRegistry;
  const image = await resizerFor(options)(input.image);
  const description = await complete(
    {
      model: resolved.model,
      image,
      prompt: input.prompt,
      systemPrompt: VISION_SYSTEM_PROMPT,
      signal: input.signal,
    },
    ctx,
  );
  return { description, model: modelLabel(resolved.model), via: resolved.via };
}

// ---------------------------------------------------------------------------
// Pre-turn substitution
// ---------------------------------------------------------------------------

export const SUBSTITUTION_PROMPT =
  "Describe this image in full. Transcribe any readable text verbatim, then "
  + "describe the layout and anything else visible. Someone will act on your "
  + "description without seeing the image.";

function hashImage(image: GhostImageContent): string {
  return createHash("sha256").update(image.data).digest("hex").slice(0, 16);
}

function isImageContent(part: unknown): part is GhostImageContent {
  return (part as { type?: unknown } | null)?.type === "image";
}

/**
 * Park an attached image in the ghost home, content-addressed, and cache its
 * description beside it. The transform runs on **every** provider request, so
 * without the cache a single attached image would be re-described once per turn
 * for the rest of the conversation.
 */
async function storeAndDescribe(
  image: GhostImageContent,
  home: GhostHome,
  options: VisionExtensionOptions,
  ctx: ExtensionContext,
  memo: Map<string, string>,
): Promise<{ path: string; description: string }> {
  const hash = hashImage(image);
  const dir = join(home.dir, IMAGES_DIRNAME);
  const imagePath = join(dir, `image-${hash}.${extensionForMime(image.mimeType)}`);
  const relative = home.relative(imagePath);
  const cached = memo.get(hash);
  if (cached !== undefined) return { path: relative, description: cached };

  await mkdir(dir, { recursive: true });
  const descriptionPath = join(dir, `image-${hash}.txt`);
  try {
    const onDisk = (await readFile(descriptionPath, "utf8")).trim();
    if (onDisk) {
      memo.set(hash, onDisk);
      return { path: relative, description: onDisk };
    }
  } catch {
    // Not described yet.
  }

  await writeFile(imagePath, Buffer.from(image.data, "base64"));
  const { description } = await lookAtImage(
    { home, image, prompt: SUBSTITUTION_PROMPT },
    options,
    ctx,
  );
  await writeFile(descriptionPath, `${description}\n`, "utf8");
  memo.set(hash, description);
  return { path: relative, description };
}

/**
 * Rewrite image blocks in the outgoing context into text the chat model can
 * actually read. Returns the original array untouched when there is nothing to
 * do, so the common case costs one scan.
 */
export function createVisionContextTransform(
  options: VisionExtensionOptions = {},
): ExtensionHandler<ContextEvent, { messages?: ContextMessage[] }> {
  const memo = new Map<string, string>();
  const maxImages = options.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST;

  return async (event, ctx) => {
    // The chat model can see: leave every image exactly as it is.
    if (hasVision(ctx.model)) return;

    const messages = event.messages;
    if (!messages.some((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) && content.some(isImageContent);
    })) {
      return;
    }

    const home = resolveHome(options, ctx);
    let budget = maxImages;
    const rewritten: ContextMessage[] = [];

    for (const message of messages) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content) || !content.some(isImageContent)) {
        rewritten.push(message);
        continue;
      }
      const parts: ToolContent[] = [];
      for (const part of content as ToolContent[]) {
        if (!isImageContent(part)) {
          parts.push(part);
          continue;
        }
        if (budget <= 0) {
          parts.push({
            type: "text",
            text:
              "<image omitted=\"too many images in this turn\">This turn carried more "
              + `than ${maxImages} images. Ask about one at a time with `
              + `${GHOST_LOOK_AT_IMAGE}.</image>`,
          });
          continue;
        }
        budget -= 1;
        try {
          const { path, description } = await storeAndDescribe(part, home, options, ctx, memo);
          parts.push({
            type: "text",
            text: `<image path="${path}">\n${description}\n</image>`,
          });
        } catch (error) {
          // Loud, in the transcript, and actionable. The one thing this must
          // never do is let the image fall off the request in silence.
          const reason = error instanceof Error ? error.message : String(error);
          parts.push({
            type: "text",
            text:
              `<image unread="true">Someone attached an image and this ghost could not `
              + `read it: ${reason}</image>`,
          });
        }
      }
      rewritten.push({ ...(message as object), content: parts } as ContextMessage);
    }

    return { messages: rewritten };
  };
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

/**
 * `look_at_image` is creator-only. A visitor session registers nothing and gets
 * this gate, so the name is refused even if some other extension registered it.
 */
export function createVisionToolGate(
  options: VisionExtensionOptions = {},
): ExtensionHandler<ToolCallEvent, ToolCallEventResult> {
  const scope = resolveScope(options);
  const mode = options.mode ?? "auto";
  return (event, ctx) => {
    if (event.toolName !== GHOST_LOOK_AT_IMAGE) return;
    if (isVisitorScope(scope)) {
      return {
        block: true,
        reason: `${GHOST_LOOK_AT_IMAGE} is not available in a visitor conversation.`,
      };
    }
    // auto: the chat model can see for itself, so refuse the detour.
    if (mode === "auto" && hasVision(ctx.model)) {
      return {
        block: true,
        reason:
          "This model reads images directly — look at the attached image instead of "
          + `calling ${GHOST_LOOK_AT_IMAGE}.`,
      };
    }
    return;
  };
}

/** The tool names this extension offers in a scope. Empty for visitors. */
export function visionToolNames(options: VisionExtensionOptions = {}): string[] {
  if (isVisitorScope(resolveScope(options))) return [];
  if ((options.mode ?? "auto") === "off") return [];
  return [GHOST_LOOK_AT_IMAGE];
}

function deactivateTool(pi: ExtensionAPI, name: string): void {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
    return;
  }
  const active = pi.getActiveTools();
  if (!active.includes(name)) return;
  pi.setActiveTools(active.filter((tool) => tool !== name));
}

export function createVisionExtension(
  options: VisionExtensionOptions = {},
): ExtensionFactory {
  const scope = resolveScope(options);
  const mode = options.mode ?? "auto";

  return (pi: ExtensionAPI) => {
    if (isVisitorScope(scope)) {
      pi.on("tool_call", createVisionToolGate(options));
      return;
    }
    if (mode === "off") return;

    pi.registerTool({
      name: GHOST_LOOK_AT_IMAGE,
      label: "Look at image",
      description:
        "Look at an image and answer a question about it. Use it for a screenshot "
        + "you just took, or for an image file in your home. You cannot see images "
        + "yourself in this conversation; this hands the image to a model that can "
        + "and returns what it saw in words.",
      parameters: Type.Object({
        prompt: Type.String({
          description:
            "What you want to know about the image. Be specific: what to read, "
            + "what to identify, what to compare.",
        }),
        source: Type.Optional(stringEnum(["path", "latest_screenshot"], {
          description:
            "path: read the image named by path. latest_screenshot: use the most "
            + "recent capture from ghost_screen. Defaults to path.",
        })),
        path: Type.Optional(Type.String({
          description:
            "Path to the image, relative to your home, such as "
            + ".screenshots/screen-2026-08-22T10-00-00.png. Required unless source "
            + "is latest_screenshot.",
        })),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const home = resolveHome(options, ctx);
        const source = params.source ?? "path";
        let path: string;
        if (source === "latest_screenshot") {
          const latest = await findLatestScreenshot(home);
          if (!latest) {
            throw new GhostError(
              "not_found",
              `There are no screenshots yet. Take one with ghost_screen, or pass a `
              + "path.",
              { source },
            );
          }
          path = latest;
        } else {
          if (!params.path || params.path.trim() === "") {
            throw new GhostError(
              "invalid_path",
              "Pass path, or set source to latest_screenshot.",
              { source },
            );
          }
          path = params.path.trim();
        }

        const { image, absolutePath } = await readImageFile(home, path);
        const looked = await lookAtImage(
          { home, image, prompt: params.prompt, signal },
          options,
          ctx,
        );
        return textResult(looked.description, {
          path: home.relative(absolutePath),
          model: looked.model,
          resolvedVia: looked.via,
        });
      },
    });

    // auto: hide the tool the moment the session's own model can see. The gate
    // below is the enforcement; this keeps it off the model's tool list so it
    // is never tempted in the first place.
    if (mode === "auto") {
      const sync = (_event: unknown, ctx: ExtensionContext): void => {
        if (hasVision(ctx.model)) deactivateTool(pi, GHOST_LOOK_AT_IMAGE);
      };
      pi.on("session_start", sync);
      pi.on("before_agent_start", sync);
    }

    pi.on("tool_call", createVisionToolGate(options));
    pi.on("context", createVisionContextTransform(options));
  };
}

/** Creator-scope vision fallback over the session's own ghost home. */
export default createVisionExtension();
