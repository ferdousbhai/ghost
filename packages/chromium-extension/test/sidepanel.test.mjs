/**
 * The side panel document, against a fake DOM and a stubbed OpenRouter.
 *
 * `agent.js` pins the loop's rules; this pins the surface that carries them —
 * that an unconnected panel offers no composer, that a turn's tool calls and
 * cost are visible rather than silent, and that the script card is a real gate
 * whose buttons decide whether the page op runs at all.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const originals = {
  chrome: globalThis.chrome,
  document: globalThis.document,
  fetch: globalThis.fetch,
  window: globalThis.window,
};

afterEach(() => {
  for (const [field, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[field];
    else globalThis[field] = value;
  }
});

class FakeNode {
  constructor(tag = "div", id = "") {
    this.tag = tag;
    this.id = id;
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
  }

  addEventListener(event, listener) {
    this.listeners.set(event, listener);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeNode) node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    const siblings = this.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }

  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }

  querySelector(selector) {
    const wanted = selector.replace(".", "");
    for (const child of this.children) {
      if (!(child instanceof FakeNode)) continue;
      if (child.className.split(" ").includes(wanted)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }

  focus() {}

  click() {
    this.listeners.get("click")?.({});
  }

  get text() {
    return `${this.textContent}${this.children.map((child) => child.text ?? child.textContent ?? "").join("")}`;
  }
}

const PANEL_IDS = [
  "model", "newChat", "disconnect", "paused", "notice", "connect", "oauth", "openAuth",
  "manual", "manualDetails", "manualSave", "connectError", "log", "composerBar", "input",
  "send", "stop", "usage",
];

function panelDocument() {
  const elements = Object.fromEntries(PANEL_IDS.map((id) => [id, new FakeNode("div", id)]));
  const listeners = new Map();
  return {
    elements,
    activeElement: null,
    getElementById: (id) => elements[id],
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => ({ textContent: text, text }),
    addEventListener: (event, listener) => listeners.set(event, listener),
  };
}

function storageArea(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (defaults) => {
      const out = { ...defaults };
      for (const field of Object.keys(defaults)) {
        if (store.has(field)) out[field] = store.get(field);
      }
      return out;
    },
    set: async (value) => {
      for (const [field, entry] of Object.entries(value)) store.set(field, entry);
    },
    remove: async (field) => { store.delete(field); },
  };
}

function sseBody(lines) {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
}

function setUp({ key = "sk-or-test", ops = async () => ({ ok: true, result: {} }), enabled = true } = {}) {
  const document = panelDocument();
  const local = storageArea({ ...(key === null ? {} : { openRouterKey: key }), enabled });
  const sent = [];
  const storageListeners = [];
  globalThis.document = document;
  globalThis.window = { addEventListener: () => {} };
  globalThis.chrome = {
    identity: {
      getRedirectURL: () => "https://abc.chromiumapp.org/",
      launchWebAuthFlow: async () => "https://abc.chromiumapp.org/?code=granted",
    },
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        if (message.type === "ghost-relay-local-reset") return { ok: true, session: "local:next" };
        return ops(message);
      },
    },
    storage: {
      local,
      session: storageArea(),
      onChanged: { addListener: (listener) => storageListeners.push(listener) },
    },
    tabs: { create: async () => ({ id: 1 }) },
  };
  return { document, local, sent, storageListeners };
}

const load = (label) => import(`../extension/sidepanel.js?${label}=${Date.now()}-${Math.random()}`);

async function settle(times = 6) {
  for (let turn = 0; turn < times; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("an unconnected panel offers a way to connect and no way to chat", async () => {
  const { document } = setUp({ key: null });
  globalThis.fetch = async () => { throw new Error("must not call OpenRouter before connecting"); };
  await load("unconnected");
  await settle();

  assert.equal(document.elements.connect.hidden, false);
  assert.equal(document.elements.composerBar.hidden, true);
  assert.equal(document.elements.log.hidden, true);
  assert.equal(document.elements.disconnect.hidden, true);
});

test("a turn shows the tool calls it made, and what the answer cost", async () => {
  const calls = [];
  const { document, sent } = setUp({
    ops: async (message) => {
      calls.push([message.op, message.args]);
      return { ok: true, result: { page: { url: "https://example.com/" }, id: "17" } };
    },
  });
  let step = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    step += 1;
    return {
      ok: true,
      status: 200,
      body: step === 1
        ? sseBody([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"open","arguments":"{\\"url\\":\\"https://example.com/\\"}"}}]}}]}',
          "data: [DONE]",
        ])
        : sseBody([
          'data: {"model":"some/free-model","choices":[{"delta":{"content":"Opened it."}}]}',
          'data: {"usage":{"total_tokens":20,"cost":0}}',
          "data: [DONE]",
        ]),
      json: async () => ({}),
    };
  };

  await load("turn");
  await settle();
  document.elements.input.value = "open example.com";
  document.elements.send.listeners.get("click")();
  await settle(40);

  assert.deepEqual(calls, [["open", { url: "https://example.com/" }]]);
  const shown = document.elements.log.children.map((node) => node.text);
  assert.ok(shown.some((line) => line.includes("open example.com")), "the ask is in the log");
  assert.ok(shown.some((line) => line.includes("→ open")), "the tool call is visible");
  assert.ok(shown.some((line) => line.includes("Opened it.")), "the answer is visible");
  assert.ok(shown.some((line) => line.includes("some/free-model") && line.includes("free")),
    "the model that answered and its cost are visible");
  assert.equal(document.elements.usage.textContent, "some/free-model · 20 tokens · free");
  // The panel never names a workspace; the worker stamps its own.
  for (const message of sent.filter((entry) => entry.type === "ghost-relay-local-op")) {
    assert.equal(message.args.session, undefined);
  }
});

test("page script runs only when the owner presses the card's allow button", async () => {
  for (const [label, button, expected] of [["allow", 0, 1], ["deny", 1, 0]]) {
    const runs = [];
    const { document } = setUp({
      ops: async (message) => {
        runs.push(message.op);
        return { ok: true, result: { value: "Example" } };
      },
    });
    let step = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      step += 1;
      return {
        ok: true,
        status: 200,
        body: step === 1
          ? sseBody([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"javascript","arguments":"{\\"tab\\":\\"17\\",\\"code\\":\\"document.title\\"}"}}]}}]}',
            "data: [DONE]",
          ])
          : sseBody(['data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"]),
        json: async () => ({}),
      };
    };

    await load(`confirm-${label}`);
    await settle();
    document.elements.input.value = "read the title with script";
    document.elements.send.listeners.get("click")();
    await settle(20);

    const card = document.elements.log.children.find((node) => node.className === "confirm");
    assert.ok(card, `${label}: the card is shown before anything runs`);
    assert.deepEqual(runs, [], `${label}: nothing ran while the card was open`);
    assert.ok(card.text.includes("document.title"), `${label}: the card shows the exact code`);

    card.querySelector(".row").children[button].click();
    await settle(20);
    assert.deepEqual(runs, expected === 1 ? ["javascript"] : [],
      `${label}: the button decided whether the op ran`);
  }
});

/** A fetch that streams nothing and ends only when its signal is aborted. */
function hangingFetch() {
  let aborted = 0;
  const fetch = async (url, options) => {
    if (String(url).includes("/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          options.signal.addEventListener("abort", () => {
            aborted += 1;
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        },
      }),
      json: async () => ({}),
    };
  };
  return { fetch, count: () => aborted };
}

test("pause arriving from the popup stops the turn in flight", async () => {
  const { document, storageListeners } = setUp();
  const hanging = hangingFetch();
  globalThis.fetch = hanging.fetch;

  await load("paused");
  await settle();
  document.elements.input.value = "do something slow";
  document.elements.send.listeners.get("click")();
  await settle(10);
  assert.equal(document.elements.stop.hidden, false, "a turn is in flight");
  assert.equal(hanging.count(), 0);

  storageListeners[0]({ enabled: { newValue: false } }, "local");
  await settle(20);

  assert.equal(hanging.count(), 1, "the in-flight request was aborted by the pause");
  assert.equal(document.elements.paused.hidden, false);
  assert.equal(document.elements.stop.hidden, true, "the turn ended");
  assert.ok(document.elements.log.children.some((node) => node.text.includes("Paused from the relay popup")));
});

test("Stop aborts the request and says it is stopping until the turn ends", async () => {
  const { document } = setUp();
  const hanging = hangingFetch();
  globalThis.fetch = hanging.fetch;

  await load("stop");
  await settle();
  document.elements.input.value = "do something slow";
  document.elements.send.listeners.get("click")();
  await settle(10);

  document.elements.stop.listeners.get("click")();
  assert.equal(document.elements.stop.textContent, "Stopping…");
  assert.equal(document.elements.stop.disabled, true);
  await settle(20);
  assert.equal(hanging.count(), 1);
  assert.equal(document.elements.stop.hidden, true);
});

test("persisted history is cut at turn boundaries and keeps the system prompt", async () => {
  setUp();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const { trimTurns } = await load("trim");
  const history = [
    { role: "system", content: "rules" },
    { role: "user", content: "one" },
    { role: "assistant", content: "", tool_calls: [{ id: "a" }] },
    { role: "tool", tool_call_id: "a", content: "r" },
    { role: "assistant", content: "done one" },
    { role: "user", content: "two" },
    { role: "assistant", content: "done two" },
  ];
  const isUser = (message) => message.role === "user" && typeof message.content === "string";
  const kept = trimTurns(history, isUser, (entries) => entries.length <= 4);
  assert.deepEqual(kept.map((message) => `${message.role}:${message.content}`), [
    "system:rules", "user:two", "assistant:done two",
  ]);
  // A cut that would strand a tool result never happens: the whole turn goes.
  assert.ok(!kept.some((message) => message.role === "tool"));
  assert.deepEqual(trimTurns(history, isUser, () => true), history);
});

test("a one-click failure reveals the manual path instead of pointing at a closed drawer", async () => {
  const { document } = setUp({ key: null });
  chrome.identity.launchWebAuthFlow = async () => "https://abc.chromiumapp.org/?error=denied";
  globalThis.fetch = async () => { throw new Error("must not be reached"); };
  await load("oauth-failure");
  await settle();

  document.elements.oauth.listeners.get("click")();
  await settle(10);
  assert.equal(document.elements.connectError.hidden, false);
  assert.equal(document.elements.manualDetails.open, true);
  assert.equal(document.elements.oauth.disabled, true, "the failed button is not offered again");
});

test("disconnect forgets the key and puts the connect panel back", async () => {
  const { document, local } = setUp();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  await load("disconnect");
  await settle();
  assert.equal(document.elements.connect.hidden, true);

  document.elements.disconnect.listeners.get("click")();
  await settle();

  assert.equal(local.store.has("openRouterKey"), false);
  assert.equal(document.elements.connect.hidden, false);
  assert.equal(document.elements.composerBar.hidden, true);
});
