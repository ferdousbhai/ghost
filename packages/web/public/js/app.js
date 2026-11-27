/**
 * SummonGhost: every machine the owner has added, each with its one ghost and
 * that ghost's one conversation, talked to straight over Tailscale, as a
 * messaging app shows its chats. The route lives in the hash, `#/<host>`, so
 * the back button walks out.
 */
import { renderMarkdown } from "./markdown.js";
import { api, base, label, normalizeHost, request, seg, shortName, tailnetOf } from "./net.js";
import * as push from "./push.js";
import { load, save } from "./store.js";
import { fold, link, newestOffset, olderPage, routeHost, thread, turnEvents, when, worked } from "./thread.js";
import { toolCall } from "./tool-call.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const svg = (name, cls = "icon") => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("class", cls);
  node.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  node.append(use);
  return node;
};

// ── Machines ────────────────────────────────────────────────────────────────

const saved = load();
/**
 * Each: `{ host, role, ghost, seen }` as saved (`ghost` is its ghost's name),
 * plus, for this visit only, `status`, `error`, `conv` (its conversation as
 * `GET /api/conversation` gives it) and `last` (its last message's words).
 */
const machines = saved.machines.map((m) => ({ ...m, status: "unknown", error: null, conv: null, last: "" }));
const forgotten = new Set(saved.forgotten);
let storageWorks = true;

const machineOf = (host) => machines.find((m) => m.host === host);
function persist() {
  storageWorks = save(machines, [...forgotten]);
  renderBanner();
}

function addMachine(host, fields = {}) {
  forgotten.delete(host);
  let m = machineOf(host);
  if (!m) {
    m = { host, role: null, ghost: null, seen: 0, status: "unknown", error: null, conv: null, last: "", ...fields };
    machines.push(m);
  }
  persist();
  return m;
}

function forgetMachine(host) {
  const at = machines.findIndex((m) => m.host === host);
  if (at >= 0) machines.splice(at, 1);
  forgotten.add(host);
  persist();
  if (route === host) location.hash = link();
  renderHome();
}

const refreshing = new Map();
/** Asks one machine who we are and what its ghost is called; an owner also hears of the owner's other machines. */
function refreshMachine(m) {
  if (refreshing.has(m.host)) return refreshing.get(m.host);
  const run = (async () => {
    m.status = "checking";
    renderHome();
    try {
      const who = await api(m.host, "/remote/whoami");
      m.role = who.role;
      m.ghost = (await api(m.host, "/ghost")).name;
      m.seen = Date.now();
      m.status = "online";
      m.error = null;
      persist();
      // The open chat reads its own conversation, and its row with it.
      if (m.host === route) loadConversation().catch(show);
      else await readSummary(m).catch(() => {});
      if (m.role === "owner") discover(m).catch(() => {});
      // A machine reached as owner hears of this device, when alerts are on here.
      if (m.role === "owner") push.sync(m.host).catch(() => {});
    } catch (error) {
      m.status = error.kind === "unreachable" ? "offline" : "error";
      m.error = error;
    } finally {
      refreshing.delete(m.host);
      renderHome();
      if (m.host === route) {
        applyRole();
        drawMeta();
      }
    }
  })();
  refreshing.set(m.host, run);
  return run;
}

/** The owner's other tailnet machines, as one machine lists them; each that answers as Ghost joins the list. */
async function discover(m) {
  let listed;
  try {
    listed = (await api(m.host, "/remote/machines")).machines;
  } catch {
    return; // A Ghost without discovery still works alone.
  }
  if (!Array.isArray(listed)) return;
  await Promise.all(listed.map(async (entry) => {
    const host = normalizeHost(entry?.hostname, tailnetOf(m.host));
    if (!host || machineOf(host) || forgotten.has(host) || entry.online === false) return;
    try {
      const who = await api(host, "/remote/whoami");
      if (who.role !== "owner") return;
    } catch {
      return; // No Ghost there, or not reachable: not a machine to list.
    }
    if (!machineOf(host) && !forgotten.has(host)) refreshMachine(addMachine(host));
  }));
}

const refreshAll = () => Promise.all(machines.map(refreshMachine));

/** What a ghost bubble says in one line: its words, else why it failed, else what it did. */
function lastWords(item) {
  if (!item) return "";
  if (item.kind === "owner") return "You: " + (item.text.split("\n")[0] || "Photo");
  if (item.kind === "hook") return item.text.split("\n")[0];
  const said = renderMarkdown(item.text, document).firstChild?.textContent.trim() || "";
  return (said.split("\n")[0] || (item.error ? "Failed: " + item.error : worked(item.steps))).slice(0, 200);
}

/** A machine's row, for a chat that is not open: its conversation's summary and its last message. */
async function readSummary(m) {
  m.conv = await api(m.host, "/conversation");
  const count = m.conv.messageCount;
  const tail = count ? (await api(m.host, "/conversation/transcript?limit=1&offset=" + (count - 1))).messages : [];
  m.last = lastWords(thread(tail).at(-1));
}

// ── Home: the machines, as a messaging app lists its chats ──────────────────

function renderBanner() {
  const reached = machines.filter((m) => m.status !== "unknown" && m.status !== "checking");
  let text = "";
  if (reached.length && reached.length === machines.length && machines.every((m) => m.error?.kind === "unreachable")) {
    text = "Can't reach any of your machines. Is Tailscale connected on this device?";
  } else if (!storageWorks && machines.length) {
    text = "This browser isn't keeping site data, so this machine list will be forgotten when you close it.";
  }
  $("banner").textContent = text;
}

function ago(time) {
  if (!time) return "never seen";
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "seen just now";
  if (minutes < 60) return `seen ${minutes}m ago`;
  if (minutes < 48 * 60) return `seen ${Math.round(minutes / 60)}h ago`;
  return `seen ${Math.round(minutes / 1440)}d ago`;
}

/** A machine's row: its ghost, the last message and when, and whether there is something unread. */
function machineRow(m) {
  const c = m.status === "online" || m.status === "checking" ? m.conv : null;
  const row = el(m.ghost ? "a" : "div", "chat-row" + (m.status === "offline" || m.status === "error" ? " stale" : c?.unread ? " unread" : ""));
  if (m.ghost) {
    row.href = link(m.host);
    if (route === m.host) row.setAttribute("aria-current", "page");
  }
  const avatar = el("span", "avatar");
  avatar.append(svg("ghost", "glyph"), el("span", "dot " + (m.status === "unknown" ? "" : m.status)));
  const top = el("span", "row-top"), bottom = el("span", "row-bottom");
  const machine = el("span", "row-machine", m.ghost ? label(m.host) : "");
  machine.title = m.host;
  top.append(el("span", "row-name", m.ghost || label(m.host)), machine, el("span", "row-time", when(c?.updatedAt)));
  const state = {
    online: "",
    checking: c ? "" : "checking…",
    offline: "offline · " + ago(m.seen),
    error: m.error?.kind === "outdated" ? "update Ghost" : m.error?.kind === "not-owner" ? "not yours" : "error",
    unknown: "",
  }[m.status];
  bottom.append(el("span", "row-last" + (c?.running ? " working" : ""), state || (c?.running ? "working…" : m.last || (c ? "No messages yet" : ""))));
  if (c?.question) bottom.append(el("span", "tag", "asks"));
  if (c?.unread) {
    const badge = el("span", "badge");
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", "Unread");
    bottom.append(badge);
  }
  const text = el("span", "row-text");
  text.append(top, bottom);
  row.append(avatar, text);
  return row;
}

function renderHome() {
  renderBanner();
  const empty = !machines.length;
  $("first-run").hidden = !empty;
  if (empty) $("add-form").hidden = false;
  renderAlerts().catch(() => {});
  const list = $("machines");
  // A refresh redraws the rows; a menu the owner has open stays open.
  const menu = list.querySelector("details[open]")?.dataset.host;
  list.replaceChildren();
  for (const m of machines) {
    const card = el("article", "machine");
    const tools = el("details", "tools");
    tools.dataset.host = m.host;
    tools.open = menu === m.host;
    const summary = el("summary", "", "⋯");
    summary.setAttribute("aria-label", "Menu for " + label(m.host));
    const forget = el("button", "", "Remove");
    forget.type = "button";
    forget.onclick = () => {
      if (forget.classList.contains("danger")) return forgetMachine(m.host);
      forget.classList.add("danger");
      forget.textContent = "Tap again to remove";
      setTimeout(() => { forget.classList.remove("danger"); forget.textContent = "Remove"; }, 3000);
    };
    const box = el("div");
    box.append(forget);
    tools.append(summary, box);
    card.append(machineRow(m), tools);
    if (m.error) card.append(el("p", "machine-error", m.error.message));
    list.append(card);
  }
}

/** Alerts on this device: one switch for all the owner's machines. */
const ownedHosts = () => machines.filter((m) => m.role === "owner" && m.status === "online").map((m) => m.host);
let alertsNote = "";
async function renderAlerts(note) {
  if (note !== undefined) alertsNote = note;
  const state = await push.state();
  const owned = machines.some((m) => m.role === "owner");
  $("alerts").hidden = !owned || (state === "unsupported" && !push.needsHomeScreen());
  $("alerts-toggle").hidden = state === "unsupported" || state === "blocked";
  $("alerts-toggle").textContent = state === "on" ? "Alerts on this device: on" : "Alert this device when a ghost finishes";
  $("alerts-toggle").dataset.state = state;
  $("alerts-note").textContent = alertsNote
    || (state === "blocked" ? "This browser is blocking alerts from summonghost.com. Allow notifications in its site settings."
      : state === "unsupported" ? "For alerts on an iPhone, add SummonGhost to the Home Screen and open it from there." : "");
}
$("alerts-toggle").onclick = async () => {
  const button = $("alerts-toggle");
  button.disabled = true;
  try {
    if (button.dataset.state === "on") {
      await push.disable(ownedHosts());
      await renderAlerts("Alerts are off for this device.");
    } else {
      const { taken, test } = await push.enable(ownedHosts());
      await renderAlerts(!taken.length ? "No machine took it. Update Ghost on your machines, then try again."
        : test?.delivered ? `On. ${shortName(taken[0])} just sent a test alert.`
        : `On, but the test alert from ${shortName(taken[0])} was not delivered${test?.reason ? ": " + test.reason : "."}`);
    }
  } catch (error) {
    await renderAlerts(error.message);
  } finally {
    button.disabled = false;
  }
};

$("add-toggle").onclick = () => {
  const form = $("add-form");
  form.hidden = !form.hidden && machines.length > 0;
  if (!form.hidden) $("add-host").focus();
};
$("add-form").onsubmit = (event) => {
  event.preventDefault();
  const typed = $("add-host").value;
  const host = normalizeHost(typed, machines[0] ? tailnetOf(machines[0].host) : "");
  if (!host) {
    $("add-error").textContent = typed.includes(".")
      ? "That isn't a Tailscale name. It ends in .ts.net, like laptop.tail1234.ts.net."
      : "Type the full name, like laptop.tail1234.ts.net. ghost status prints it.";
    return;
  }
  $("add-error").textContent = "";
  $("add-host").value = "";
  if (machines.length) $("add-form").hidden = true;
  refreshMachine(addMachine(host));
};

// ── Route ───────────────────────────────────────────────────────────────────

/** The machine whose chat is open; null on the machine list. */
let route = null;
/** A machine a link named that this browser does not list. */
let stray = null;

function applyRoute() {
  const asked = routeHost(location.hash);
  const next = machineOf(asked) ? asked : null;
  const changed = next !== route;
  route = next;
  document.body.dataset.view = route ? "chat" : "home";
  $("placeholder-text").textContent = machines.length ? "Pick a machine." : "Add a machine to begin.";
  // A link to a machine this browser does not list stays in the address bar, and says so.
  if (asked && !next) {
    stray = asked;
    $("add-form").hidden = false;
    $("add-host").value = normalizeHost(asked) || "";
    $("add-error").textContent = `${asked} isn't one of your machines here. Add it to open its chat.`;
  } else if (stray) {
    stray = null;
    $("add-form").hidden = machines.length > 0;
    $("add-host").value = "";
    $("add-error").textContent = "";
  }
  renderHome();
  if (!changed) return;
  openChat();
  // Back at the list: each chat's last word may have changed since it was drawn.
  if (!route) refreshAll();
}
window.addEventListener("hashchange", () => {
  const added = takeAddLink();
  applyRoute();
  if (added) refreshAll();
});

// ── A machine's chat ────────────────────────────────────────────────────────

const log = $("log"), prompt = $("prompt"), earlier = $("earlier"), typing = $("typing");
let events = null;
/** The transcript read so far: the messages from `offset` (counted from the oldest) to the newest. */
let page = { loaded: false, offset: 0, messages: [] };
/** The bubbles on screen, by key, so a redraw keeps an open fold and a scrolled output as they were. */
const nodes = new Map();
let readThrough = null, marking = false;
/**
 * The turn this page is streaming: `{ host, shown, messages, now, quiet }`.
 * `shown` while its bubbles are on screen; `messages` its events folded as the
 * transcript will hold them; `now` the call running, `{ text, since }`;
 * `quiet` while the ghost is writing its reply, when nothing need say it is busy.
 */
let turn = null;
let pending = [];

const owner = () => machineOf(route)?.role === "owner";
const conv = () => machineOf(route)?.conv;
/** The open machine's ghost, by name. */
const ghostName = () => machineOf(route)?.ghost || "ghost";
const turnHere = () => !!turn && turn.host === route;
/** This page's turn is here and its bubbles are on screen. */
const liveHere = () => turnHere() && turn.shown;
const runningHere = () => turnHere() || !!conv()?.running;
/** The reader is at the newest message, so the thread follows what arrives; scrolled up, it stays put. */
let following = true;
const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
const toBottom = () => { log.scrollTop = log.scrollHeight; };
// A fold opened at the bottom pushes the newest message down: the reader is where they chose to look.
log.addEventListener("toggle", () => { following = atBottom(); }, true);
// The ghost's question, the queue, a growing composer and a phone's keyboard take height from the thread;
// a scrollbar appearing only narrows it, and moves no one.
let height = log.clientHeight;
new ResizeObserver(() => {
  if (following && log.clientHeight !== height) toBottom();
  height = log.clientHeight;
}).observe(log);

function show(error) {
  $("status").textContent = error?.message || String(error || "");
}

function openChat() {
  events?.close();
  events = null;
  // A turn left behind runs on; back here, the transcript shows it.
  if (turn) turn.shown = false;
  page = { loaded: false, offset: 0, messages: [] };
  readThrough = null;
  unreadable = false;
  nodes.clear();
  following = true;
  log.replaceChildren(earlier, typing);
  earlier.hidden = true;
  show("");
  clearTray();
  $("chat-tools").open = false;
  $("question").hidden = true;
  $("queue").hidden = true;
  if (!route) {
    document.title = "SummonGhost";
    return;
  }
  applyRole();
  drawMeta();
  watch();
  // A machine still being asked who we are reads its conversation when it answers.
  if (machineOf(route).status !== "checking") loadConversation().catch(show);
}

/** Invalidations from the open machine: its one conversation changed, so it is read again. */
function watch() {
  const source = new EventSource(base(route) + "/api/events");
  let connected = false;
  source.onopen = () => {
    if (connected) loadConversation().catch(show);
    connected = true;
  };
  source.onmessage = () => loadConversation().catch(show);
  events = source;
}

/** What the caller may do here, once the machine has said who they are. */
function applyRole() {
  const m = machineOf(route);
  if (!m) return;
  $("composer").hidden = m.role !== "owner";
  $("readonly").hidden = m.role === "owner";
  $("readonly").textContent = m.role ? "" : "Checking who you are…";
}

let reading = null, readAgain = false, unreadable = false;
/**
 * Reads the open machine's conversation again, one read at a time: a change
 * during a read is read after it. A read that works takes back what a failed
 * one said, and no other message.
 */
function loadConversation() {
  if (reading) {
    readAgain = true;
    return reading;
  }
  reading = (async () => {
    try {
      do {
        readAgain = false;
        await readConversation();
      } while (readAgain);
    } catch (error) {
      unreadable = true;
      throw error;
    }
    if (unreadable) show("");
    unreadable = false;
  })().finally(() => { reading = null; });
  return reading;
}

/** The messages from `from` to the newest. Started over, or grown past one response, since `from` was chosen: the newest page. */
async function readTranscript(host, from) {
  const t = await api(host, "/conversation/transcript?limit=2000&offset=" + from);
  if (from + t.messages.length === t.total) return { ...t, offset: from };
  const offset = newestOffset(t.total);
  return { ...(await api(host, "/conversation/transcript?limit=2000&offset=" + offset)), offset };
}

async function readConversation() {
  const host = route, m = machineOf(host);
  if (!host) return;
  const c = await api(host, "/conversation");
  if (route !== host) return;
  m.conv = c;
  // The stream is drawing this page's turn; the transcript is read when it ends.
  if (!liveHere()) {
    const t = await readTranscript(host, page.loaded ? page.offset : newestOffset(c.messageCount));
    if (route !== host || liveHere()) return;
    page = { loaded: true, offset: t.offset, messages: t.messages };
    readThrough = t.readThrough || null;
    m.last = lastWords(thread(t.messages).at(-1));
    draw();
    markDisplayedRead().catch(show);
  }
  renderHome();
  drawMeta();
}

/** Reads the page before the oldest message shown, and keeps the reader where they were. */
let readingOlder = false;
async function loadOlder() {
  const host = route, older = olderPage(page.offset);
  if (!older || readingOlder || !page.loaded) return;
  readingOlder = true;
  try {
    const t = await api(host, `/conversation/transcript?limit=${older.limit}&offset=${older.offset}`);
    // A reload meanwhile already holds another range.
    if (route !== host || page.offset !== older.offset + older.limit || t.messages.length !== older.limit) return;
    page = { ...page, offset: older.offset, messages: t.messages.concat(page.messages) };
    const height = log.scrollHeight, top = log.scrollTop, focused = document.activeElement === earlier;
    draw();
    log.scrollTop = top + log.scrollHeight - height;
    // The keyboard reader's place is the first of the messages just read.
    if (focused) (earlier.hidden ? log.querySelector(".msg") : earlier)?.focus();
  } catch (error) {
    show(error);
  } finally {
    readingOlder = false;
  }
}
earlier.onclick = loadOlder;
log.addEventListener("scroll", () => {
  following = atBottom();
  if (log.scrollTop < 200 && !earlier.hidden) loadOlder();
}, { passive: true });

// ── The thread: bubbles, with a turn's working folded into them ─────────────

const attachmentUrl = (path) => base(route) + "/api/conversation/attachments/" + seg(path.slice("attachments/".length));

/** A visually hidden word for a screen reader: who is speaking. */
const who = (name) => el("span", "sr", name + ": ");

function fillOwner(node, item) {
  node.replaceChildren(who("You"));
  if (item.pics.length) {
    const pics = el("div", "pics");
    for (const path of item.pics) {
      const a = el("a");
      a.href = attachmentUrl(path);
      a.target = "_blank";
      a.rel = "noopener";
      const img = el("img");
      img.src = a.href;
      img.alt = "Attached photo";
      img.loading = "lazy";
      img.onload = () => { if (following) toBottom(); };
      img.onerror = () => a.replaceWith("Photo unavailable");
      a.append(img);
      pics.append(a);
    }
    node.append(pics);
  }
  if (item.text) node.append(el("div", "text", item.text));
}

function fillHook(node, item) {
  const note = el("details", "work");
  note.append(el("summary", "", "A stop hook had " + ghostName() + " go on"), el("div", "thinking", item.text));
  node.replaceChildren(note);
}

/** One part of a ghost's working, drawn into `node`: its reasoning, a handoff note, or a command with all it printed. */
function fillStep(node, step) {
  if (step.type !== "call") {
    node.className = "thinking";
    node.textContent = (step.type === "handoff" ? "Handoff note\n\n" : "") + step.text;
    return;
  }
  node.className = "tool" + (step.failed ? " failed-call" : "");
  if (!node.firstChild) node.append(el("pre", "tool-command"), el("pre", "tool-output"));
  const [command, output] = node.children;
  command.textContent = step.line;
  // Only new output touches the element, so a reader's place in a long one holds.
  if (output.textContent !== step.output) output.textContent = step.output;
  output.hidden = !step.output;
}

/** A ghost bubble: the working that led to its words, folded over them; nothing of a turn is left out. */
function fillGhost(node, item) {
  if (!node.firstChild) {
    node.work = el("details", "work");
    node.steps = el("div", "steps");
    node.work.append(el("summary"), node.steps);
    node.said = el("div", "said");
    node.failed = el("div", "failed");
    node.append(who(ghostName()), node.work, node.said, node.failed);
  }
  node.classList.toggle("bare", !item.text && !item.error);
  node.work.hidden = !item.steps.length;
  node.work.firstChild.textContent = worked(item.steps);
  item.steps.forEach((step, i) => {
    if (!node.steps.children[i]) node.steps.append(el("div"));
    fillStep(node.steps.children[i], step);
  });
  while (node.steps.children.length > item.steps.length) node.steps.lastChild.remove();
  if (node.text !== item.text) {
    node.text = item.text;
    node.said.replaceChildren(renderMarkdown(item.text, document));
  }
  node.said.hidden = !item.text;
  node.failed.textContent = item.error ? "Failed: " + item.error.slice(0, 600) : "";
}

const fill = { owner: fillOwner, hook: fillHook, ghost: fillGhost };

/**
 * Draws the thread: the transcript read so far, then this page's running
 * turn. It follows the newest message only for a reader already at the bottom.
 */
function draw() {
  // Where the reader is now, not only where the last scroll event left them.
  const stick = following && atBottom();
  const live = liveHere() ? thread(turn.messages) : [];
  const items = thread(page.messages).concat(live);
  // A turn that just ended comes back from the transcript under its own keys: what was open in it stays open.
  const ended = live.length ? [] : [...nodes].filter(([key]) => key.startsWith("live")).map(([, node]) => !!node.work?.open);
  let at = earlier;
  const kept = new Set();
  for (const item of items) {
    let node = nodes.get(item.key);
    const drawn = JSON.stringify(item);
    if (!node) {
      node = el("div", "msg " + item.kind);
      node.tabIndex = -1;
      nodes.set(item.key, node);
    }
    if (node.drawn !== drawn) fill[item.kind](node, item);
    node.drawn = drawn;
    if (at.nextSibling !== node) at.after(node);
    at = node;
    kept.add(item.key);
  }
  for (const [key, node] of nodes) {
    if (kept.has(key)) continue;
    node.remove();
    nodes.delete(key);
  }
  const shown = log.querySelectorAll(".msg");
  ended.forEach((open, i) => {
    const work = shown[shown.length - ended.length + i]?.work;
    if (open && work) work.open = true;
  });
  earlier.hidden = page.offset === 0;
  log.querySelector(".empty")?.remove();
  if (!items.length && page.loaded) {
    const empty = $("empty-log").content.firstElementChild.cloneNode(true);
    empty.querySelector("span").textContent = owner() ? "Say something to " + ghostName() + "." : "Nothing here yet.";
    typing.before(empty);
  }
  drawTyping();
  if (stick) toBottom();
}

/** The ghost at work, as a messaging app shows someone typing: the command running now and for how long. */
let clock = 0;
function drawTyping() {
  clearInterval(clock);
  const mine = liveHere() ? turn : null;
  typing.hidden = mine ? mine.quiet : !conv()?.running;
  if (typing.hidden) return;
  const text = mine?.now?.text || "", what = $("typing-what");
  // Said once per change: a status that is rewritten is announced again.
  if (what.textContent !== (text || ghostName() + " is working")) what.textContent = text || ghostName() + " is working";
  what.classList.toggle("sr", !text);
  const tick = () => {
    const s = mine?.now ? Math.floor((Date.now() - mine.now.since) / 1000) : 0;
    $("typing-for").textContent = s < 1 ? "" : s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
  };
  tick();
  if (mine?.now) clock = setInterval(tick, 1000);
}

/** The header, the ghost's open question, and what the composer offers. */
function drawMeta() {
  const m = machineOf(route);
  if (!m) return;
  const c = m.conv;
  $("chat-title").textContent = ghostName();
  $("chat-sub").textContent = label(route) + (m.status === "offline" ? " · offline" : "");
  document.title = ghostName() + " · SummonGhost";
  $("chat-tools").hidden = !owner() || !c?.messageCount;
  const question = owner() && !turnHere() ? c?.question : null;
  $("question").hidden = !question;
  if (question) {
    // The ghost's reply says its question; the panel does not repeat the last bubble.
    $("question-text").textContent = question.text;
    $("question-text").hidden = !!thread(page.messages).at(-1)?.text?.includes(question.text);
    const options = $("question-options");
    options.replaceChildren();
    for (const option of question.options || []) {
      // The ghost lists the answer it recommends first.
      const button = el("button", options.childElementCount ? "" : "recommended", option);
      button.type = "button";
      button.onclick = () => { prompt.value = option; grow(); submit().catch(show); };
      options.append(button);
    }
  }
  prompt.placeholder = question ? "Answer " + ghostName() : runningHere() ? "Add to this turn" : "Message";
  if (!turnHere()) {
    if (c?.running) readQueue().catch(() => {});
    else $("queue").hidden = true;
  }
  drawTyping();
  refresh();
}

/** The owner's reply is read once shown while the page is visible and focused (Ghost's read contract). */
async function markDisplayedRead() {
  const host = route, m = machineOf(host);
  if (!owner() || !m.conv?.unread || !readThrough || marking || document.visibilityState !== "visible" || !document.hasFocus()) return;
  marking = true;
  try {
    await api(host, "/conversation/read", { method: "PUT", body: { readThrough } });
    if (m.conv) m.conv.unread = false;
    renderHome();
  } finally {
    marking = false;
  }
}

function onReturn() {
  if (document.visibilityState !== "visible") return;
  if (route) loadConversation().catch(show);
  else refreshAll();
}
window.addEventListener("focus", onReturn);
document.addEventListener("visibilitychange", onReturn);

// A menu closes when the owner goes elsewhere.
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details.tools[open]")) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll("details.tools[open]")) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});

// ── Starting over ───────────────────────────────────────────────────────────

const restart = $("restart");
$("chat-restart").onclick = () => {
  $("chat-tools").open = false;
  $("restart-title").textContent = "Start over with " + ghostName() + "?";
  $("restart-text").textContent = `This conversation moves to the Trash on ${label(route)}, where it can be restored. Your next message starts a new one.`;
  restart.showModal();
};
$("restart-cancel").onclick = () => restart.close();
$("restart-confirm").onclick = async () => {
  restart.close();
  const host = route;
  try {
    await api(host, "/conversation", { method: "DELETE" });
    if (route !== host) return;
    page = { loaded: false, offset: 0, messages: [] };
    await loadConversation();
  } catch (error) { show(error); }
};

// ── Photos: shrunk here, stored in the conversation when sent, named in the message ──

async function shrink(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 2e6) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", 0.85));
}

function attach(file) {
  const item = { file, url: URL.createObjectURL(file), el: el("div", "thumb") };
  const img = el("img");
  img.src = item.url;
  img.alt = "";
  const remove = el("button", "", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove photo");
  remove.onclick = () => drop(item);
  item.el.append(img, remove);
  $("tray").append(item.el);
  pending.push(item);
  refresh();
}
function drop(item) {
  pending = pending.filter((p) => p !== item);
  item.el.remove();
  URL.revokeObjectURL(item.url);
  refresh();
}
function clearTray() { for (const item of [...pending]) drop(item); }

/** The composer's one round button: send, or stop while a turn runs and nothing is typed. */
function refresh() {
  const typed = !!prompt.value.trim() || pending.length > 0;
  const stop = runningHere() && !typed;
  const send = $("send");
  send.classList.toggle("stop", stop);
  send.setAttribute("aria-label", stop ? "Stop" : runningHere() ? "Add to this turn" : "Send");
  send.title = send.getAttribute("aria-label");
  $("send-icon").setAttribute("href", stop ? "#i-stop" : "#i-send");
  send.disabled = !stop && (!typed || sending);
}
function grow() {
  prompt.style.height = "auto";
  prompt.style.height = prompt.scrollHeight + "px";
  refresh();
}

/** The composer's text and photos as one message; photos are uploaded now. */
async function compose(host) {
  const text = prompt.value.trim();
  const paths = await Promise.all(pending.map(async (p) => {
    const blob = await shrink(p.file);
    return (await api(host, "/conversation/attachments", { method: "POST", body: blob })).path;
  }));
  return [text, ...paths.map((path) => "![image](" + path + ")")].filter(Boolean).join("\n\n");
}

// ── Sending, queueing, stopping ─────────────────────────────────────────────

let sending = false;

async function submit() {
  if (sending || !route || !owner()) return;
  const typed = !!prompt.value.trim() || pending.length > 0;
  if (!typed) {
    if (runningHere()) await stop();
    return;
  }
  sending = true;
  show("");
  refresh();
  try {
    if (runningHere() && (await queue())) return;
    try {
      await send();
    } catch (error) {
      // A turn another device started: this joins it as its next pass.
      if (error.code !== "conversation_busy" || !(await queue())) throw error;
    }
  } finally {
    sending = false;
    refresh();
  }
}

/** Adds the composer to the running turn as its next pass; false when the turn has already ended. */
async function queue() {
  const host = route;
  const message = await compose(host);
  try {
    await api(host, "/conversation/queue", { method: "POST", body: { text: message } });
  } catch (error) {
    if (error.code === "conversation_not_streaming") return false;
    throw error;
  }
  prompt.value = "";
  grow();
  clearTray();
  if (!turnHere()) await readQueue();
  return true;
}

function showQueue(followUp) {
  const box = $("queue");
  box.replaceChildren(...followUp.map((text) => el("span", "", text.split("\n")[0])));
  box.hidden = !followUp.length;
}
async function readQueue() {
  const host = route;
  const { followUp } = await api(host, "/conversation/queue");
  if (route === host) showQueue(followUp || []);
  return followUp || [];
}

/** Stops the running turn; what was queued and never ran comes back to the composer. */
async function stop() {
  const host = route;
  const left = await readQueue().catch(() => []);
  try {
    await api(host, "/conversation/stop", { method: "POST", body: {} });
  } catch (error) {
    if (error.code !== "conversation_not_streaming") throw error;
  }
  if (left.length && !prompt.value.trim()) {
    prompt.value = left.join("\n\n");
    grow();
  }
  showQueue([]);
}

async function send() {
  const host = route;
  const message = await compose(host);
  const mine = { host, shown: route === host, messages: [], now: null, quiet: false };
  fold(mine.messages, { type: "owner_message", text: message });
  // The turn is this page's before the machine hears of it: a transcript read crossing the request would show the message twice.
  turn = mine;
  if (mine.shown) {
    following = true;
    toBottom();
    draw();
  }
  let response;
  try {
    response = await request(host, "/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: message }),
    });
  } catch (error) {
    turn = null;
    if (route === host) draw();
    throw error;
  }
  sending = false; // The turn is under way: the composer now queues and stops.
  prompt.value = "";
  grow();
  clearTray();
  if (mine.shown) drawMeta();
  try {
    for await (const ev of turnEvents(response, (path) => request(host, path))) {
      const notice = fold(mine.messages, ev);
      if (notice) mine.now = { text: notice, since: Date.now() };
      else if (ev.type === "tool_execution_start") mine.now = { text: toolCall(ev.toolName, ev.arguments), since: Date.now() };
      else if (ev.type === "tool_execution_end" || ev.type === "pass") mine.now = null;
      // Words mean the ghost is answering, and a stop hook runs once the reply is complete: neither needs a busy line.
      if (ev.type === "text_start" || ev.type === "text_delta" || (ev.type === "hook_start" && ev.event === "session_stop")) mine.quiet = true;
      else if (["pass", "thinking", "tool_execution_start", "owner_message"].includes(ev.type)) mine.quiet = false;
      if (!mine.shown) continue; // Drained off screen: the transcript shows it when read again.
      if (ev.type === "queue") showQueue(ev.followUp || []);
      else draw();
    }
  } finally {
    turn = null;
    if (route === host) {
      showQueue([]);
      refresh();
    }
  }
  if (route === host) await loadConversation();
  else await readSummary(machineOf(host)).then(renderHome, () => {});
}

prompt.oninput = grow;
prompt.onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) {
    event.preventDefault();
    submit().catch(show);
  }
};
$("composer").onsubmit = (event) => { event.preventDefault(); submit().catch(show); };
$("camera").onclick = () => $("file").click();
$("file").onchange = () => { for (const f of $("file").files) attach(f); $("file").value = ""; };

// ── Start ───────────────────────────────────────────────────────────────────

/** `#add=<host>`, the link `ghost status` prints: add it, then open it. */
function takeAddLink() {
  const match = /^#add=(.+)$/.exec(location.hash);
  if (!match) return false;
  let typed = match[1];
  try { typed = decodeURIComponent(typed); } catch {}
  const host = normalizeHost(typed);
  if (!host) {
    history.replaceState(null, "", "/");
    $("add-form").hidden = false;
    $("add-error").textContent = `"${typed}" isn't a Tailscale machine name.`;
    return true;
  }
  addMachine(host);
  history.replaceState(null, "", "/#/");
  return host;
}

takeAddLink();
persist();
applyRoute();
refreshAll();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
