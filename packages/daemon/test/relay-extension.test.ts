/**
 * The extension half is plain JavaScript with no build step, which is what makes
 * it editable-and-reloadable but also means its copy of the protocol is not
 * typechecked against the TypeScript one. This file is the conformance check
 * across the product seam (PROTOCOL.md in the extension's repository): the
 * extension is a separate product and neither side imports the other's source,
 * so this test reads a checkout of it instead. `extension/protocol.js` has
 * no `chrome` API in it, so it imports cleanly into Node and can simply be
 * compared, constant for constant.
 *
 * The manifest assertions are the other half of the point. The relay's whole
 * security claim rests on the extension having no host grants, content scripts,
 * or `chrome.scripting`. The required `chrome.debugger` grant can enumerate
 * target URL/title metadata before attachment; page-content reads and DOM/input
 * actions require an attached session, which Chrome brands with its own banner.
 * That boundary is a property a future convenience commit could quietly delete,
 * so it is pinned here rather than only in a README.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RELAY_OPS,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_PAIR_SUBPROTOCOL_PREFIX,
  RELAY_TOKEN_SUBPROTOCOL_PREFIX,
} from "../src/relay-protocol.js";

// The extension lives in its own repository (github.com/ferdousbhai/
// ghost-chromium-extension). This test reads a checkout of it: an explicit
// location wins, else a sibling clone of this repository. CI checks the pinned
// tag out (RELAY_EXTENSION_REF in .github/workflows/arch-package.yml); a
// developer without a clone gets a skipped suite that says so, not a false pass.
const EXTENSION_DIR = process.env.GHOST_CHROMIUM_EXTENSION_DIR
  ?? join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "..", "..", "ghost-chromium-extension", "extension",
  );
const extensionPresent = existsSync(join(EXTENSION_DIR, "protocol.js"));
if (!extensionPresent) {
  console.warn(
    `relay-extension: no extension checkout at ${EXTENSION_DIR}; set GHOST_CHROMIUM_EXTENSION_DIR `
    + "or clone github.com/ferdousbhai/ghost-chromium-extension beside this repository.",
  );
}

const source = (name: string) => readFile(join(EXTENSION_DIR, name), "utf8");

interface ExtensionProtocol {
  PROTOCOL_VERSION: number;
  SUBPROTOCOL: string;
  TOKEN_SUBPROTOCOL_PREFIX: string;
  PAIR_SUBPROTOCOL_PREFIX: string;
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

describe.skipIf(!extensionPresent)("the extension agrees with the daemon about the protocol", () => {
  it("speaks the same version, path, and subprotocol", async () => {
    const extension = await loadExtensionProtocol();
    expect(extension.PROTOCOL_VERSION).toBe(RELAY_PROTOCOL_VERSION);
    expect(extension.SUBPROTOCOL).toBe(RELAY_SUBPROTOCOL);
    expect(extension.TOKEN_SUBPROTOCOL_PREFIX).toBe(RELAY_TOKEN_SUBPROTOCOL_PREFIX);
    expect(extension.PAIR_SUBPROTOCOL_PREFIX).toBe(RELAY_PAIR_SUBPROTOCOL_PREFIX);
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

describe.skipIf(!extensionPresent)("the extension's permission surface is the security model", () => {
  it("keeps page content and DOM/input actions behind visible debugger attachment", async () => {
    const manifest = JSON.parse(await source("manifest.json")) as {
      manifest_version: number;
      permissions: string[];
      host_permissions?: string[];
      content_scripts?: unknown[];
      web_accessible_resources?: unknown[];
    };
    expect(manifest.manifest_version).toBe(3);
    // `debugger` exposes target metadata, but content and DOM/input need its branded attachment.
    expect(manifest.permissions).toEqual(expect.arrayContaining(["alarms", "debugger", "storage"]));
    // The extension versions its own permission surface (its `manifest.test.mjs`
    // pins the exact list). What Ghost depends on is narrower and does not move:
    // nothing here may reach a page's content without that branded attachment.
    for (const forbidden of [
      "scripting", "tabs", "activeTab", "webRequest", "webRequestBlocking", "webNavigation",
      "cookies", "declarativeNetRequest", "proxy", "downloads", "management",
      "nativeMessaging", "<all_urls>",
    ]) {
      expect(manifest.permissions).not.toContain(forbidden);
    }
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
