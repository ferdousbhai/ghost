import { describe, expect, it } from "vitest";
import {
  BROWSER_ACTIONS,
  GHOST_BROWSER,
} from "../src/extensions/browser.js";
import {
  AX_SET_ATTRIBUTES,
  DESKTOP_ACTIONS,
  GHOST_DESKTOP,
  NOTIFY_URGENCIES,
} from "../src/extensions/hyprland.js";
import { createGhostExtension } from "../src/extensions/index.js";
import { relayBackend } from "../src/extensions/browser-relay-backend.js";
import {
  GHOST_SCREEN,
  SCREEN_TARGETS,
} from "../src/extensions/screen.js";
import { stringEnum } from "../src/tool-schema.js";
import { loadExtension } from "./support/harness.js";

interface JsonSchema {
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly type?: string;
}

describe("stringEnum", () => {
  it("emits a JSON Schema string type alongside the enum", () => {
    const schema = stringEnum(["first", "second"], { description: "An example." });
    expect(schema).toMatchObject({
      type: "string",
      enum: ["first", "second"],
      description: "An example.",
    });
  });

  it("keeps every registered string enum strict-provider compatible", async () => {
    const harness = await loadExtension(
      createGhostExtension({ backend: relayBackend({}) }),
      "/tmp/ghost-tool-schema-test",
    );
    const expected = [
      [GHOST_BROWSER, "action", BROWSER_ACTIONS],
      [GHOST_DESKTOP, "action", DESKTOP_ACTIONS],
      [GHOST_DESKTOP, "attribute", AX_SET_ATTRIBUTES],
      [GHOST_DESKTOP, "coordinate_space", ["screen", "window"]],
      [GHOST_DESKTOP, "urgency", NOTIFY_URGENCIES],
      [GHOST_SCREEN, "target", SCREEN_TARGETS],
    ] as const;

    for (const [toolName, fieldName, values] of expected) {
      const parameters = harness.tools.get(toolName)?.parameters as JsonSchema | undefined;
      const field = parameters?.properties?.[fieldName];
      expect(field, `${toolName}.${fieldName}`).toBeDefined();
      expect(field?.type, `${toolName}.${fieldName}.type`).toBe("string");
      expect(field?.enum, `${toolName}.${fieldName}.enum`).toEqual([...values]);
    }
  });
});
