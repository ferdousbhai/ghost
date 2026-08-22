import { describe, expect, it } from "vitest";
import { checkUrl, isLocalHostname } from "../src/extensions/browser-policy.js";

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
    ]) {
      expect(() => url(input)).not.toThrow();
    }
  });

  it("classifies hostnames directly", () => {
    expect(isLocalHostname("LOCALHOST")).toBe(true);
    expect(isLocalHostname("[::FFFF:127.0.0.1]".toLowerCase())).toBe(true);
    expect(isLocalHostname("example.com")).toBe(false);
  });
});
