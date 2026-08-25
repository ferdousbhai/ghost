import { describe, expect, it } from "vitest";
import {
  checkActingScope,
  checkNetworkUrl,
  checkUrl,
  isActingAction,
  isLocalHostname,
  isPublicInternetAddress,
  registrableDomain,
  type BrowserDnsResolver,
  type BrowserPolicyClock,
} from "../src/extensions/browser-policy.js";

function reason(input: string, allowLocal = false): string {
  const result = checkUrl(input, { allowLocal });
  if (result.ok) throw new Error(`expected ${input} to be rejected`);
  return result.rejection.reason;
}

function url(input: string, allowLocal = false): string {
  const result = checkUrl(input, { allowLocal });
  if (!result.ok) throw new Error(`expected ${input} to pass: ${result.rejection.reason}`);
  return result.url;
}

describe("scheme policy", () => {
  it("passes http and https through", () => {
    expect(url("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(url("http://example.com")).toBe("http://example.com/");
  });

  it("reads a bare domain as https", () => {
    expect(url("example.com/docs")).toBe("https://example.com/docs");
  });

  it("refuses file URLs, which is the whole point of the gate", () => {
    expect(reason("file:///etc/passwd")).toMatch(/only opens http and https/i);
    expect(reason("file:///home/dous/.ssh/id_ed25519")).toMatch(/Local files/i);
  });

  it("refuses the other schemes a model might reach for", () => {
    for (const input of [
      "data:text/html,<h1>hi</h1>",
      "javascript:alert(1)",
      "chrome://settings",
      "view-source:https://example.com",
      "ftp://example.com/x",
    ]) {
      expect(reason(input)).toMatch(/only opens http and https/i);
    }
  });

  it("allows about:blank, the one useful non-http page", () => {
    expect(url("about:blank")).toBe("about:blank");
  });

  it("rejects empty and unparseable input", () => {
    expect(reason("")).toMatch(/No URL/i);
    expect(reason("   ")).toMatch(/No URL/i);
    expect(reason("http://")).toMatch(/is not a URL/i);
  });
});

describe("local and private destinations", () => {
  const local = [
    "http://localhost:8787/admin",
    "http://127.0.0.1:3000",
    "http://127.13.2.9/",
    "http://0.0.0.0:8080",
    "http://[::1]:9000/",
    "http://10.0.0.5/",
    "http://172.16.4.4/",
    "http://172.31.255.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.9.9/",
    "http://ghost.localhost/",
    "http://nas.local/",
    "http://vault.internal/",
    "http://router.home.arpa/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    // Hex IPv4-mapped forms — the spelling WHATWG URL actually produces.
    "http://[::ffff:7f00:1]/", // 127.0.0.1
    "http://[::ffff:c0a8:1]/", // 192.168.0.1
    "http://[64:ff9b::7f00:1]/", // NAT64 of 127.0.0.1
    // Trailing-dot FQDNs resolve to the same place as their bare form.
    "http://localhost./",
    "http://nas.local./",
    "http://vault.internal./",
  ];

  it("blocks every one of them by default", () => {
    for (const input of local) {
      expect(reason(input)).toMatch(/private network|does not open/i);
    }
  });

  it("lets them through with allowLocal", () => {
    for (const input of local) {
      expect(() => url(input, true)).not.toThrow();
    }
  });

  it("does not over-block public addresses that look adjacent", () => {
    for (const input of [
      "http://172.32.0.1/",
      "http://172.15.0.1/",
      "http://192.169.1.1/",
      "http://9.9.9.9/",
      "http://100.63.0.1/",
      "http://100.128.0.1/",
      "https://locality.example.com/",
      "https://mylocalhost.com/",
      "http://[::ffff:808:808]/", // 8.8.8.8, a public IPv4-mapped address
    ]) {
      expect(() => url(input)).not.toThrow();
    }
  });

  it("classifies hostnames directly", () => {
    expect(isLocalHostname("LOCALHOST")).toBe(true);
    expect(isLocalHostname("[::FFFF:127.0.0.1]".toLowerCase())).toBe(true);
    // WHATWG serialises the mapped address to hex; both spellings must classify.
    expect(isLocalHostname("[::ffff:7f00:1]")).toBe(true); // 127.0.0.1
    expect(isLocalHostname("[::ffff:c0a8:1]")).toBe(true); // 192.168.0.1
    expect(isLocalHostname("[64:ff9b::7f00:1]")).toBe(true); // NAT64 127.0.0.1
    // A trailing-dot FQDN resolves to the same host.
    expect(isLocalHostname("localhost.")).toBe(true);
    expect(isLocalHostname("nas.local.")).toBe(true);
    expect(isLocalHostname("vault.internal.")).toBe(true);
    // But a public IPv4-mapped address stays public.
    expect(isLocalHostname("[::ffff:808:808]")).toBe(false); // 8.8.8.8
    expect(isLocalHostname("example.com")).toBe(false);
  });
});

describe("resolved network destinations", () => {
  const answers = (...address: string[]): BrowserDnsResolver => async () =>
    address.map((value) => ({ address: value, family: value.includes(":") ? 6 : 4 }));

  async function networkReason(input: string, resolver: BrowserDnsResolver): Promise<string> {
    const result = await checkNetworkUrl(input, { resolver });
    if (result.ok) throw new Error(`expected ${input} to be rejected`);
    return result.rejection.reason;
  }

  it("accepts only globally reachable literal addresses", () => {
    for (const address of ["8.8.8.8", "2606:4700:4700::1111", "::ffff:808:808"]) {
      expect(isPublicInternetAddress(address)).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "169.254.169.254",
      "192.0.2.1",
      "198.18.0.1",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "2001:db8::1",
      "4000::1",
      "5f00::1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
    ]) {
      expect(isPublicInternetAddress(address)).toBe(false);
    }
  });

  it("rejects private and mixed DNS answers, and accepts an all-public set", async () => {
    await expect(networkReason("https://private.example", answers("10.0.0.7")))
      .resolves.toMatch(/private or non-public/i);
    await expect(networkReason(
      "https://rebind.example",
      answers("93.184.216.34", "127.0.0.1"),
    )).resolves.toMatch(/private or non-public/i);
    await expect(checkNetworkUrl("https://public.example", {
      resolver: answers("93.184.216.34", "2606:4700:4700::1111"),
    })).resolves.toMatchObject({ ok: true, url: "https://public.example/" });
  });

  it("rejects empty or malformed resolver answers without consulting the network", async () => {
    await expect(networkReason("https://empty.example", answers()))
      .resolves.toMatch(/no addresses/i);
    await expect(networkReason("https://bad.example", answers("not-an-ip")))
      .resolves.toMatch(/private or non-public/i);
  });

  it("uses injected resolver and clock seams for a bounded DNS wait", async () => {
    let fireDeadline: (() => void) | undefined;
    const clock: BrowserPolicyClock = {
      setTimeout(callback) {
        fireDeadline = callback;
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    };
    const never: BrowserDnsResolver = async () => new Promise(() => undefined);
    const pending = checkNetworkUrl("https://slow.example", {
      resolver: never,
      timeoutMs: 17,
      clock,
    });
    fireDeadline?.();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected DNS timeout rejection");
    expect(result.rejection.reason).toMatch(/timed out after 17ms/i);
  });

  it("propagates cancellation to the resolver and rejects promptly", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const resolver: BrowserDnsResolver = async (_hostname, options) => {
      seenSignal = options?.signal;
      return new Promise(() => undefined);
    };
    const pending = checkNetworkUrl("https://slow.example", {
      resolver,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seenSignal).toBe(controller.signal);
  });
});

describe("registrable domain", () => {
  it("keeps the last two labels for ordinary hosts", () => {
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("app.eu.example.com")).toBe("example.com");
  });

  it("follows Public Suffix List wildcard and exception rules", () => {
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("shop.myshop.com.au")).toBe("myshop.com.au");
    expect(registrableDomain("a.www.ck")).toBe("www.ck");
    expect(registrableDomain("foo.city.kawasaki.jp")).toBe("city.kawasaki.jp");
  });

  it("treats private suffix tenants as separate sites", () => {
    expect(registrableDomain("foo.github.io")).toBe("foo.github.io");
    expect(registrableDomain("bar.github.io")).toBe("bar.github.io");
    expect(registrableDomain("a.appspot.com")).toBe("a.appspot.com");
    expect(registrableDomain("b.appspot.com")).toBe("b.appspot.com");
  });

  it("treats a bare IP as its own identity", () => {
    expect(registrableDomain("203.0.113.4")).toBe("203.0.113.4");
    expect(registrableDomain("[2606:4700::1]")).toBe("[2606:4700::1]");
  });

  it("separates sites that only share a prefix", () => {
    expect(registrableDomain("attacker.test")).not.toBe(registrableDomain("example.com"));
    expect(registrableDomain("evil-example.com")).not.toBe(registrableDomain("example.com"));
  });
});

describe("acting classification", () => {
  it("names click and type as the consequential actions", () => {
    expect(isActingAction("click")).toBe(true);
    expect(isActingAction("type")).toBe(true);
  });

  it("leaves observing actions unrestricted", () => {
    for (const observing of ["open", "read", "find", "screenshot", "back", "close"]) {
      expect(isActingAction(observing)).toBe(false);
    }
  });
});

describe("acting-scope provenance gate", () => {
  const origin = "https://example.com/home";

  it("allows acting on the opened origin's registrable domain", () => {
    const result = checkActingScope(origin, "https://www.example.com/account", 0);
    expect(result.ok).toBe(true);
  });

  it("refuses acting on a page off that domain, and says how to widen", () => {
    const result = checkActingScope(origin, "https://attacker.test/pay", 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toMatch(/allow_cross_domain/);
    expect(result.reason).toMatch(/reading it is fine/i);
    expect(result.details["failure"]).toBe("blocked_action");
    expect(result.details["hops"]).toBe(2);
  });

  it("re-permits it with the escape hatch", () => {
    const result = checkActingScope(origin, "https://attacker.test/pay", 2, {
      allowCrossDomain: true,
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed when there is no opened origin at all", () => {
    const result = checkActingScope(undefined, "https://attacker.test/pay", 0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.details["failure"]).toBe("blocked_action");
  });
});
