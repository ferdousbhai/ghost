import {
  failedGraphScenario,
  preImportRepairScenario,
  replacementScenario,
} from "./claude-agent-sdk-loader.integration.js";
import { describe, expect, it } from "vitest";

describe("ClaudeAgentSdkLoader with Bun's default dynamic importer", () => {
  it("blocks a replaced loaded module until a fresh process loads v2", () => {
    expect(replacementScenario()).toContain("fresh loader loaded v2");
  });

  it("keeps a repaired failed graph restart-required until a fresh process", () => {
    expect(failedGraphScenario()).toContain("remains restart-required");
  });

  it("loads an install repaired before the first import in the same process", () => {
    expect(preImportRepairScenario()).toContain("without restart");
  });
});
