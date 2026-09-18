import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), "ghost-pi-extensions-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const marker = join(root, "executed");
  const extension = join(root, "extension.ts");
  writeFileSync(extension, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default function () { throw new Error("must not execute"); }
`);
  return { cwd: root, agentDir, marker, extension };
}

it("rejects file extensions before executing their module body", async () => {
  const { cwd, agentDir, marker, extension } = fixture();
  const result = await discoverAndLoadExtensions([extension], cwd, agentDir);
  expect(result.extensions).toEqual([]);
  expect(result.errors).toEqual([{
    path: extension,
    error: "Ghost does not load executable extensions from files.",
  }]);
  expect(existsSync(marker)).toBe(false);
});

it("keeps inline factories working across resource reloads", async () => {
  const { cwd, agentDir, marker, extension } = fixture();
  let loads = 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    additionalExtensionPaths: [extension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => {
      loads++;
      pi.registerCommand("inline-probe", {
        description: "Verify the native extension API.",
        handler: async () => {},
      });
      pi.on("before_agent_start", async () => ({ systemPrompt: "inline policy" }));
    }],
  });
  for (let expectedLoads = 1; expectedLoads <= 2; expectedLoads++) {
    await loader.reload();
    const result = loader.getExtensions();
    expect(loads).toBe(expectedLoads);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.commands.has("inline-probe")).toBe(true);
    expect(result.extensions[0]?.handlers.get("before_agent_start")).toHaveLength(1);
    expect(result.errors).toEqual([{
      path: extension,
      error: "Ghost does not load executable extensions from files.",
    }]);
    expect(result.runtime).toBeDefined();
    expect(existsSync(marker)).toBe(false);
  }
});
