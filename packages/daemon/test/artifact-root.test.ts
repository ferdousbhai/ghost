import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listOmpExtensionRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadGhostHookExtensions,
  scopeGhostSessionArtifactRediscovery,
  withGhostArtifactRoot,
} from "../src/artifact-root.js";

let home: string | null = null;

function makeHome(): string {
  home = mkdtempSync(join(tmpdir(), "ghost-artifact-root-"));
  return home;
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("ghost artifact loading", () => {
  it("scopes OMP package discovery to the visible home without writing .omp", async () => {
    const dir = makeHome();

    const roots = await withGhostArtifactRoot(dir, async () => {
      await Promise.resolve();
      return listOmpExtensionRoots({ cwd: dir, home: homedir(), repoRoot: null });
    });

    expect(roots).toEqual([{ path: dir, name: dir.split("/").at(-1), level: "user" }]);
    expect(existsSync(join(dir, ".omp"))).toBe(false);
  });

  it("keeps both rediscovery entry points inside the home after rebinding", async () => {
    const dir = makeHome();
    const observed: string[][] = [];
    const observe = async (): Promise<void> => {
      const roots = await listOmpExtensionRoots({
        // The operational cwd of an unbound conversation, which native OMP
        // discovery would otherwise treat as a package root.
        cwd: homedir(),
        home: homedir(),
        repoRoot: null,
      });
      observed.push(roots.map((root) => root.path));
    };
    const session = { refreshSkills: observe, prompt: observe } as unknown as AgentSession;

    scopeGhostSessionArtifactRediscovery(session, dir);
    await session.refreshSkills();
    await session.prompt("proof the sheet");

    // #37: these two methods are the whole enforcement surface. Anything that
    // silently drops one falls back to cwd discovery, so both are pinned here.
    expect(observed).toEqual([[dir], [dir]]);
  });

  it("preloads only executable hook files from the home", async () => {
    const dir = makeHome();
    mkdirSync(join(dir, "hooks", "pre"), { recursive: true });
    mkdirSync(join(dir, "hooks", "post"), { recursive: true });
    const visibleMarker = join(dir, "visible-ran");
    const hiddenRegularMarker = join(dir, "hidden-regular-ran");
    const hiddenSymlinkMarker = join(dir, "hidden-symlink-ran");
    writeFileSync(
      join(dir, "hooks", "pre", "before.ts"),
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(visibleMarker)}, "ran");
       export default () => {};`,
      "utf8",
    );
    writeFileSync(join(dir, "hooks", "post", "after.js"), "export default () => {}", "utf8");
    writeFileSync(join(dir, "hooks", "post", "notes.md"), "not executable", "utf8");
    writeFileSync(
      join(dir, "hooks", "pre", ".hidden.js"),
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(hiddenRegularMarker)}, "ran");
       export default () => {};`,
      "utf8",
    );
    const hiddenOutside = join(dir, "hidden-outside.ts");
    writeFileSync(
      hiddenOutside,
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(hiddenSymlinkMarker)}, "ran");
       export default () => {};`,
      "utf8",
    );
    symlinkSync(hiddenOutside, join(dir, "hooks", "post", ".hidden-link.ts"));

    const loaded = await loadGhostHookExtensions(dir);

    expect(loaded.errors).toEqual([]);
    expect(loaded.factories).toHaveLength(2);
    expect(existsSync(visibleMarker)).toBe(true);
    expect(existsSync(hiddenRegularMarker)).toBe(false);
    expect(existsSync(hiddenSymlinkMarker)).toBe(false);
  });

  it("rejects a hook entry symlink without evaluating its outside target", async () => {
    const dir = makeHome();
    const hooks = join(dir, "hooks", "pre");
    mkdirSync(hooks, { recursive: true });
    const marker = join(dir, "outside-ran");
    const outside = join(dir, "outside.ts");
    writeFileSync(
      outside,
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(marker)}, "ran");
       export default () => {};
      `,
    );
    const link = join(hooks, "outside.ts");
    symlinkSync(outside, link);

    const loaded = await loadGhostHookExtensions(dir);

    expect(loaded.factories).toEqual([]);
    expect(loaded.errors).toEqual([
      { path: link, error: "Hook entry is not a regular file." },
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it("evaluates the pinned regular hook when its final entry is exchanged", async () => {
    const dir = makeHome();
    const hooks = join(dir, "hooks", "pre");
    mkdirSync(hooks, { recursive: true });
    const entry = join(hooks, "before.ts");
    const pinned = join(hooks, "before-pinned.ts");
    const outside = join(dir, "outside.ts");
    writeFileSync(entry, `export default (api: any) => api.registerTool({ name: "pinned" });`);
    writeFileSync(outside, `export default (api: any) => api.registerTool({ name: "outside" });`);

    const loaded = await loadGhostHookExtensions(dir, {
      afterOpen: (path) => {
        if (path !== entry) return;
        renameSync(entry, pinned);
        symlinkSync(outside, entry);
      },
    });
    const registered: string[] = [];
    await loaded.factories[0]?.({
      registerTool: (tool: { name: string }) => registered.push(tool.name),
    } as never);

    expect(loaded.errors).toEqual([]);
    expect(registered).toEqual(["pinned"]);
  });
});
