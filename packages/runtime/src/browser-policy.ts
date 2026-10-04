/**
 * What the ghost's browser opens: http(s) URLs and about:blank. The browser is
 * the owner's own, acting as the owner, so destinations are not filtered; a
 * `file:` or `javascript:` string is refused because it is not a page to open.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export const BLANK_URL = "about:blank";

export interface UrlPolicyRejection {
  readonly url: string;
  readonly reason: string;
}

export type UrlPolicyResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly rejection: UrlPolicyRejection };

/**
 * Parse a URL the model asked for. A bare `example.com` is read as
 * `https://example.com`: models write URLs the way people do.
 */
export function checkUrl(input: string): UrlPolicyResult {
  const raw = input.trim();
  if (raw === "") {
    return { ok: false, rejection: { url: input, reason: "No URL was given." } };
  }
  if (raw.toLowerCase() === BLANK_URL) return { ok: true, url: BLANK_URL };

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return {
      ok: false,
      rejection: { url: raw, reason: `${JSON.stringify(raw)} is not a URL.` },
    };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      rejection: {
        url: raw,
        reason:
          `The browser only opens http and https URLs, and ${JSON.stringify(raw)} is `
          + `${url.protocol.replace(":", "")}. Local files are not reachable this way.`,
      },
    };
  }

  return { ok: true, url: url.toString() };
}
