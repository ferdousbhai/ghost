/**
 * The side panel: the chat surface, and the only place the owner's OpenRouter
 * key is ever read.
 *
 * The turn loop runs *here*, not in the service worker, because a panel document
 * lives as long as the owner keeps it open while an MV3 worker is reaped after
 * thirty idle seconds. That choice has one visible consequence, and it is the
 * honest one: closing the panel ends the turn, the same as pressing Stop. What
 * already happened is persisted, so reopening shows the conversation.
 *
 * The worker still owns the tabs. Every page operation goes back through it, so
 * the panel never names a workspace and never touches `chrome.debugger`.
 */
import { runTurn, SYSTEM_PROMPT, TurnStopped } from "./agent.js";
import {
  beginAuth,
  codeFromCallback,
  DEFAULT_MODEL,
  exchangeCode,
  listModels,
  streamChat,
} from "./openrouter.js";
import { toolDefinitions } from "./tools.js";

const KEY_STORE = "openRouterKey";
const MODEL_STORE = "openRouterModel";
const CHAT_STORE = "localChat";
/** Enough to keep a working conversation, small enough to always fit storage. */
const MAX_PERSISTED_ENTRIES = 400;
const MAX_PERSISTED_BYTES = 1_500_000;
const OP_TIMEOUT_MS = 60_000;

const ui = Object.fromEntries([
  "model", "newChat", "disconnect", "paused", "notice", "connect", "oauth", "openAuth",
  "manual", "manualDetails", "manualSave", "connectError", "log", "composerBar", "input",
  "send", "stop", "usage",
].map((id) => [id, document.getElementById(id)]));

const tools = toolDefinitions();

let key = null;
let model = DEFAULT_MODEL;
/** What the model sees. */
let messages = [];
/** What the owner sees. Separate because the two diverge: images and clipping. */
let record = [];
let turn = null;
let controller = null;
let paused = false;

// ---------------------------------------------------------------- persistence

function storable(entries) {
  return entries.map((entry) => (Array.isArray(entry?.content)
    // Screenshots are the one payload that would blow the storage quota, and a
    // stored one is of no use to anybody: the page has moved on.
    ? { ...entry, content: "[screenshot]" }
    : entry));
}

/**
 * Drop whole turns from the front until the history fits. A cut anywhere else
 * leaves a `tool` message without the `assistant` call it answers, which the
 * API refuses, and the system prompt at index 0 is not a turn and stays.
 */
export function trimTurns(entries, isTurnStart, fits) {
  const head = entries[0]?.role === "system" ? [entries[0]] : [];
  let body = entries.slice(head.length);
  while (!fits([...head, ...body]) && body.length > 0) {
    const next = body.findIndex((entry, index) => index > 0 && isTurnStart(entry));
    body = next === -1 ? [] : body.slice(next);
  }
  return [...head, ...body];
}

const startsTurn = (message) => message.role === "user" && typeof message.content === "string";
const startsRecord = (entry) => entry.kind === "user";

async function persist() {
  const payload = {
    messages: trimTurns(storable(messages), startsTurn,
      (kept) => kept.length <= MAX_PERSISTED_ENTRIES),
    record: trimTurns(record, startsRecord, (kept) => kept.length <= MAX_PERSISTED_ENTRIES),
    model,
  };
  while (JSON.stringify(payload).length > MAX_PERSISTED_BYTES && payload.messages.length > 1) {
    payload.messages = trimTurns(payload.messages, startsTurn,
      (kept) => kept.length < payload.messages.length);
    payload.record = trimTurns(payload.record, startsRecord,
      (kept) => kept.length < payload.record.length);
  }
  await chrome.storage.local.set({ [CHAT_STORE]: payload }).catch(() => {});
}

async function restore() {
  const stored = await chrome.storage.local
    .get({ [KEY_STORE]: null, [MODEL_STORE]: null, [CHAT_STORE]: null })
    .catch(() => ({}));
  key = typeof stored?.[KEY_STORE] === "string" && stored[KEY_STORE] !== ""
    ? stored[KEY_STORE]
    : null;
  model = typeof stored?.[MODEL_STORE] === "string" && stored[MODEL_STORE] !== ""
    ? stored[MODEL_STORE]
    : DEFAULT_MODEL;
  const chat = stored?.[CHAT_STORE];
  messages = Array.isArray(chat?.messages) ? chat.messages : [];
  record = Array.isArray(chat?.record) ? chat.record : [];
  // The pause switch is the popup's `enabled`; `storage.onChanged` below keeps
  // it current, and the worker refuses a paused op regardless of what this
  // document believes.
  const settings = await chrome.storage.local.get({ enabled: true }).catch(() => ({ enabled: true }));
  paused = settings.enabled === false;
}

// -------------------------------------------------------------------- the UI

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEntry(entry) {
  if (entry.kind === "user" || entry.kind === "assistant") {
    const turnNode = el("div", `turn ${entry.kind}`);
    turnNode.append(el("div", "who", entry.kind === "user" ? "you" : "agent"));
    turnNode.append(el("div", "body", entry.text));
    return turnNode;
  }
  if (entry.kind === "tool") {
    return el("div", `tool${entry.failed ? " bad" : ""}`, entry.text);
  }
  if (entry.kind === "usage") return el("div", "usage", entry.text);
  return el("div", "error", entry.text);
}

function render() {
  ui.connect.hidden = key !== null;
  ui.log.hidden = key === null;
  ui.composerBar.hidden = key === null;
  ui.model.hidden = key === null;
  ui.disconnect.hidden = key === null;
  ui.model.disabled = turn !== null;
  ui.newChat.disabled = turn !== null;
  ui.send.hidden = turn !== null;
  ui.stop.hidden = turn === null;
  // The wire has no cancel: a page op already handed to Chromium finishes. Stop
  // ends the turn at the next step and says so rather than looking ignored.
  ui.stop.disabled = controller?.signal.aborted === true;
  ui.stop.textContent = controller?.signal.aborted === true ? "Stopping…" : "Stop";
  ui.paused.hidden = !paused;

  ui.log.replaceChildren(...record.map(renderEntry));
  if (pendingConfirm !== null) ui.log.append(pendingConfirm.node);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function say(entry) {
  record.push(entry);
  render();
}

/** Grow the last assistant entry as tokens arrive, without a full re-render. */
function streamInto(text) {
  const last = record.at(-1);
  if (last?.kind !== "assistant") {
    say({ kind: "assistant", text });
    return;
  }
  last.text += text;
  const node = ui.log.lastElementChild?.querySelector(".body");
  if (node) {
    node.textContent = last.text;
    ui.log.scrollTop = ui.log.scrollHeight;
  } else {
    render();
  }
}

function summarize(name, args) {
  const detail = name === "javascript"
    ? (args.code ?? "")
    : Object.entries(args)
      .filter(([field]) => field !== "tab")
      .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
      .join(" ");
  return `${name} ${detail}`.trim().slice(0, 400);
}

// ------------------------------------------------------------- the worker hop

async function ask(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response === null || response === undefined) {
    throw new Error("The relay worker did not answer. Reopen this panel.");
  }
  return response;
}

async function runTool(name, args) {
  const response = await ask({
    type: "ghost-relay-local-op",
    op: name,
    args,
    timeoutMs: OP_TIMEOUT_MS,
  });
  if (response.ok !== true) throw new Error(response.error);
  return response.result;
}

// --------------------------------------------------------- the script consent

let pendingConfirm = null;

/**
 * The one operation that runs page JavaScript asks, every time. It is not a
 * remembered preference: the code is different each time, and the whole point
 * of showing it is that the owner reads *this* code.
 */
function confirmScript({ name, args }) {
  return new Promise((resolve) => {
    const node = el("div", "confirm");
    node.append(el("div", "who", `${name} — run this in the page?`));
    node.append(el("pre", null, String(args.code ?? "")));
    const row = el("div", "row");
    const allow = el("button", "primary", "Run it");
    const deny = el("button", null, "Don't");
    row.append(allow, deny);
    node.append(row);
    const answer = (value) => {
      pendingConfirm = null;
      node.remove();
      resolve(value);
    };
    allow.addEventListener("click", () => answer(true));
    deny.addEventListener("click", () => answer(false));
    pendingConfirm = { node, answer };
    render();
    allow.focus();
  });
}

// ------------------------------------------------------------------ the turn

function usageLine(model, usage) {
  const tokens = usage?.total_tokens ?? null;
  const cost = typeof usage?.cost === "number" ? usage.cost : null;
  const parts = [model];
  if (tokens !== null) parts.push(`${tokens} tokens`);
  parts.push(cost === null ? "cost unreported" : cost === 0 ? "free" : `$${cost.toFixed(6)}`);
  return parts.join(" · ");
}

async function send() {
  const text = ui.input.value.trim();
  if (text === "" || turn !== null || key === null) return;
  ui.input.value = "";
  ui.notice.hidden = true;

  if (messages.length === 0) messages.push({ role: "system", content: SYSTEM_PROMPT });
  messages.push({ role: "user", content: text });
  say({ kind: "user", text });

  controller = new AbortController();
  turn = (async () => {
    try {
      const outcome = await runTurn({
        messages,
        model,
        tools,
        chat: (request) => streamChat({ key, ...request }),
        runTool,
        confirm: confirmScript,
        signal: controller.signal,
        // A step's text arrives token by token, so `assistant` itself needs no
        // entry — `delta` already wrote one, and a tool-only step says nothing.
        onEvent: (event) => {
          if (event.type === "delta") streamInto(event.text);
          else if (event.type === "tool") {
            say({ kind: "tool", text: `→ ${summarize(event.name, event.args)}` });
          } else if (event.type === "tool_result") {
            const failed = typeof event.result?.error === "string";
            say({
              kind: "tool",
              failed,
              text: failed ? `← ${event.result.error}` : `← ${event.name} ok`,
            });
          }
        },
      });
      const line = usageLine(outcome.model, outcome.usage);
      say({ kind: "usage", text: line });
      ui.usage.textContent = line;
    } catch (error) {
      if (error instanceof TurnStopped || error?.name === "AbortError") {
        say({ kind: "usage", text: error instanceof TurnStopped ? error.message : "Stopped." });
      } else {
        say({ kind: "error", text: error?.message ?? String(error) });
      }
    } finally {
      pendingConfirm?.answer(false);
      controller = null;
      turn = null;
      render();
      await persist();
    }
  })();
  render();
}

function stop() {
  controller?.abort();
  pendingConfirm?.answer(false);
  render();
}

// ---------------------------------------------------------------- connecting

async function saveKey(value) {
  key = value;
  await chrome.storage.local.set({ [KEY_STORE]: value });
  ui.connectError.hidden = true;
  ui.notice.hidden = true;
  await loadModels();
  render();
}

function connectFailed(error) {
  ui.connectError.textContent = error?.message ?? String(error);
  ui.connectError.hidden = false;
  // The manual path lives under a closed <details>; an error that points at it
  // must also reveal it.
  ui.manualDetails.open = true;
}

async function oauthConnect() {
  ui.oauth.disabled = true;
  try {
    const redirect = chrome.identity.getRedirectURL();
    const { url, verifier } = await beginAuth({ callbackUrl: redirect });
    const answered = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    const code = codeFromCallback(answered ?? "");
    if (code === null) {
      throw new Error("OpenRouter did not return a code. Use the manual path below.");
    }
    await saveKey(await exchangeCode({ code, verifier }));
    ui.oauth.disabled = false;
  } catch (error) {
    // One-click failed once in this document; the fallback is the path now.
    // The button comes back with the next panel open.
    connectFailed(error);
  }
}

/**
 * The fallback that works whatever a callback URL is allowed to be.
 *
 * The verifier outlives this document in `chrome.storage.session`: the owner
 * leaves for another tab to read the code, and Chrome may reload the panel while
 * they are gone. It is session storage, so it never reaches disk and is gone
 * when the browser closes.
 */
const VERIFIER_STORE = "openRouterVerifier";

async function openManualAuth() {
  try {
    const { url, verifier } = await beginAuth();
    await chrome.storage.session.set({ [VERIFIER_STORE]: verifier });
    await chrome.tabs.create({ url });
  } catch (error) {
    connectFailed(error);
  }
}

async function useManual() {
  const value = ui.manual.value.trim();
  if (value === "") return;
  ui.manualSave.disabled = true;
  try {
    if (value.startsWith("sk-")) {
      await saveKey(value);
    } else {
      const stored = await chrome.storage.session
        .get({ [VERIFIER_STORE]: null })
        .catch(() => ({}));
      const verifier = stored?.[VERIFIER_STORE] ?? null;
      if (verifier === null) {
        throw new Error("Open the authorization page first, so the code can be matched to this browser.");
      }
      await saveKey(await exchangeCode({ code: value, verifier }));
    }
    ui.manual.value = "";
    await chrome.storage.session.remove(VERIFIER_STORE).catch(() => {});
  } catch (error) {
    connectFailed(error);
  } finally {
    ui.manualSave.disabled = false;
  }
}

/** The way out. The key is this browser's copy, so forgetting it is the whole undo. */
async function disconnect() {
  stop();
  key = null;
  await chrome.storage.local.remove(KEY_STORE).catch(() => {});
  render();
}

async function loadModels() {
  const fallback = [{ id: DEFAULT_MODEL, name: "Free Models Router", free: true }];
  let models = fallback;
  try {
    const listed = await listModels();
    if (listed.length > 0) models = listed;
  } catch {
    ui.notice.textContent = "Could not load the model list; the free router is still available.";
    ui.notice.hidden = false;
  }
  if (!models.some((entry) => entry.id === model)) {
    // Keep showing the id the next turn will actually send, rather than a
    // catalog entry the picker only appears to have chosen.
    models = [{ id: model, name: `${model} — no longer listed`, free: false }, ...models];
  }
  ui.model.replaceChildren(...models.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.free ? `${entry.name} — free` : entry.name;
    option.selected = entry.id === model;
    return option;
  }));
}

async function newChat() {
  stop();
  const response = await ask({ type: "ghost-relay-local-reset" });
  messages = [];
  record = [];
  ui.usage.textContent = "";
  if (response.ok !== true) say({ kind: "error", text: response.error });
  await persist();
  render();
}

// ------------------------------------------------------------------- wiring

ui.send.addEventListener("click", () => void send());
ui.stop.addEventListener("click", stop);
ui.newChat.addEventListener("click", () => void newChat());
ui.oauth.addEventListener("click", () => void oauthConnect());
ui.openAuth.addEventListener("click", () => void openManualAuth());
ui.manualSave.addEventListener("click", () => void useManual());
ui.disconnect.addEventListener("click", () => void disconnect());
ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});
ui.model.addEventListener("change", () => {
  model = ui.model.value;
  void chrome.storage.local.set({ [MODEL_STORE]: model }).catch(() => {});
});

// Pause is one switch for both sides: the popup flips it, and a turn in flight
// here stops at its next step rather than finishing behind the owner's back.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  paused = changes.enabled.newValue === false;
  if (paused && turn !== null) {
    say({ kind: "usage", text: "Paused from the relay popup. Resume there to continue." });
    stop();
  }
  render();
});

// The whole conversation is in this document; a reload without a save would
// lose it, and Chrome may reload a panel whenever it likes.
window.addEventListener("pagehide", () => void persist());

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && turn !== null) stop();
});

void (async () => {
  await restore();
  if (key !== null) await loadModels();
  render();
})();
