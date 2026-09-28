import { randomBytes } from "node:crypto";

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Delimit untrusted content with an identifier in both tags. Exact copies of
 * either marker already present in the payload are escaped before wrapping,
 * so even a deterministic nonce cannot manufacture a nested or early fence.
 */
export function fenceUntrusted(
  content: string,
  opts: { source: string; nonce?: string },
): string {
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) {
    throw new TypeError("The untrusted-content nonce must contain only letters, digits, _ or -.");
  }

  const openTag = `<untrusted source="${escapeAttribute(opts.source)}" id="${nonce}">`;
  const closeTag = `</untrusted id="${nonce}">`;
  const neutralized = content
    .replaceAll(openTag, `&lt;untrusted source="${escapeAttribute(opts.source)}" id="${nonce}">`)
    .replaceAll(closeTag, `&lt;/untrusted id="${nonce}">`);

  return `${openTag}\n${neutralized}\n${closeTag}`;
}
