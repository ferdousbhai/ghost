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

describe("remote viewer invalidations", () => {
  test("refetches state on reconnect while leaving an active turn to its own stream", () => {
    const source = REMOTE_VIEWER_HTML.match(/function watch\(\) \{[\s\S]*?\n {2}\}/)?.[0];
    let loads = 0;
    let connection: { onopen: () => void } | undefined;
    class EventSource {
      onopen = () => {};
      constructor() { connection = this; }
    }
    const page = new Function("EventSource", "loadSessions", "show", "seg", `
      let events; const ghost = "casper"; let streaming = false;
      ${source};
      return { watch, setStreaming(value) { streaming = value; } };
    `)(EventSource, async () => { loads++; }, () => {}, encodeURIComponent) as { watch: () => void; setStreaming: (value: boolean) => void };
    page.watch();
    connection!.onopen();
    expect(loads).toBe(0);
    connection!.onopen();
    expect(loads).toBe(1);
    page.setStreaming(true);
    connection!.onopen();
    expect(loads).toBe(1);
  });
});

describe("remote viewer deep links", () => {
  test("a deleted linked conversation opens nothing else but leaves the picker usable", async () => {
    const source = REMOTE_VIEWER_HTML.match(/async function loadSessions\(changed\) \{[\s\S]*?\n {2}\}/)?.[0];
    const options: Array<{ value: string; textContent: string }> = [];
    const select = { textContent: "", value: "", disabled: false, append: (option: { value: string; textContent: string }) => options.push(option) };
    let synced = 0, transcripts = 0;
    const context = {
      ghost: "casper", session: "gone", draft: null, owner: true, requestedSession: "gone", selectedUnread: false,
      api: async () => ({ sessions: [{ id: "c1", title: "Only one" }] }), seg: encodeURIComponent, mint: () => "draft",
      $: () => select, document: { createElement: () => ({ value: "", textContent: "" }) },
      syncUrl: () => { synced++; }, loadTranscript: async () => { transcripts++; }, render() {},
    };
    const page = new Function(...Object.keys(context), `${source}; return { loadSessions, state: () => ({ session, requestedSession }) };`)(...Object.values(context));
    await expect(page.loadSessions()).rejects.toThrow("The linked conversation is unavailable.");
    expect(page.state()).toEqual({ session: null, requestedSession: "gone" });
    expect(options.map(option => option.value)).toEqual(["c1"]);
    expect(select).toMatchObject({ value: "", disabled: false });
    expect({ synced, transcripts }).toEqual({ synced: 0, transcripts: 0 });
  });
});

describe("remote viewer transcript", () => {
  test("resource metadata stays out of chat across continued runs", async () => {
    const source = REMOTE_VIEWER_HTML.match(/async function send\(\) \{[\s\S]*?\n {2}\}/)?.[0];
    const nodes: Array<{ textContent: string; className: string }> = [];
    const element = (textContent = "") => ({
      textContent, className: "", classList: { add() {}, remove() {} },
      before(other: { textContent: string; className: string }) { nodes.splice(nodes.indexOf(this), 0, other); },
      after() {}, remove() {},
      replaceChildren(text: string) { this.textContent = text; },
    });
    const events = [
      { type: "harness", harness: "codex" },
      { type: "text_start" }, { type: "text_delta", delta: "first answer" },
      { type: "resources", run: "r1", summary: "first inventory" },
      { type: "harness", harness: "codex" },
      { type: "text_start" }, { type: "text_delta", delta: "second answer" },
      { type: "tool_execution_start", toolName: "bash" },
      { type: "text_start" }, { type: "text_delta", delta: "after tool" },
      { type: "resources", run: "r2", summary: "second inventory" },
    ];
    const context = {
      prompt: { value: "hello" }, pending: [], ghost: "casper", session: "c1", draft: null, streaming: false,
      show() {}, refresh() {}, seg: encodeURIComponent,
      fetch: async () => ({ ok: true }), grow() {}, clearTray() {},
      log: { querySelector: () => null, append: (el: ReturnType<typeof element>) => nodes.push(el) },
      userBubble: element, assistantBubble: element, resourceNotice: element,
      document: { createElement: () => element() }, follow() {}, nearBottom: () => true,
      turnEvents: async function* () { yield* events; },
      bubbles: (parts: Array<{ type: string; text: string }>) => parts.filter(p => p.type === "text").map(p => p.text).filter(Boolean),
      renderMarkdown: (text: string) => text, loadSessions() {},
    };
    const send = new Function(...Object.keys(context), `${source}; return send;`)(...Object.values(context));
    await send();
    expect(nodes.map(n => n.textContent)).toEqual([
      "hello", "first answer", "second answer", "after tool",
    ]);
  });

  test("resources load on demand and ignore a response from a previous conversation", async () => {
    const source = REMOTE_VIEWER_HTML.match(/async function showResources\(\) \{[\s\S]*?\n {2}\}/)?.[0];
    const panel = { open: false, showModal() { this.open = true; } };
    const text = { textContent: "" };
    let resolveFirst!: (body: unknown) => void;
    const paths: string[] = [];
    const api = (path: string) => {
      paths.push(path);
      return paths.length === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ resources: { summary: "latest catalog" } });
    };
    const page = new Function("api", "seg", "$", `let ghost = "casper", session = "c1", draft = null, resourceGeneration = 0; ${source}; return { open: showResources, switchSession() { session = "c2"; resourceGeneration++; } };`)(
      api, encodeURIComponent, (id: string) => id === "resource-panel" ? panel : text,
    );
    expect(paths).toEqual([]);
    const first = page.open();
    page.switchSession();
    await page.open();
    resolveFirst({ resources: { summary: "stale catalog" } });
    await first;
    expect(text.textContent).toBe("latest catalog");
    expect(paths).toEqual(["/ghosts/casper/sessions/c1/transcript?limit=1", "/ghosts/casper/sessions/c2/transcript?limit=1"]);
  });

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
    const loadTranscript = new Function("api", "seg", "render", "ghost", "session", "draft", `let readThrough; const markDisplayedRead = async () => {}; ${source}; return loadTranscript;`)(
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

describe("remote routine controls", () => {
  function routinePage(api: (path: string, init?: RequestInit) => Promise<unknown>) {
    const source = REMOTE_VIEWER_HTML.match(/async function showRoutines\(\) \{[\s\S]*?\n {2}\}/u)?.[0];
    expect(source).toBeDefined();
    const panel = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    const makeNode = (tag: string): any => ({
      tag, textContent: "", children: [], disabled: false,
      append(...children: unknown[]) { this.children.push(...children); },
      querySelectorAll(tag: string): any[] {
        return this.children.flatMap((child: any) => [
          ...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag),
        ]);
      },
    });
    const list = makeNode("div");
    const editor = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    const nodes: Record<string, any> = { "routine-panel": panel, "routine-list": list, "routine-editor": editor };
    const element = (id: string) => nodes[id] ??= makeNode(id);
    const save = REMOTE_VIEWER_HTML.match(/\$\("routine-save"\)\.onclick = async \(\) => \{[\s\S]*?\n {2}\};/u)?.[0];
    expect(save).toBeDefined();
    const page = new Function("api", "seg", "$", "document", `
      let ghost = "casper", owner = true, routineGeneration = 0, routineDraft = null;
      ${source}; ${save}; return { open: showRoutines, save() { return $("routine-save").onclick(); }, switchGhost() { ghost = "other"; routineGeneration++; }, guest() { owner = false; } };
    `)(api, encodeURIComponent, element, { createElement: makeNode });
    return { page, panel, list, editor, element };
  }

  test("shows routine state as text and routes actions to the owning ghost", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const { page, list } = routinePage(async (path, init) => {
      calls.push({ path, init });
      if (path.endsWith("/recoveries")) return { recoveries: [] };
      return { recoveries: [], routines: [{ ghost: "casper", slug: "daily", enabled: "disabled", active: "inactive",
        schedule: "OnCalendar=daily", nextRun: null, lastRun: null, serviceActive: "inactive", result: "",
        command: "<script>private command</script>" }] };
    });
    await page.open();
    const [card] = list.children;
    expect(card.children[1].textContent).toContain("\nNext: unknown\nLast run: never/unknown");
    expect(card.children[1].textContent).toContain("<script>private command</script>");
    const buttons = card.querySelectorAll("button");
    expect(buttons.map((button: any) => button.textContent)).toEqual(["Pause", "Resume", "Run now", "Logs", "Edit", "Remove"]);
    await buttons[0].onclick();
    expect(calls[1]).toMatchObject({ path: "/ghosts/casper/routines/daily/pause", init: { method: "POST", body: "{}" } });
    expect(calls[2]?.path).toBe("/ghosts/casper/routines");
  });

  test("editing preserves the draft on conflict and closes only after an accepted save", async () => {
    let fail = true;
    const writes: unknown[] = [];
    const { page, list, editor, element } = routinePage(async (path, init) => {
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        if (fail) throw new Error("Source changed");
        return { recovery: "checkpoint" };
      }
      if (path.endsWith("/config")) return { timer: "[Timer]\nOnCalendar=daily", service: "[Service]\nExecStart=/usr/bin/true", revision: "original" };
      if (path.endsWith("/recoveries")) return { recoveries: [] };
      return { recoveries: [], routines: [{ ghost: "casper", slug: "daily", enabled: "enabled", active: "active", schedule: "daily", command: "" }] };
    });
    await page.open();
    await list.children[0].querySelectorAll("button").find((button: any) => button.textContent === "Edit").onclick();
    expect(editor.open).toBe(true);
    element("routine-timer").value = "[Timer]\nOnCalendar=weekly";
    await page.save();
    expect(editor.open).toBe(true);
    expect(element("routine-editor-error").textContent).toBe("Source changed");
    expect(element("routine-timer").value).toBe("[Timer]\nOnCalendar=weekly");
    expect(writes[0]).toMatchObject({ timer: "[Timer]\nOnCalendar=weekly", revision: "original" });
    fail = false;
    await page.save();
    expect(editor.open).toBe(false);
  });

  test("does not fetch for guests and drops an old ghost's delayed reply", async () => {
    let resolve!: (body: unknown) => void;
    let reads = 0;
    const { page, list } = routinePage(() => { reads++; return new Promise(done => { resolve = done; }); });
    const pending = page.open();
    page.switchGhost();
    resolve({ routines: [] });
    await pending;
    expect(list.textContent).toBe("Reading routines…");
    page.guest();
    await page.open();
    expect(reads).toBe(1);
  });

  test("shows a manager failure instead of an empty list", async () => {
    const { page, list } = routinePage(async () => { throw new Error("User manager unavailable"); });
    await page.open();
    expect(list.textContent).toBe("User manager unavailable");
  });
});
