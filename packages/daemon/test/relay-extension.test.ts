/**
 * The extension half is plain JavaScript with no build step, which is what makes
 * it editable-and-reloadable but also means its copy of the protocol is not
 * typechecked against the TypeScript one. This file is the seam between them:
 * `extension/protocol.js` has no `chrome` API in it, so it imports cleanly into
 * Node and can simply be compared, constant for constant.
 *
 * The manifest assertions are the other half of the point. The relay's whole
 * security claim rests on the extension having *no standing access to any page* —
 * no host permissions, no content scripts, no `chrome.scripting`, only
 * `chrome.debugger`, which Chrome cannot attach without drawing its own banner.
 * That is a property a future convenience commit could quietly delete, so it is
 * pinned here rather than only in a README.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RELAY_OPS,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
} from "../src/relay-protocol.js";

const EXTENSION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "chromium-extension", "extension",
);

const source = (name: string) => readFile(join(EXTENSION_DIR, name), "utf8");

interface ExtensionProtocol {
  PROTOCOL_VERSION: number;
  SUBPROTOCOL: string;
  TOKEN_SUBPROTOCOL_PREFIX: string;
  RELAY_PATH: string;
  OPS: string[];
  FAILURES: Record<string, string>;
}

async function loadExtensionProtocol(): Promise<ExtensionProtocol> {
  // A computed specifier: TypeScript must not try to resolve a plain-JS module
  // from another package that has no types and no `exports` entry for it.
  const specifier = pathToFileURL(join(EXTENSION_DIR, "protocol.js")).href;
  return (await import(/* @vite-ignore */ specifier)) as ExtensionProtocol;
}

describe("the extension agrees with the daemon about the protocol", () => {
  it("speaks the same version, path, and subprotocol", async () => {
    const extension = await loadExtensionProtocol();
    expect(extension.PROTOCOL_VERSION).toBe(RELAY_PROTOCOL_VERSION);
    expect(extension.SUBPROTOCOL).toBe(RELAY_SUBPROTOCOL);
    expect(extension.TOKEN_SUBPROTOCOL_PREFIX).toBe(RELAY_TOKEN_SUBPROTOCOL_PREFIX);
    expect(extension.RELAY_PATH).toBe(RELAY_PATH);
  });

  it("implements exactly the ops the daemon will ask for", async () => {
    const extension = await loadExtensionProtocol();
    expect(extension.OPS).toEqual([...RELAY_OPS]);
  });

  it("uses the seam's failure vocabulary, so nothing is silently downgraded", async () => {
    const { FAILURES } = await loadExtensionProtocol();
    expect(new Set(Object.values(FAILURES))).toEqual(new Set([
      "browser_unavailable", "blocked_url", "navigation_failed", "timeout",
      "no_page", "unknown_ref", "element_not_found", "invalid_input",
    ]));
  });

  it("has a handler for every op it declares", async () => {
    const { OPS } = await loadExtensionProtocol();
    const ops = await source("ops.js");
    for (const op of OPS) {
      expect(ops, `ops.js implements ${op}`).toMatch(new RegExp(`\\basync ${op}\\s*\\(`));
    }
  });
});

describe("the extension's permission surface is the security model", () => {
  it("asks for nothing that grants standing access to a page", async () => {
    const manifest = JSON.parse(await source("manifest.json")) as {
      manifest_version: number;
      permissions: string[];
      host_permissions?: string[];
      content_scripts?: unknown[];
      web_accessible_resources?: unknown[];
    };
    expect(manifest.manifest_version).toBe(3);
    // `debugger` is the only way in, and Chrome brands any tab it touches.
    expect(manifest.permissions.sort()).toEqual(["alarms", "debugger", "storage", "tabs"]);
    expect(manifest.permissions).not.toContain("scripting");
    expect(manifest.permissions).not.toContain("<all_urls>");
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it("runs page script only through the one explicit, named javascript op", async () => {
    const [ops, background] = await Promise.all([source("ops.js"), source("background.js")]);
    // Tier 1 adds a deliberate script capability: the owner's ghost may run
    // JavaScript in the page. It lives in a single, named op — not a generic
    // eval/exec — so a compromised daemon still cannot smuggle script through any
    // *other* verb. (The scope locks and the untrusted-result framing that keep it
    // safe live on the TypeScript tool, covered by the extensions package tests.)
    expect(ops).toMatch(/\basync javascript\s*\(/);
    // The service worker's frame dispatcher must never eval the wire itself.
    expect(background).not.toMatch(/\beval\(|new Function\(/);
    expect(ops).not.toMatch(/\bnew Function\(/);
  });

  it("checks the URL scheme itself rather than trusting the daemon", async () => {
    expect(await source("ops.js")).toMatch(/\^https\?:\\\/\\\//);
  });

  it("dials loopback and nothing else", async () => {
    const background = await source("background.js");
    expect(background).toMatch(/ws:\/\/127\.0\.0\.1:\$\{settings\.port\}/);
    expect(background).not.toMatch(/wss?:\/\/(?!127\.0\.0\.1)/);
  });
});
