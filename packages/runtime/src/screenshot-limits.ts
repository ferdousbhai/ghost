import { GhostError } from "./errors.js";

export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export function screenshotLimitError(label: string, bytes: number): GhostError {
  return new GhostError(
    "limit_exceeded",
    `${label} is ${bytes} bytes; screenshots are limited to ${MAX_SCREENSHOT_BYTES} bytes.`,
    { bytes, maxBytes: MAX_SCREENSHOT_BYTES },
  );
}

export function assertScreenshotBase64WithinLimit(data: string, label: string): void {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.max(Math.floor(data.length * 3 / 4) - padding, 0);
  if (decodedBytes > MAX_SCREENSHOT_BYTES) {
    throw screenshotLimitError(label, decodedBytes);
  }
}

export function assertScreenshotBytesWithinLimit(bytes: number, label: string): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_SCREENSHOT_BYTES) {
    throw screenshotLimitError(label, bytes);
  }
}
