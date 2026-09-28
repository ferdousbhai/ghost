/**
 * The local browser host's policy adapter. The URL, DNS-answer and acting-scope
 * rules are shared with hosted Ghost in `@ghost/runtime/browser-policy`; this
 * module supplies the one host-specific piece, DNS resolved from this machine.
 */
import { lookup } from "node:dns/promises";
import {
  checkNetworkUrl as checkSharedNetworkUrl,
  type BrowserDnsResolver,
  type NetworkUrlPolicyOptions,
  type UrlPolicyResult,
} from "@ghost/runtime/browser-policy";

export * from "@ghost/runtime/browser-policy";

export const defaultBrowserDnsResolver: BrowserDnsResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export function checkNetworkUrl(
  input: string,
  options: NetworkUrlPolicyOptions = {},
): Promise<UrlPolicyResult> {
  return checkSharedNetworkUrl(input, { ...options, resolver: options.resolver ?? defaultBrowserDnsResolver });
}
