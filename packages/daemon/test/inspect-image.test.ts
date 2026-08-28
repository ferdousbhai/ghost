import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createInspectImageTool } from "../src/inspect-image.js";

// A 1x1 white PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

function model(id: string, input: Array<"text" | "image">): Model<never> {
  return { provider: "fake", id, name: id, input, contextWindow: 1000, maxTokens: 100 } as unknown as Model<never>;
}

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("inspect_image", () => {
  it("points a sighted model at read and describes the image for a blind one", async () => {
    dir = mkdtempSync(join(tmpdir(), "ghost-inspect-"));
    writeFileSync(join(dir, "shot.png"), PNG);
    const seen: Context[] = [];
    const vision = model("eyes", ["text", "image"]);
    const tool = createInspectImageTool({
      cwd: dir,
      visionModel: () => ({ provider: "fake", modelId: "eyes" }),
      runtime: {
        getModel: (_provider, id) => (id === "eyes" ? vision : undefined),
        complete: async (_model, context) => {
          seen.push(context);
          return { role: "assistant", content: [{ type: "text", text: "A white pixel." }], stopReason: "stop" } as unknown as AssistantMessage;
        },
      },
    });

    const sighted = await tool.execute("c1", { path: "shot.png" }, undefined, undefined, { model: model("chat", ["text", "image"]) } as never);
    expect(sighted.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/call read with path .*shot\.png/) });
    expect(seen).toHaveLength(0);

    const described = await tool.execute("c2", { path: join(dir, "shot.png"), question: "Which colour?" }, undefined, undefined, { model: model("blind", ["text"]) } as never);
    expect(described.details).toMatchObject({ path: join(dir, "shot.png"), mimeType: "image/png", visionModel: "fake/eyes" });
    expect(described.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^<untrusted source="image shot\.png described by fake\/eyes" id="[0-9a-f]+">\nA white pixel\./),
    });
    expect(seen[0]?.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Which colour?" }, { type: "image", mimeType: "image/png", data: expect.any(String) }],
    });
  });

  it("refuses non-images, missing files, and a blind model without a vision model", async () => {
    dir = mkdtempSync(join(tmpdir(), "ghost-inspect-"));
    writeFileSync(join(dir, "notes.txt"), "text");
    writeFileSync(join(dir, "shot.png"), PNG);
    const tool = createInspectImageTool({
      cwd: dir,
      visionModel: () => null,
      runtime: { getModel: () => undefined, complete: async () => { throw new Error("unreachable"); } },
    });
    const blind = { model: model("blind", ["text"]) } as never;
    await expect(tool.execute("c", { path: "notes.txt" }, undefined, undefined, blind)).rejects.toThrow(/not an image/);
    await expect(tool.execute("c", { path: "shot.png" }, undefined, undefined, blind)).rejects.toThrow(/roles\.vision_model/);

    const sighted = createInspectImageTool({
      cwd: dir,
      visionModel: () => ({ provider: "fake", modelId: "eyes" }),
      runtime: { getModel: () => model("eyes", ["text", "image"]), complete: async () => { throw new Error("unreachable"); } },
    });
    await expect(sighted.execute("c", { path: "missing.png" }, undefined, undefined, blind)).rejects.toThrow(/ENOENT/);
  });
});
