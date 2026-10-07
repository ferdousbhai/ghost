import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type MarkdownDocument, renderMarkdown } from "../src/remote-markdown.js";
import { REMOTE_VIEWER_HTML } from "../src/remote-viewer.js";

type FakeNode = { tag: string; attrs: Record<string, string>; kids: (FakeNode | string)[]; append: (...k: (FakeNode | string)[]) => void; setAttribute: (k: string, v: string) => void };
const node = (tag: string): FakeNode => {
  const n: FakeNode = { tag, attrs: {}, kids: [], append: (...k) => n.kids.push(...k), setAttribute: (k, v) => { n.attrs[k] = v; } };
  return n;
};
const doc = { createElement: node, createDocumentFragment: () => node("#") } as unknown as MarkdownDocument;

/** Serializes the fake tree as HTML so expectations read like the page. */
function html(n: FakeNode | string): string {
  if (typeof n === "string") return n.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const inner = n.kids.map(html).join("");
  if (n.tag === "#") return inner;
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}
const md = (s: string) => html(renderMarkdown(s, doc) as unknown as FakeNode);

describe("remote viewer markdown", () => {
  test("a longer fence holds a shorter one, as an owner command's output may", () => {
    expect(md("````\n# Readme\n```sh\nls\n```\n````\n\n(exit 1)")).toBe(
      "<pre><code># Readme\n```sh\nls\n```</code></pre><p>(exit 1)</p>",
    );
  });

  test("blocks", () => {
    expect(md("# Title\n\nSome text\nnext line\n\n- a\n- **b**\n\n1. one\n2. two")).toBe(
      "<h1>Title</h1><p>Some text\nnext line</p><ul><li>a</li><li><strong>b</strong></li></ul><ol><li>one</li><li>two</li></ol>",
    );
    expect(md("Here:\n- x\n- y")).toBe("<p>Here:</p><ul><li>x</li><li>y</li></ul>");
    expect(md("```ts\nconst a = `<b>`;\n```\n> quoted *it*")).toBe(
      "<pre><code>const a = `&lt;b>`;</code></pre><blockquote><p>quoted <em>it</em></p></blockquote>",
    );
    expect(md("| a | b |\n|---|:-:|\n| 1 | `2` |")).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><code>2</code></td></tr></tbody></table>",
    );
  });

  test("inline, and model text never becomes markup or a script link", () => {
    expect(md("see [docs](https://x.dev/a) or https://y.dev/b. `<i>` snake_case_name")).toBe(
      '<p>see <a href="https://x.dev/a" target="_blank" rel="noopener noreferrer">docs</a> or <a href="https://y.dev/b" target="_blank" rel="noopener noreferrer">https://y.dev/b</a>. <code>&lt;i></code> snake_case_name</p>',
    );
    expect(md("<img src=x onerror=alert(1)> [x](javascript:alert(1))")).toBe(
      "<p>&lt;img src=x onerror=alert(1)> [x](javascript:alert(1))</p>",
    );
  });

  test("an unterminated fence mid-stream still renders", () => {
    expect(md("```\npartial")).toBe("<pre><code>partial</code></pre>");
  });

  test("the page script that embeds the renderer parses", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(REMOTE_VIEWER_HTML)?.[1] ?? "";
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("function renderMarkdown");
  });
});

describe("remote viewer transcript", () => {
  test("a long conversation opens on its newest page", async () => {
    const source = REMOTE_VIEWER_HTML.match(/async function loadTranscript\([^)]*\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(source).toBeDefined();
    const total = 2500;
    const api = async (path: string) => {
      const offset = Number(new URL(`http://viewer${path}`).searchParams.get("offset") ?? 0);
      const messages = Array.from({ length: Math.min(1000, total - offset) }, (_, i) => offset + i);
      return { messages, total, truncated: offset > 0 || offset + messages.length < total };
    };
    let rendered: number[] = [];
    const loadTranscript = new Function("api", "seg", "render", "ghost", "session", "draft", `${source}; return loadTranscript;`)(
      api, (part: string) => part, (messages: number[]) => { rendered = messages; }, "casper", "c1", null,
    ) as () => Promise<void>;
    await loadTranscript();
    expect([rendered[0], rendered.at(-1)]).toEqual([1500, 2499]);
  });

  test("a cut turn reads on from its resume frame", async () => {
    const source = REMOTE_VIEWER_HTML.match(/async function\* turnEvents\([^)]*\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(source).toBeDefined();
    const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    const fetched: string[] = [];
    const fetchStub = async (url: string) => {
      fetched.push(url);
      return sse({ type: "text_delta", delta: "b" }, { type: "done" });
    };
    // The page's open conversation has moved on; the turn's own is passed in.
    const turnEvents = new Function("fetch", "seg", "ghost", "session", `${source}; return turnEvents;`)(
      fetchStub, encodeURIComponent, "casper", "c2",
    ) as (response: Response, conversation: string) => AsyncIterable<{ type: string }>;
    const seen: string[] = [];
    for await (const event of turnEvents(sse({ type: "start" }, { type: "resume", turn: "t1", from: 1 }), "/ghosts/casper/sessions/c1")) seen.push(event.type);
    expect(seen).toEqual(["start", "text_delta", "done"]);
    expect(fetched).toEqual(["/api/ghosts/casper/sessions/c1/stream?turn=t1&from=1"]);
  });

  test("a message goes to the conversation it was written in, even if another opens while its photo uploads", async () => {
    const source = REMOTE_VIEWER_HTML.match(/async function send\(\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(source).toBeDefined();
    const posted: { url: string; body: unknown }[] = [];
    const names = ["prompt", "pending", "ghost", "session", "draft", "streaming", "seg", "show", "refresh", "shrink", "api", "fetch"];
    const page = new Function(...names, `${source}; return { send, open(id) { ghost = "other"; session = id; } };`)(
      { value: "look" }, [{ file: new Blob(["x"], { type: "image/jpeg" }) }], "casper", "c1", null, false,
      encodeURIComponent, () => {}, () => {}, async (file: Blob) => file,
      async () => {
        page.open("c2");
        return { path: "attachments/p.jpg" };
      },
      async (url: string, init: { body: string }) => {
        posted.push({ url, body: JSON.parse(init.body) });
        return { ok: false, json: async () => ({ error: { message: "stop here" } }) };
      },
    ) as { send: () => Promise<void>; open: (id: string) => void };
    await expect(page.send()).rejects.toThrow("stop here");
    expect(posted).toEqual([{ url: "/api/ghosts/casper/messages", body: { prompt: "look\n\n![image](attachments/p.jpg)", sessionId: "c1" } }]);
  });
});

// The page's script is a string to TypeScript and to the repo's lint, so a
// name used before its declaration only failed on the phone. Lint it here.
test("the viewer's own script declares every name before using it", () => {
  const script = /<script>([\s\S]*?)<\/script>/u.exec(REMOTE_VIEWER_HTML)?.[1] ?? "";
  expect(script).toContain("function bubbles(");
  const dir = mkdtempSync(join(tmpdir(), "viewer-lint-"));
  try {
    const file = join(dir, "viewer.js");
    writeFileSync(file, script);
    const biome = join(import.meta.dirname, "../../../node_modules/.bin/biome");
    const lint = spawnSync(biome, [
      "lint", "--only=correctness/noInvalidUseBeforeDeclaration", "--only=suspicious/noRedeclare",
      "--only=correctness/noUnusedVariables", file,
    ], { encoding: "utf8" });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
