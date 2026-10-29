import { describe, expect, test } from "vitest";
import { toolCall } from "../src/remote-tool-call.js";
import { REMOTE_VIEWER_HTML } from "../src/remote-viewer.js";

// The viewer's running-call line reads as the HUD's does (pi's convention):
// the call itself, never what came back.
describe("remote viewer tool call", () => {
  test("calls read the way pi shows them", () => {
    expect(toolCall("bash", { command: "pnpm test" }, "")).toBe("$ pnpm test");
    expect(toolCall("read", { path: "docs/design.md", offset: 10, limit: 31 }, "")).toBe("read docs/design.md:10-40");
    expect(toolCall("write", { path: "notes.md" }, "")).toBe("write notes.md");
    expect(toolCall("ls", {}, "")).toBe("ls .");
    expect(toolCall("grep", { pattern: "retry", path: "src", glob: "*.ts" }, "")).toBe("grep /retry/ in src (*.ts)");
    expect(toolCall("find", { pattern: "*.qml" }, "")).toBe("find *.qml in .");
  });

  test("each harness's spelling reads the same", () => {
    expect(toolCall("Read", { file_path: "/tmp/notes.md" }, "")).toBe("read /tmp/notes.md");
    expect(toolCall("shell", { command: ["bash", "-lc", "git status"] }, "")).toBe("$ git status");
    expect(toolCall("apply_patch", { input: "*** Begin Patch\n*** Update File: src/app.ts\n@@" }, "")).toBe("edit src/app.ts");
  });

  test("paths read short: inside the call's directory, relative; home as ~", () => {
    expect(toolCall("read", { path: "/work/repo/notes.md" }, "/work/repo")).toBe("read notes.md");
    expect(toolCall("read", { path: "/home/owner/.config/hypr/bindings.lua" }, "/work/repo")).toBe("read ~/.config/hypr/bindings.lua");
  });

  test("Ghost's desktop tools keep a phrase; anything else shows its name and arguments", () => {
    expect(toolCall("mcp__ghost__desktop_look", { image: true }, "")).toBe("Checking what’s on screen");
    expect(toolCall("ghost.desktop_act", { steps: [{ do: "type" }] }, "")).toBe("Typing on the desktop");
    expect(toolCall("todo", { action: "add", text: "ship it" }, "")).toBe("todo action: add, text: ship it");
    const long = toolCall("fetch", { url: "https://example.com/" + "x".repeat(200) }, "");
    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
  });

  test("the page script embeds it, and still parses", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(REMOTE_VIEWER_HTML)?.[1] ?? "";
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("function toolCall");
    expect(script).toContain("ev.summary.replace(/\\s+/g");
  });
});
