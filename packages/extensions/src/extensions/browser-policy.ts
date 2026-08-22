/**
 * What the ghost's browser is allowed to open.
 *
 * The browser tool exists so a ghost can read the public web. It is *not* a
 * general URL fetcher, and it must not become a confused deputy: the daemon runs
 * on the creator's own machine, behind their own network, so a `file://` URL or
 * `http://127.0.0.1:8787/admin` typed by a model — or, more to the point,
 * suggested to it by a page it just read — would read something the creator never
 * offered. So the policy is a whitelist of schemes plus a blacklist of
 * destinations, applied before Chromium ever sees the string.
 *
 * `allowLocal` opts back into loopback and private ranges for the one honest
 * case: the creator asking the ghost to look at something they are running
 * locally. It is a per-call parameter, deliberately, so it shows up in the
 * transcript next to the URL it unlocked.
 *
 * This module is pure. Everything here is decided from the URL text alone; there
 * is no DNS resolution, so a hostname that resolves to a private address still
 * gets through. That is a known and accepted gap — the ghost has bash on the
 * creator's side anyway, and the point of the gate is to stop accidents and
 * page-suggested URLs, not a determined attacker with a domain.
 */

/** The only schemes a navigation may use. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** The one non-http URL worth allowing: an empty page to start from. */
export const BLANK_URL = "about:blank";

export interface UrlPolicyOptions {
  /** Permit loopback, private, and link-local destinations. Off by default. */
  readonly allowLocal?: boolean;
}

export interface UrlPolicyRejection {
  readonly url: string;
  readonly reason: string;
}

export type UrlPolicyResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly rejection: UrlPolicyRejection };

/** Host suffixes that always mean "something on this machine or LAN". */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    octets.push(value);
  }
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 127) return true; // this host, loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / tailscale
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // URL parsing hands IPv6 hosts back bracketed and lowercased.
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!inner.includes(":")) return false;
  if (inner === "::1" || inner === "::") return true;
  // IPv4-mapped (::ffff:127.0.0.1) inherits the IPv4 verdict.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(inner);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  const head = inner.slice(0, 2);
  if (head === "fc" || head === "fd") return true; // unique-local fc00::/7
  if (/^fe[89ab]/.test(inner)) return true; // link-local fe80::/10
  return false;
}

/** True when this hostname names the creator's own machine or private network. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "" || host === "localhost") return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

/**
 * Parse and vet a URL the model asked for.
 *
 * A bare `example.com` is read as `https://example.com` — models write URLs the
 * way people do, and defaulting to https rather than rejecting keeps the failure
 * modes about *destinations* rather than about typing.
 */
export function checkUrl(input: string, options: UrlPolicyOptions = {}): UrlPolicyResult {
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

  if (!options.allowLocal && isLocalHostname(url.hostname)) {
    return {
      ok: false,
      rejection: {
        url: raw,
        reason:
          `${url.hostname} is on this machine or its private network, which the `
          + "browser does not open by default. If the creator asked you to look at "
          + "something running locally, pass allow_local: true.",
      },
    };
  }

  return { ok: true, url: url.toString() };
}
