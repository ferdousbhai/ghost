/**
 * The desktop-helper handshake spans two languages in this one repository: the
 * TypeScript client (`desktop-helper-client.ts`) and the Python sidecar
 * (`protocol.py`). Each side's own suite pins its own constant against a
 * literal, which catches an accidental bump but not a one-sided deliberate one:
 * raise the Python version and its literal together and `pytest` stays green,
 * raise neither on the TypeScript side and `vitest` stays green too, while the
 * real handshake now mismatches and retires the sidecar at runtime.
 *
 * Nothing linked the two numbers, so this file does what
 * `relay-extension.test.ts` does across the extension repository's seam: read
 * the other side's source and compare, constant for constant. `protocol.py`
 * declares the version as a plain module-level assignment, so it can be read
 * without a Python interpreter — the check costs nothing and runs in the
 * workspace suite rather than only where `uv` is installed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESKTOP_HELPER_PROTOCOL_VERSION } from "../src/extensions/desktop-helper-client.js";

const PROTOCOL_PY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "desktop-helper",
  "src",
  "ghost_desktop_helper",
  "protocol.py",
);

/** The sidecar's declared version, read from its source rather than assumed. */
function pythonProtocolVersion(): number {
  const source = readFileSync(PROTOCOL_PY, "utf8");
  const match = /^DESKTOP_HELPER_PROTOCOL_VERSION\s*=\s*(\d+)\s*$/m.exec(source);
  if (!match?.[1]) {
    throw new Error(
      `Could not read DESKTOP_HELPER_PROTOCOL_VERSION from ${PROTOCOL_PY}. If the sidecar stopped `
      + "declaring it as a module-level integer, this conformance check needs updating with it.",
    );
  }
  return Number(match[1]);
}

describe("desktop-helper protocol conformance", () => {
  it("the sidecar and its client agree on the protocol version", () => {
    expect(pythonProtocolVersion()).toBe(DESKTOP_HELPER_PROTOCOL_VERSION);
  });
});
