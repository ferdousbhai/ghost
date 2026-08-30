import { describe, expect, it } from "vitest";
import { renderPiRuntimeGuidance } from "../src/pi-extension-bridge.js";

describe("Pi principal runtime guidance", () => {
  it("keeps cwd and active tool snippets without inherited prompt material", () => {
    const rendered = renderPiRuntimeGuidance({
      cwd: "/repo/packages/app",
      selectedTools: ["read", "task", "custom_without_snippet"],
      toolSnippets: {
        read: "Read a file",
        task: "Delegate coding work",
      },
      promptGuidelines: ["INHERITED-GUIDELINE"],
      appendSystemPrompt: "AMBIENT-APPEND",
      contextFiles: [{ path: "/repo/AGENTS.md", content: "DUPLICATE-CONTEXT" }],
    });

    expect(rendered).toBe([
      "# Runtime",
      "Current working directory: /repo/packages/app",
      "Active tools:",
      "- read: Read a file",
      "- task: Delegate coding work",
      "- custom_without_snippet",
    ].join("\n"));
    expect(rendered).not.toContain("INHERITED-GUIDELINE");
    expect(rendered).not.toContain("AMBIENT-APPEND");
    expect(rendered).not.toContain("DUPLICATE-CONTEXT");
  });
});
