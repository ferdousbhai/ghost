import { describe, expect, it } from "vitest";
import {
  BROWSER_ACTIONS,
  GHOST_BROWSER,
} from "../src/extensions/browser.js";
import { createGhostExtension } from "../src/extensions/index.js";
import { relayBackend } from "../src/extensions/browser-relay-backend.js";
import { loadExtension } from "./support/harness.js";

interface JsonSchema {
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly type?: string;
}

describe("stringEnum", () => {

  it("keeps every registered string enum strict-provider compatible", async () => {
    const harness = await loadExtension(
      createGhostExtension({ backend: relayBackend({}), desktop: { listTools: async () => [], callTool: async () => ({ content: [] }) } }),
      "/tmp/ghost-tool-schema-test",
    );
    const expected = [
      [GHOST_BROWSER, "action", BROWSER_ACTIONS],
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
