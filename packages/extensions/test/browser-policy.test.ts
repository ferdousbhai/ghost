import { describe, expect, it } from "vitest";
import { checkUrl } from "@ghost/runtime/browser-policy";

function reason(input: string): string {
  const result = checkUrl(input);
  if (result.ok) throw new Error(`expected ${input} to be rejected`);
  return result.rejection.reason;
}

function url(input: string): string {
  const result = checkUrl(input);
  if (!result.ok) throw new Error(`expected ${input} to pass: ${result.rejection.reason}`);
  return result.url;
}

describe("scheme policy", () => {
  it("passes http and https through", () => {
    expect(url("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(url("http://example.com")).toBe("http://example.com/");
  });

  it("opens the owner's own machine and network like any other address", () => {
    expect(url("http://127.0.0.1:8787/admin")).toBe("http://127.0.0.1:8787/admin");
    expect(url("http://printer.local")).toBe("http://printer.local/");
  });

  it("reads a bare domain as https", () => {
    expect(url("example.com/docs")).toBe("https://example.com/docs");
  });

  it("refuses file URLs, which is the whole point of the gate", () => {
    expect(reason("file:///etc/passwd")).toMatch(/only opens http and https/i);
    expect(reason("file:///home/owner/.ssh/id_ed25519")).toMatch(/Local files/i);
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
