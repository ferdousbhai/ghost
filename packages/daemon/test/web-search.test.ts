import { describe, expect, it } from "vitest";
import { ghostSettingsFrom } from "../src/ghost-settings.js";
import {
  createBraveProvider,
  createDuckDuckGoProvider,
  createFirecrawlProvider,
  createWebSearchTool,
  decodeHtmlText,
  formatSearchResults,
  parseDuckDuckGoResults,
  searchProvidersFromSettings,
  searchWeb,
} from "../src/web-search.js";

const DDG_PAGE = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fghost&amp;rut=abc">Ghost &amp; <b>friends</b></a></h2>
    <div class="result__extras"><div class="result__extras__url"><span>&nbsp; &nbsp; 2026-08-20T10:00:00.0000000</span></div></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fghost">A <b>ghost</b> that lives on your desktop.</a>
  </div>
</div>
<div class="result results_links web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a class="result__a" href="https://example.org/plain">Plain link</a></h2>
  </div>
</div>
<div class="nav-link"><form action="/html/" method="post"><input type="hidden" name="q" value="ghost"><input name="s" value="30" type="hidden"><input name="vqd" value="4-123" type="hidden"></form></div>
`;

function respond(body: string, status = 200, type = "text/html"): Response {
  return new Response(body, { status, headers: { "content-type": type } });
}

describe("web_search", () => {
  it("parses DuckDuckGo result rows, unwrapping redirect links, and decodes text once in searchWeb", async () => {
    expect(parseDuckDuckGoResults(DDG_PAGE).map((result) => result.url)).toEqual([
      "https://example.com/ghost",
      "https://example.org/plain",
    ]);
    expect(decodeHtmlText("Ghost &amp; <b>friends</b> &#x27;here&#39;")).toBe("Ghost & friends 'here'");

    let body = "";
    const provider = createDuckDuckGoProvider(async (_url, init) => {
      body = String(init?.body);
      return respond(DDG_PAGE);
    });
    await expect(searchWeb([provider], { query: "ghost", limit: 1, recency: "week" })).resolves.toEqual({
      provider: "duckduckgo",
      results: [{
        title: "Ghost & friends",
        url: "https://example.com/ghost",
        snippet: "A ghost that lives on your desktop.",
        published: "2026-08-20T10:00:00.0000000",
      }],
    });
    expect(body).toContain("q=ghost");
    expect(body).toContain("df=w");
  });

  it("reports DuckDuckGo's bot challenge and falls through the provider chain", async () => {
    const duckduckgo = createDuckDuckGoProvider(async () => respond('<div class="anomaly-modal">verify</div>'));
    let braveRequest: { url: string; headers: Record<string, string> } | undefined;
    const brave = createBraveProvider(() => "brave-key", async (url, init) => {
      braveRequest = { url: String(url), headers: init?.headers as Record<string, string> };
      return respond(JSON.stringify({ web: { results: [{ title: "Brave &amp; hit", url: "https://brave.example", description: "found", age: "2 days ago" }] } }), 200, "application/json");
    });
    await expect(searchWeb([duckduckgo], { query: "q", limit: 5 })).rejects.toThrow(/bot-detection challenge/);
    await expect(searchWeb([duckduckgo, brave], { query: "q", limit: 5, recency: "month" })).resolves.toEqual({
      provider: "brave",
      results: [{ title: "Brave & hit", url: "https://brave.example", snippet: "found", published: "2 days ago" }],
    });
    expect(braveRequest?.url).toContain("freshness=pm");
    expect(braveRequest?.headers["X-Subscription-Token"]).toBe("brave-key");
  });

  it("builds the provider chain from settings and resolves the Brave key through the keyring", async () => {
    const resolved: string[] = [];
    const secrets = { resolve: (reference: string) => { resolved.push(reference); return "resolved-key"; } };
    const none = searchProvidersFromSettings({ settings: ghostSettingsFrom({}), secrets });
    expect(none.map((provider) => [provider.id, provider.available()])).toEqual([
      ["brave", false],
      ["firecrawl", true],
      ["duckduckgo", true],
    ]);

    const withBrave = searchProvidersFromSettings({
      settings: ghostSettingsFrom({ web: { search: { brave: { apiKey: "keyring:brave/personal" } } } }),
      secrets,
      fetch: async () => respond(JSON.stringify({ web: { results: [] } }), 200, "application/json"),
    });
    expect(withBrave.map((provider) => provider.id)).toEqual(["brave", "firecrawl", "duckduckgo"]);
    expect(withBrave[0]?.available()).toBe(true);
    expect(resolved).toEqual(["keyring:brave/personal"]);

    const ordered = searchProvidersFromSettings({
      settings: ghostSettingsFrom({ web: { search: { providers: ["duckduckgo", "brave", "unknown"] } } }),
      secrets,
    });
    expect(ordered.map((provider) => provider.id)).toEqual(["duckduckgo", "brave"]);
    expect(ordered[1]?.available()).toBe(false);
  });

  it("searches Firecrawl keyless, adding the bearer key only when configured", async () => {
    const requests: Array<{ headers: Record<string, string>; body: unknown }> = [];
    const respondFirecrawl = async (_url: string | URL, init?: RequestInit) => {
      requests.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return respond(JSON.stringify({ success: true, data: { web: [
        { title: "Hit", url: "https://fc.example/a", description: " found it " },
        { title: null, url: "https://fc.example/b", markdown: "# body" },
        { title: "no url" },
      ] } }), 200, "application/json");
    };
    const keyless = createFirecrawlProvider(() => undefined, respondFirecrawl);
    await expect(searchWeb([keyless], { query: "ghost", limit: 5, recency: "day" })).resolves.toEqual({
      provider: "firecrawl",
      results: [
        { title: "Hit", url: "https://fc.example/a", snippet: "found it" },
        { title: "https://fc.example/b", url: "https://fc.example/b", snippet: "# body" },
      ],
    });
    expect(requests[0]?.headers).not.toHaveProperty("Authorization");
    expect(requests[0]?.body).toEqual({ query: "ghost", limit: 5, sources: [{ type: "web" }], tbs: "qdr:d" });

    const keyed = createFirecrawlProvider(() => "fc-key", respondFirecrawl);
    await keyed.search({ query: "ghost", limit: 1 });
    expect(requests[1]?.headers).toMatchObject({ Authorization: "Bearer fc-key" });

    const failing = createFirecrawlProvider(() => undefined, async () =>
      respond(JSON.stringify({ success: false, error: "quota" }), 200, "application/json"));
    await expect(failing.search({ query: "ghost", limit: 1 })).rejects.toThrow(/quota/);
  });

  it("answers the model with fenced, numbered results", async () => {
    const tool = createWebSearchTool({
      settings: ghostSettingsFrom({ web: { search: { providers: ["duckduckgo"] } } }),
      secrets: { resolve: () => { throw new Error("unused"); } },
      fetch: async () => respond(DDG_PAGE),
    });
    const result = await tool.execute("call", { query: "  ghost desktop ", limit: 1 }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ provider: "duckduckgo", results: [{ url: "https://example.com/ghost" }] });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^<untrusted source="web search via duckduckgo" id="[0-9a-f]+">\n1\. Ghost & friends\n {3}https:\/\/example\.com\/ghost/),
    });
    expect(formatSearchResults([])).toBe("No results.");
    await expect(tool.execute("call", { query: "   " }, undefined, undefined, {} as never)).rejects.toThrow(/needs a query/);
  });
});
