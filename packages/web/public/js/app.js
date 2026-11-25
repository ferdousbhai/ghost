/**
 * SummonGhost: every machine the owner has added, each with its one ghost and
 * that ghost's conversations, talked to straight over Tailscale. The route
 * lives in the hash, `#/<host>/<conversation>`, so the back button walks out.
 * The conversation itself behaves as Ghost's own remote viewer does.
 */
import { renderMarkdown } from "./markdown.js";
import { api, base, label, MachineError, normalizeHost, request, seg, shortName, tailnetOf } from "./net.js";
import * as push from "./push.js";
import { load, save } from "./store.js";
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
const mint = () => "app-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
const link = (host, session) =>
  "#/" + [host, session].filter(Boolean).map(seg).join("/");

// ── Machines ────────────────────────────────────────────────────────────────

const saved = load();
/** Each: `{ host, role, ghost, seen }` as saved (`ghost` is its ghost's name), plus `status`, `error`, `unread` for this visit. */
const machines = saved.machines.map((m) => ({ ...m, status: "unknown", error: null, unread: 0 }));
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
    m = { host, role: null, ghost: null, seen: 0, status: "unknown", error: null, unread: 0, ...fields };
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
  if (route.host === host) location.hash = "#/";
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
      if (who.role === "peer") throw new MachineError("not-owner", `${shortName(m.host)} only answers its owner. This device is signed in to Tailscale as someone else.`);
      m.role = who.role;
      m.ghost = (await api(m.host, "/ghost")).name;
      m.seen = Date.now();
      m.status = "online";
      m.error = null;
      persist();
      try {
        const { sessions } = await api(m.host, "/sessions");
        m.unread = sessions.filter((s) => s.unread).length;
      } catch {}
      if (m.role === "owner") discover(m).catch(() => {});
      // A machine reached as owner hears of this device, when alerts are on here.
      if (m.role === "owner") push.sync(m.host).catch(() => {});
    } catch (error) {
      m.status = error.kind === "unreachable" ? "offline" : "error";
      m.error = error;
    } finally {
      refreshing.delete(m.host);
      renderHome();
      if (m.host === route.host) {
        applyRole();
        if (m.status === "online") loadSessions().catch(show);
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

// ── Home ────────────────────────────────────────────────────────────────────

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

function renderHome() {
  renderBanner();
  const empty = !machines.length;
  $("first-run").hidden = !empty;
  if (empty) $("add-form").hidden = false;
  renderAlerts().catch(() => {});
  const list = $("machines");
  list.replaceChildren();
  for (const m of machines) {
    const card = el("article", "machine");
    const head = el("div", "machine-head");
    const dot = el("span", "dot " + (m.status === "unknown" ? "" : m.status));
    const name = el("span", "machine-name", label(m.host));
    name.title = m.host;
    const state = el("span", "state", {
      online: m.role === "guest" ? "guest" : "",
      checking: "checking…",
      offline: "offline · " + ago(m.seen),
      error: m.error?.kind === "outdated" ? "update Ghost" : m.error?.kind === "not-owner" ? "not yours" : "error",
      unknown: "",
    }[m.status]);
    const forget = el("button", "forget", "Remove");
    forget.type = "button";
    forget.onclick = () => {
      if (forget.classList.contains("armed")) return forgetMachine(m.host);
      forget.classList.add("armed");
      forget.textContent = "Tap to remove";
      setTimeout(() => { forget.classList.remove("armed"); forget.textContent = "Remove"; }, 3000);
    };
    head.append(svg("machine"), name, state, dot, forget);
    card.append(head);
    if (m.error) card.append(el("p", "machine-error", m.error.message));
    if (m.ghost) {
      const row = el("a", "ghost-row" + (m.status === "online" ? "" : " stale"));
      row.href = link(m.host);
      if (route.host === m.host) row.setAttribute("aria-current", "page");
      row.append(svg("ghost", "glyph"), el("span", "", m.ghost));
      if (m.unread) row.append(el("span", "badge", String(m.unread)));
      card.append(row);
    }
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
      : "Type the full name, like laptop.tail1234.ts.net. ghost remote status prints it.";
    return;
  }
  $("add-error").textContent = "";
  $("add-host").value = "";
  if (machines.length) $("add-form").hidden = true;
  refreshMachine(addMachine(host));
};

// ── Route ───────────────────────────────────────────────────────────────────

let route = { host: null, session: null };

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return ""; }
  });
  const [host = null, session = null] = parts;
  return machineOf(host) ? { host, session } : { host: null, session: null };
}

async function applyRoute() {
  const next = parseRoute();
  const ghostChanged = next.host !== route.host;
  const sessionChanged = ghostChanged || next.session !== route.session;
  route = next;
  document.body.dataset.view = route.session ? "chat" : route.host ? "ghost" : "home";
  $("placeholder-text").textContent = route.host ? "Pick a conversation, or start one." : machines.length ? "Pick a machine." : "Add a machine to begin.";
  renderHome();
  if (ghostChanged) openGhost();
  if (sessionChanged) openChat();
  else renderSessions();
}
window.addEventListener("hashchange", () => {
  const added = takeAddLink();
  applyRoute().catch(show);
  if (added) refreshAll();
});

// ── A ghost's conversations ─────────────────────────────────────────────────

let sessions = [];
let sessionsFor = "";
let events = null;

const owner = () => machineOf(route.host)?.role === "owner";
/** The open machine's ghost, by name. */
const ghostName = () => machineOf(route.host)?.ghost || "ghost";
const conversationPath = (session) => "/sessions/" + seg(session);
const rowOf = (id) => sessions.find((s) => s.id === id);

function openGhost() {
  events?.close();
  events = null;
  sessions = [];
  sessionsFor = "";
  $("sessions").replaceChildren();
  $("ghost-note").textContent = "";
  if (!route.host) return;
  $("ghost-name").textContent = ghostName();
  applyRole();
  watch();
  loadSessions().catch(show);
}

/** Invalidations from this machine; each names a conversation, and only that one's transcript is read again. */
function watch() {
  const { host } = route;
  const source = new EventSource(base(host) + "/api/events");
  let connected = false;
  source.onopen = () => {
    if (connected) loadSessions().catch(show);
    connected = true;
  };
  source.onmessage = (event) => {
    let id;
    try { id = JSON.parse(event.data).id; } catch {}
    loadSessions(id).catch(show);
  };
  events = source;
}

/** `changed`: the conversation an event named; undefined reads the open one again too. */
async function loadSessions(changed) {
  const { host } = route;
  if (!host) return;
  let rows;
  try {
    rows = (await api(host, "/sessions")).sessions;
  } catch (error) {
    if (route.host === host) $("ghost-note").textContent = error.message;
    throw error;
  }
  if (route.host !== host) return;
  $("ghost-note").textContent = "";
  sessions = rows;
  sessionsFor = host;
  const m = machineOf(host);
  m.unread = rows.filter((s) => s.unread).length;
  $("ghost-name").textContent = ghostName();
  renderHome();
  renderSessions();
  if (route.session) {
    renderChatMeta();
    if (changed === undefined || changed === route.session) {
      if (!liveHere()) await loadTranscript(changed !== undefined);
    }
  }
}

function renderSessions() {
  const nav = $("sessions");
  nav.replaceChildren();
  if (!route.host || sessionsFor !== route.host) return;
  const list = draft && !rowOf(draft) ? [{ id: draft, title: "New conversation" }, ...sessions] : sessions;
  if (!list.length) nav.append(el("p", "note", owner() ? "No conversations yet. Start one with +." : "No conversations yet."));
  const item = (s) => {
    const a = el("a", "session" + (s.unread ? " unread" : ""));
    a.href = link(route.host, s.id);
    if (s.id === route.session) a.setAttribute("aria-current", "page");
    if (s.pinned) a.append(svg("pin"));
    a.append(el("span", "label", s.title || s.preview || s.id));
    if (s.question) a.append(el("span", "tag", "asks"));
    if (s.running) a.append(el("span", "tag", "working"));
    if (s.unread) a.append(el("span", "unread-dot"));
    return a;
  };
  // As the HUD folds them: what intake started, unless the owner must see it, under one group.
  const folds = (s) => s.id.startsWith("event-") && !s.pinned && !s.question;
  for (const s of list.filter((s) => !folds(s))) nav.append(item(s));
  const folded = list.filter(folds);
  if (folded.length) {
    nav.append(el("h3", "", "Events"));
    for (const s of folded) nav.append(item(s));
  }
}

function newConversation() {
  if (!route.host || !owner()) return;
  draft = mint();
  location.hash = link(route.host, draft);
}
$("ghost-new").onclick = newConversation;
$("new").onclick = () => { if (!turnHere()) newConversation(); };

// ── The conversation ────────────────────────────────────────────────────────

const log = $("log"), prompt = $("prompt");
let draft = null;
let readThrough = null, reading = false;
/** The turn this page is streaming: `{ host, session, live }`; `live` while its bubbles are on screen. */
let turn = null;
let pending = [];

const turnHere = () => !!turn && turn.host === route.host && turn.session === route.session;
/** This page's turn is here and its bubbles are on screen. */
const liveHere = () => turnHere() && turn.live;
const runningHere = () => turnHere() || !!rowOf(route.session)?.running;
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
const follow = (stick) => { if (stick) log.scrollTop = log.scrollHeight; };

function show(error) {
  $("status").textContent = error?.message || String(error || "");
}

function openChat() {
  if (turn && !turnHere()) turn.live = false;
  readThrough = null;
  show("");
  clearTray();
  $("chat-tools").open = false;
  $("question").hidden = true;
  $("queue").hidden = true;
  if (!route.session) return;
  if (route.session !== draft && draft && !rowOf(draft)) draft = null;
  $("chat-back").href = link(route.host);
  applyRole();
  renderChatMeta();
  if (liveHere()) return; // Its bubbles are being drawn by the stream.
  log.replaceChildren();
  loadTranscript().catch(show);
}

/** What the caller may do here, once the machine has said who they are. */
function applyRole() {
  const m = machineOf(route.host);
  if (!m) return;
  $("ghost-machine").textContent = label(route.host) + (m.role === "guest" ? " · guest" : "");
  $("ghost-new").hidden = m.role !== "owner";
  $("composer").hidden = m.role !== "owner";
  $("readonly").hidden = m.role === "owner";
  $("readonly").textContent = m.role === "guest" ? `Read-only: you're a guest on ${shortName(route.host)}.` : m.role ? "" : "Checking who you are…";
}

function renderChatMeta() {
  if (!route.session) return;
  const row = rowOf(route.session);
  $("chat-title").textContent = row ? row.title || row.preview || "Conversation" : "New conversation";
  $("chat-sub").textContent = ghostName() + " · " + label(route.host);
  document.title = (row?.title || ghostName()) + " · SummonGhost";
  $("chat-tools").hidden = !owner() || !row;
  $("chat-pin").textContent = row?.pinned ? "Unpin" : "Pin";
  const question = owner() && !turnHere() ? row?.question : null;
  $("question").hidden = !question;
  if (question) {
    // The ask tool says its question in the reply; the panel does not repeat the last bubble.
    $("question-text").textContent = question.text;
    $("question-text").hidden = !!log.lastElementChild?.textContent.includes(question.text);
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
    const working = log.querySelector(".activity.elsewhere");
    if (row?.running && !working) {
      const line = el("div", "activity elsewhere", "Working…");
      log.append(line);
    } else if (!row?.running) working?.remove();
    if (row?.running) readQueue().catch(() => {});
    else $("queue").hidden = true;
  }
  refresh();
}

function emptyLog() {
  const node = $("empty-log").content.firstElementChild.cloneNode(true);
  node.querySelector("span").textContent = owner() ? "Say something to " + ghostName() + "." : "Nothing here yet.";
  log.replaceChildren(node);
}

const attachmentUrl = (path) =>
  base(route.host) + "/api" + conversationPath(route.session) + "/attachments/" + seg(path.slice("attachments/".length));

/** An attachment line, `![image](attachments/<file>)`, gives its path; any other line gives null. */
function attachmentOf(line) {
  const t = line.trim(), at = t.indexOf("](attachments/");
  return t.startsWith("![") && t.endsWith(")") && at > 0 && !t.slice(at + 2, -1).includes(" ") ? t.slice(at + 2, -1) : null;
}

function userBubble(value) {
  const bubble = el("div", "msg user");
  const lines = value.split("\n"), paths = lines.map(attachmentOf).filter(Boolean);
  if (paths.length) {
    const pics = el("div", "pics");
    for (const path of paths) {
      const a = el("a");
      a.href = attachmentUrl(path);
      a.target = "_blank";
      a.rel = "noopener";
      const img = el("img");
      img.src = a.href;
      img.alt = "Attached photo";
      img.loading = "lazy";
      img.onerror = () => a.replaceWith("Photo unavailable");
      a.append(img);
      pics.append(a);
    }
    bubble.append(pics);
  }
  const rest = lines.filter((l) => !attachmentOf(l)).join("\n").trim();
  if (rest) bubble.append(el("div", "text", rest));
  return bubble;
}
function assistantBubble(value) {
  const bubble = el("div", "msg assistant");
  bubble.replaceChildren(renderMarkdown(value, document));
  return bubble;
}
// A peer's words are another person's text: shown as written, never rendered.
const peerBubble = (value) => el("div", "msg assistant", value);

/** A message's texts as the bubbles they show as: text after a tool call is the next message (the HUD's TurnBlocks rule). */
function bubbles(parts) {
  const out = [];
  let tooled = true;
  for (const p of parts) {
    if (p.type === "toolCall") tooled = true;
    else if (p.text?.trim()) {
      if (tooled) out.push(p.text);
      else out[out.length - 1] += "\n\n" + p.text;
      tooled = false;
    }
  }
  return out;
}

// `keep`: a refresh of the same conversation holds the reader's place unless they were at the newest message.
function render(messages, keep = false) {
  const stick = !keep || nearBottom(), top = log.scrollTop;
  log.replaceChildren();
  for (const m of messages) {
    const texts = bubbles(m.content || []);
    if (m.role === "user" && texts.length) log.append(userBubble(texts.join("\n\n")));
    else if (m.role === "assistant") {
      for (const text of texts) log.append(assistantBubble(text));
      if (m.errorMessage) log.append(el("div", "failed", "Failed: " + m.errorMessage.slice(0, 600)));
    } else if (m.role === "peer") for (const text of texts) log.append(peerBubble(text));
  }
  if (!log.childElementCount) emptyLog();
  if (rowOf(route.session)?.running) log.append(el("div", "activity elsewhere", "Working…"));
  log.scrollTop = stick ? log.scrollHeight : top;
  // The question panel leaves out a question the last bubble already says.
  renderChatMeta();
}

async function loadTranscript(keep = false) {
  const { host, session } = route;
  if (!session || !rowOf(session)) {
    if (sessionsFor === host || session === draft) return render([]);
    return; // The list is still loading; it reads the transcript when it lands.
  }
  const path = conversationPath(session) + "/transcript";
  let t = await api(host, path);
  // A phone shows the newest page; a long conversation's first page is its oldest.
  if (t.truncated) t = await api(host, path + "?offset=" + (t.total - t.messages.length));
  if (route.host !== host || route.session !== session || liveHere()) return;
  render(t.messages, keep);
  readThrough = t.readThrough || null;
  await markDisplayedRead();
}

/** The owner's reply is read once shown while the page is visible and focused (Ghost's read contract). */
async function markDisplayedRead() {
  const { host, session } = route;
  const row = rowOf(session);
  if (!owner() || !row?.unread || !readThrough || reading || document.visibilityState !== "visible" || !document.hasFocus()) return;
  reading = true;
  try {
    await api(host, conversationPath(session) + "/read", { method: "PUT", body: { readThrough } });
    if (route.session === session && rowOf(session)) {
      rowOf(session).unread = false;
      const m = machineOf(host);
      m.unread = sessions.filter((s) => s.unread).length;
      renderSessions();
      renderHome();
    }
  } finally {
    reading = false;
  }
}

function onReturn() {
  if (document.visibilityState !== "visible") return;
  if (route.host) loadSessions().catch(show);
  else refreshAll();
}
window.addEventListener("focus", onReturn);
document.addEventListener("visibilitychange", onReturn);

// ── Pin and delete ──────────────────────────────────────────────────────────

$("chat-pin").onclick = async () => {
  const row = rowOf(route.session);
  $("chat-tools").open = false;
  if (!row) return;
  try {
    await api(route.host, conversationPath(route.session) + "/pin", { method: "PUT", body: { pinned: !row.pinned } });
    await loadSessions(null);
  } catch (error) { show(error); }
};
$("chat-delete").onclick = async () => {
  const button = $("chat-delete");
  if (!button.classList.contains("danger")) {
    button.classList.add("danger");
    button.textContent = "Tap again to delete";
    setTimeout(() => { button.classList.remove("danger"); button.textContent = "Delete"; }, 3000);
    return;
  }
  button.classList.remove("danger");
  button.textContent = "Delete";
  $("chat-tools").open = false;
  const { host, session } = route;
  try {
    await api(host, conversationPath(session), { method: "DELETE" });
    location.hash = link(host);
    await loadSessions(null);
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
async function compose(host, session) {
  const text = prompt.value.trim();
  const paths = await Promise.all(pending.map(async (p) => {
    const blob = await shrink(p.file);
    return (await api(host, conversationPath(session) + "/attachments", { method: "POST", body: blob })).path;
  }));
  return [text, ...paths.map((path) => "![image](" + path + ")")].filter(Boolean).join("\n\n");
}

// ── Sending, queueing, stopping ─────────────────────────────────────────────

let sending = false;

async function submit() {
  if (sending || !route.session || !owner()) return;
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
      if (error.code !== "session_busy" || !(await queue())) throw error;
    }
  } finally {
    sending = false;
    refresh();
  }
}

/** Adds the composer to the running turn as its next pass; false when the turn has already ended. */
async function queue() {
  const { host, session } = route;
  const message = await compose(host, session);
  try {
    await api(host, conversationPath(session) + "/queue", { method: "POST", body: { text: message } });
  } catch (error) {
    if (error.code === "session_not_streaming") return false;
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
  const { host, session } = route;
  const { followUp } = await api(host, conversationPath(session) + "/queue");
  if (route.session === session) showQueue(followUp || []);
  return followUp || [];
}

/** Stops the running turn; what was queued and never ran comes back to the composer, as the HUD does. */
async function stop() {
  const { host, session } = route;
  const left = await readQueue().catch(() => []);
  try {
    await api(host, conversationPath(session) + "/stop", { method: "POST", body: {} });
  } catch (error) {
    if (error.code !== "session_not_streaming") throw error;
  }
  if (left.length && !prompt.value.trim()) {
    prompt.value = left.join("\n\n");
    grow();
  }
  showQueue([]);
}

/** A turn's events, across the responses a long turn is cut into. */
async function* turnEvents(host, response, conversation) {
  while (response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", resume = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "resume") resume = ev;
        else yield ev;
      }
    }
    response = resume && (await request(host, conversation + "/stream?turn=" + seg(resume.turn) + "&from=" + resume.from));
  }
}

async function send() {
  const { host, session } = route;
  const conversation = conversationPath(session);
  const message = await compose(host, session);
  const response = await request(host, "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: message, sessionId: session }),
  });
  turn = { host, session, live: true };
  sending = false; // The turn is under way: the composer now queues and stops.
  prompt.value = "";
  grow();
  clearTray();
  $("question").hidden = true;
  log.querySelector(".empty")?.remove();
  log.querySelector(".activity.elsewhere")?.remove();
  log.append(userBubble(message));
  // A reply bubble waiting for its text; text after a tool call opens the next.
  const replyBubble = () => { const b = assistantBubble(""); b.classList.add("pending"); if (turn.live) log.append(b); return b; };
  const replies = [replyBubble()];
  // Only the call running now, the way the HUD's activity line shows it.
  const activity = el("div", "activity");
  let call = "", callStarted = 0, clock = 0;
  const tick = () => {
    const s = Math.floor((Date.now() - callStarted) / 1000);
    activity.textContent = call + (s < 1 ? "" : " · " + (s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"));
  };
  follow(true);
  refresh();
  const parts = [];
  let renderedTexts = 0;
  const nextReply = () => {
    replies.at(-1).classList.remove("pending");
    replies.push(replyBubble());
    parts.length = 0;
    renderedTexts = 0;
  };
  try {
    for await (const ev of turnEvents(host, response, conversation)) {
      if (!turn.live) continue; // Drained off screen: the transcript shows it when read again.
      const stick = nearBottom();
      if (ev.type === "pass" && parts.length) nextReply();
      else if (ev.type === "owner_message") {
        activity.remove();
        if (replies.at(-1).textContent === "") replies.pop().remove();
        log.append(userBubble(ev.text));
        replies.push(replyBubble());
        parts.length = 0;
        renderedTexts = 0;
      } else if (ev.type === "queue") showQueue(ev.followUp || []);
      else if (ev.type === "text_start") parts.push({ type: "text", text: "" });
      else if (ev.type === "text_delta") {
        if (!parts.length) parts.push({ type: "text", text: "" });
        parts.at(-1).text += ev.delta;
        const texts = bubbles(parts);
        if (texts.length) activity.remove(); // Words mean the call before them is over.
        if (texts.length > renderedTexts && renderedTexts > 0) {
          replies.at(-1).classList.remove("pending");
          replies.push(replyBubble());
        }
        renderedTexts = texts.length;
        if (texts.length) replies.at(-1).replaceChildren(renderMarkdown(texts.at(-1), document));
      } else if (ev.type === "tool_execution_start") {
        parts.push({ type: "toolCall" });
        call = toolCall(ev.toolName, ev.arguments, ev.cwd);
        callStarted = Date.now();
        tick();
        clearInterval(clock);
        clock = setInterval(tick, 1000);
        replies.at(-1).after(activity);
      } else if (ev.type === "tool_execution_end") {
        clearInterval(clock);
        // A failed call stays named, with its error, until the next words or call.
        if (ev.isError) activity.textContent = call + " failed" + (ev.summary ? ": " + ev.summary.replace(/\s+/g, " ").trim().slice(0, 600) : "");
      }
      // A stop hook runs once the reply is complete; only a continuation shows.
      else if (ev.type === "hook_start" && ev.event === "session_stop") replies.at(-1).classList.remove("pending");
      else if (ev.type === "error" && ev.reason !== "aborted") show(new Error(ev.errorMessage || ev.reason));
      follow(stick);
    }
  } finally {
    replies.at(-1).classList.remove("pending");
    for (const b of replies) if (!b.childNodes.length) b.remove();
    clearInterval(clock);
    activity.remove();
    showQueue([]);
    turn = null;
    refresh();
  }
  if (route.host === host) await loadSessions(session === route.session ? undefined : null);
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

/** `#add=<host>`, from `ghost remote status`: add it, then open it. */
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
applyRoute().catch(show);
refreshAll();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
