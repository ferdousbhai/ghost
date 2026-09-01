import { describe, expect, it } from "vitest";
import { parseSupportedSystemdMajor } from "./native-task-scope-integration-version.js";

describe("real systemd integration version boundary", () => {
  it.each([
    ["systemd 254", 254],
    ["systemd 255 (255.4-1ubuntu8.10)\n+PAM +AUDIT", 255],
    ["systemd\t256 packaged-build", 256],
  ])("accepts a supported decimal major on the first literal systemd line", (source, major) => {
    expect(parseSupportedSystemdMajor(source)).toBe(major);
  });

  it.each([
    "255 (255.4-1ubuntu8.10)",
    "systemd v255",
    "systemd 253 (unsupported)",
    "junk systemd 255",
    "junk\nsystemd 255",
    "systemd 255suffix",
    "systemd 999999 detail",
    "systemd 255\r\n+PAM",
  ])("rejects malformed, misplaced, or unsupported output", (source) => {
    expect(parseSupportedSystemdMajor(source)).toBeUndefined();
  });
});
