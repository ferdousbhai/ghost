/**
 * The page a phone or another laptop opens over the tailnet: one HTML file,
 * no framework, served by the daemon at `/`. It talks to the
 * same API the shell uses; `tailscale serve` supplies the caller's identity,
 * so the page carries no token. Guests see a read-only view; the owner can
 * type (the phone keyboard's mic dictates) and attach photos. It wears the
 * HUD's colours — Tokyo Night under the ghost's amber — in a messaging app's
 * shape.
 */
import { createHash } from "node:crypto";
import { renderMarkdown } from "./remote-markdown.js";

const icon = (paths: string, cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const GLYPH = icon(`<path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8zM9 10h.01M15 10h.01"/>`, "glyph");
const PLUS = icon(`<path d="M5 12h14M12 5v14"/>`);
const CAMERA = icon(`<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>`);
const SEND = icon(`<path d="m3 3 3 9-3 9 19-9z"/><path d="M6 12h16"/>`);

export const REMOTE_VIEWER_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#16161e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest">
<title>ghost</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #1a1b26; --deep: #16161e; --surface: #24283b; --line: #292e42;
    --fg: #c0caf5; --dim: #a9b1d6; --faint: #565f89;
    --amber: #fbbf24; --amber-soft: #fbbf2426; --amber-line: #fbbf2459; --rose: #fb7185;
    --mono: "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font: 16px/1.5 var(--sans);
    -webkit-text-size-adjust: 100%;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    display: flex; flex-direction: column; height: 100dvh; overflow: hidden;
  }
  button, select, textarea { font: inherit; color: inherit; }
  button { cursor: pointer; -webkit-tap-highlight-color: transparent; border: 0; background: none; padding: 0; }
  [hidden] { display: none !important; }
  .glyph, .icon { width: 1em; height: 1em; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }

  header {
    background: var(--deep); border-bottom: 1px solid var(--line);
    padding: calc(env(safe-area-inset-top) + .5rem) max(.9rem, env(safe-area-inset-right)) .5rem max(.9rem, env(safe-area-inset-left));
    display: flex; align-items: center; gap: .7rem;
  }
  header > .glyph { font-size: 1.6rem; color: var(--amber); filter: drop-shadow(0 0 6px #fbbf2466); }
  .titles { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .pick { position: relative; min-width: 0; display: flex; max-width: 100%; }
  .pick select {
    appearance: none; -webkit-appearance: none; background: none; border: 0; min-width: 0; width: 100%;
    padding: 0 1.1rem 0 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; outline: none;
  }
  .pick::after { content: ""; position: absolute; right: .25rem; top: 50%; width: .38rem; height: .38rem; margin-top: -.28rem; border: solid var(--faint); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); pointer-events: none; }
  .pick:has(select:disabled)::after { display: none; }
  .pick select:disabled { opacity: 1; }
  #ghost { font-family: var(--mono); font-size: .72rem; color: var(--amber); font-weight: 600; letter-spacing: .04em; }
  #session { font-size: 1rem; font-weight: 500; color: var(--fg); }
  #ghost option, #session option { background: var(--surface); color: var(--fg); }
  #me {
    width: 2.1rem; height: 2.1rem; border-radius: 50%; display: grid; place-items: center; flex: none;
    background: var(--surface); border: 1px solid var(--amber-line); color: var(--amber);
    font-weight: 600; font-size: .85rem; text-transform: uppercase; user-select: none;
  }
  #me.guest { border-color: var(--line); color: var(--faint); }
  #me:empty { display: none; }

  main {
    flex: 1; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
    padding: 1rem max(.9rem, env(safe-area-inset-right)) 1.25rem max(.9rem, env(safe-area-inset-left));
    display: flex; flex-direction: column; gap: 1rem;
  }
  main > * { width: 100%; max-width: 46rem; margin-inline: auto; }
  .empty { margin: auto; text-align: center; color: var(--faint); font-family: var(--mono); font-size: .85rem; }
  .empty .glyph { display: block; font-size: 3.2rem; margin: 0 auto .9rem; color: var(--amber); opacity: .55; filter: drop-shadow(0 0 14px #fbbf2455); animation: float 4s ease-in-out infinite; }
  @keyframes float { 50% { transform: translateY(-5px); } }

  .msg { overflow-wrap: anywhere; }
  .user {
    width: auto; max-width: min(85%, 40rem); margin-right: 0; margin-left: auto;
    background: var(--surface); border: 1px solid var(--line); border-radius: 1rem 1rem .3rem 1rem;
    padding: .5rem .8rem; color: var(--fg);
  }
  .user .text { white-space: pre-wrap; }
  .user .pics { display: flex; flex-wrap: wrap; gap: .3rem; margin: -.15rem -.45rem .4rem; }
  .user .pics:last-child { margin-bottom: -.15rem; }
  .pics a { display: block; flex: 1 1 8rem; max-width: 100%; }
  .pics img { display: block; width: 100%; max-height: 18rem; object-fit: cover; border-radius: .7rem; background: var(--deep); }
  .assistant { color: var(--fg); }
  .assistant.pending::after { content: ""; display: inline-block; width: .55rem; height: 1.05em; vertical-align: text-bottom; background: var(--amber); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .assistant > :first-child { margin-top: 0; } .assistant > :last-child { margin-bottom: 0; }
  .assistant p { margin: 0 0 .75em; white-space: pre-wrap; }
  .assistant li { white-space: pre-wrap; margin: .2em 0; }
  .assistant :is(ul, ol) { margin: 0 0 .75em; padding-left: 1.3em; }
  .assistant li::marker { color: var(--amber); }
  .assistant :is(h1, h2, h3, h4, h5, h6) { font-family: var(--mono); font-size: .95rem; color: #fff; margin: 1.2em 0 .45em; letter-spacing: .01em; }
  .assistant :is(h1, h2) { font-size: 1.05rem; color: var(--amber); }
  .assistant strong { color: #fff; }
  .assistant em { color: var(--dim); }
  .assistant a { color: var(--amber); text-decoration-color: var(--amber-line); text-underline-offset: 2px; }
  .assistant code { font-family: var(--mono); font-size: .84em; background: var(--deep); border: 1px solid var(--line); padding: .05em .3em; border-radius: .25em; }
  .assistant pre { margin: 0 0 .75em; overflow-x: auto; background: var(--deep); border: 1px solid var(--line); border-left: 2px solid var(--amber-line); padding: .7rem .85rem; line-height: 1.45; }
  .assistant pre code { background: none; border: 0; padding: 0; font-size: .8rem; }
  .assistant blockquote { margin: 0 0 .75em; padding: .1em 0 .1em .85em; border-left: 2px solid var(--faint); color: var(--dim); }
  .assistant hr { border: 0; border-top: 1px solid var(--line); margin: 1.2em 0; }
  .assistant table { border-collapse: collapse; display: block; overflow-x: auto; margin: 0 0 .75em; font-size: .9em; }
  .assistant :is(th, td) { border: 1px solid var(--line); padding: .35em .65em; text-align: left; vertical-align: top; }
  .assistant th { background: var(--deep); font-family: var(--mono); font-size: .85em; color: var(--amber); font-weight: 600; }
  .activity { font-family: var(--mono); font-size: .75rem; color: var(--faint); display: flex; gap: .45rem; align-items: center; margin-top: -.5rem; }
  .activity::before { content: ""; width: .35rem; height: .35rem; background: var(--amber); opacity: .6; flex: none; }

  #status { font-family: var(--mono); font-size: .75rem; color: var(--rose); padding: .3rem 1rem 0; text-align: center; }
  #status:empty { display: none; }
  form {
    padding: .5rem max(.5rem, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + .5rem) max(.5rem, env(safe-area-inset-left));
  }
  #tray { max-width: 46rem; margin: 0 auto .35rem; display: flex; gap: .55rem; overflow: auto hidden; scrollbar-width: none; padding: .45rem .4rem .1rem 3.05rem; }
  #tray:empty { display: none; }
  .thumb { position: relative; flex: none; width: 4.2rem; height: 4.2rem; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: .6rem; border: 1px solid var(--line); }
  .thumb.uploading img { opacity: .45; }
  .thumb button { position: absolute; top: -.35rem; right: -.35rem; width: 1.4rem; height: 1.4rem; border-radius: 50%; background: var(--deep); border: 1px solid var(--line); color: var(--dim); font-size: .9rem; line-height: 1; display: grid; place-items: center; }
  .row { max-width: 46rem; margin: 0 auto; display: flex; align-items: flex-end; gap: .45rem; }
  .round { width: 2.6rem; height: 2.6rem; border-radius: 50%; display: grid; place-items: center; flex: none; font-size: 1.3rem; }
  #new { color: var(--amber); background: var(--surface); }
  #new:active { background: var(--amber-soft); }
  .box {
    flex: 1; min-width: 0; display: flex; align-items: flex-end; background: var(--surface); border: 1px solid var(--line);
    border-radius: 1.3rem; padding: 0 .3rem 0 1rem; min-height: 2.6rem; transition: border-color .15s;
  }
  .box:focus-within { border-color: var(--amber-line); }
  textarea { flex: 1; min-width: 0; background: none; border: 0; outline: none; resize: none; font-size: 16px; line-height: 1.4; padding: .58rem 0; max-height: 35dvh; caret-color: var(--amber); }
  textarea::placeholder { color: var(--faint); }
  #camera { width: 2.3rem; height: 2.5rem; display: grid; place-items: center; color: var(--dim); font-size: 1.25rem; flex: none; }
  #send { background: var(--amber); color: var(--deep); transition: transform .12s, background .15s; }
  #send:active { transform: scale(.94); }
  #send:disabled { background: var(--surface); color: var(--faint); }
  #send .icon { font-size: 1.2rem; margin-left: .12rem; }
</style>
<header>
  ${GLYPH}
  <div class="titles">
    <div class="pick"><select id="ghost" aria-label="Ghost"></select></div>
    <div class="pick"><select id="session" aria-label="Conversation"></select></div>
  </div>
  <span id="me" role="img"></span>
</header>
<main id="log"></main>
<div id="status" role="status"></div>
<form id="composer" hidden>
  <div id="tray"></div>
  <div class="row">
    <button id="new" class="round" type="button" aria-label="New conversation" title="New conversation">${PLUS}</button>
    <div class="box">
      <textarea id="prompt" placeholder="Message" rows="1"></textarea>
      <button id="camera" type="button" aria-label="Attach a photo" title="Attach a photo">${CAMERA}</button>
      <input id="file" type="file" accept="image/*" multiple hidden>
    </div>
    <button id="send" class="round" aria-label="Send" disabled>${SEND}</button>
  </div>
</form>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const api = (path, init) => fetch("/api" + path, init).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
    return r.json();
  });
  const seg = (id) => encodeURIComponent(id);
  const mint = () => "remote-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
  ${renderMarkdown.toString()}
  const GLYPH = ${JSON.stringify(GLYPH)};
  let ghost = null, session = null, draft = null, events = null, streaming = false, owner = false;
  let pending = [];

  const log = $("log"), prompt = $("prompt");
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const follow = (stick) => { if (stick) log.scrollTop = log.scrollHeight; };
  const attachmentUrl = (path) => "/api/ghosts/" + seg(ghost) + "/sessions/" + seg(session) + "/attachments/" + seg(path.slice("attachments/".length));

  /** An attachment line, \`![image](attachments/<file>)\`, gives its path; any other line gives null. */
  function attachmentOf(line) {
    const t = line.trim(), at = t.indexOf("](attachments/");
    return t.startsWith("![") && t.endsWith(")") && at > 0 && !t.slice(at + 2, -1).includes(" ") ? t.slice(at + 2, -1) : null;
  }

  function userBubble(value) {
    const el = document.createElement("div"); el.className = "msg user";
    const lines = value.split("\\n"), paths = lines.map(attachmentOf).filter(Boolean);
    if (paths.length) {
      const pics = document.createElement("div"); pics.className = "pics";
      for (const path of paths) {
        const a = document.createElement("a"); a.href = attachmentUrl(path); a.target = "_blank";
        const img = document.createElement("img"); img.src = a.href; img.alt = "Attached photo"; img.loading = "lazy";
        a.append(img); pics.append(a);
      }
      el.append(pics);
    }
    const rest = lines.filter((l) => !attachmentOf(l)).join("\\n").trim();
    if (rest) { const t = document.createElement("div"); t.className = "text"; t.textContent = rest; el.append(t); }
    return el;
  }
  function assistantBubble(value) {
    const el = document.createElement("div"); el.className = "msg assistant";
    el.replaceChildren(renderMarkdown(value, document));
    return el;
  }
  /**
   * What a reply shows: the text after its last tool call, or while it is
   * still inside its calls the narration before them (the HUD's TurnBlocks rule).
   */
  function finalText(parts) {
    let text = "", last = "";
    for (const p of parts) {
      if (p.type === "text") text += p.text;
      else if (p.type === "toolCall") { if (text.trim()) last = text; text = ""; }
    }
    return text.trim() ? text : last;
  }
  function empty() {
    const el = document.createElement("div"); el.className = "empty";
    el.innerHTML = GLYPH; el.append(ghost ? "Say something to " + ghost + "." : "No ghost here yet.");
    log.replaceChildren(el);
  }

  function render(messages) {
    log.textContent = "";
    for (const m of messages) {
      if (m.role === "user") {
        const body = typeof m.content === "string" ? m.content
          : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("");
        if (body.trim()) log.append(userBubble(body));
      } else if (m.role === "assistant") {
        const body = typeof m.content === "string" ? m.content : finalText(m.content || []);
        if (body.trim()) log.append(assistantBubble(body));
      }
    }
    if (!log.childElementCount) empty();
    log.scrollTop = log.scrollHeight;
  }

  async function loadTranscript() {
    if (!ghost || !session || session === draft) return render([]);
    const t = await api("/ghosts/" + seg(ghost) + "/sessions/" + seg(session) + "/transcript");
    render(t.messages);
  }

  async function loadSessions() {
    const { sessions } = await api("/ghosts/" + seg(ghost) + "/sessions");
    if (draft && sessions.some((s) => s.id === draft)) draft = null;
    if (!sessions.length && !draft && owner) draft = session = mint();
    const list = draft ? [{ id: draft, title: "New conversation" }, ...sessions] : sessions;
    const select = $("session");
    select.textContent = "";
    for (const s of list) {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = s.title || s.preview || s.id;
      select.append(o);
    }
    if (!list.some((s) => s.id === session)) session = list[0]?.id || null;
    select.value = session || "";
    select.disabled = list.length < 2;
    await loadTranscript();
  }

  function watch() {
    events?.close();
    if (!ghost) return;
    events = new EventSource("/api/ghosts/" + seg(ghost) + "/events");
    events.onmessage = () => { if (!streaming) loadSessions().catch(show); };
  }

  function show(err) { $("status").textContent = err?.message || String(err || ""); }

  // ── Photos: shrunk on the phone, stored in the conversation, named in the message.

  async function shrink(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return file;
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 2e6) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", 0.85));
  }

  function attach(file) {
    if (!session) draft = session = mint();
    const item = { url: URL.createObjectURL(file), path: null, el: document.createElement("div") };
    item.el.className = "thumb uploading";
    const img = document.createElement("img"); img.src = item.url; img.alt = "";
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "\\u00d7"; remove.setAttribute("aria-label", "Remove photo");
    remove.onclick = () => drop(item);
    item.el.append(img, remove); $("tray").append(item.el);
    const target = "/ghosts/" + seg(ghost) + "/sessions/" + seg(session) + "/attachments";
    item.upload = shrink(file)
      .then((blob) => api(target, { method: "POST", headers: { "content-type": blob.type || "image/jpeg" }, body: blob }))
      .then((r) => { item.path = r.path; item.el.classList.remove("uploading"); })
      .catch((err) => { drop(item); show(err); });
    pending.push(item); refresh();
  }
  function drop(item) {
    pending = pending.filter((p) => p !== item);
    item.el.remove(); URL.revokeObjectURL(item.url); refresh();
  }
  function clearTray() { for (const item of [...pending]) drop(item); }

  function refresh() { $("send").disabled = streaming || (!prompt.value.trim() && !pending.length); }
  function grow() { prompt.style.height = "auto"; prompt.style.height = prompt.scrollHeight + "px"; refresh(); }

  async function send() {
    const text = prompt.value.trim();
    if ((!text && !pending.length) || streaming || !ghost) return;
    streaming = true; show(""); refresh();
    try {
      await Promise.all(pending.map((p) => p.upload));
      const lines = pending.filter((p) => p.path).map((p) => "![image](" + p.path + ")");
      const message = [text, ...lines].filter(Boolean).join("\\n\\n");
      if (!message) return;
      if (!session) draft = session = mint();
      const r = await fetch("/api/ghosts/" + seg(ghost) + "/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: message, sessionId: session }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
      prompt.value = ""; grow(); clearTray();
      log.querySelector(".empty")?.remove();
      log.append(userBubble(message));
      const reply = assistantBubble(""); reply.classList.add("pending"); log.append(reply);
      // Only the call running now, the way the HUD's activity line shows it; a
      // finished reply keeps none of them.
      const activity = document.createElement("div"); activity.className = "activity";
      follow(true);
      const parts = [];
      const reader = r.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf("\\n\\n")) >= 0) {
            const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const line = frame.split("\\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6));
            const stick = nearBottom();
            if (ev.type === "text_delta") {
              if (parts.at(-1)?.type === "text") parts.at(-1).text += ev.delta;
              else parts.push({ type: "text", text: ev.delta });
              reply.replaceChildren(renderMarkdown(finalText(parts), document));
            } else if (ev.type === "tool_execution_start") {
              parts.push({ type: "toolCall" });
              activity.textContent = ev.toolName + "\u2026"; reply.after(activity);
            }
            else if (ev.type === "error") show(ev.errorMessage);
            follow(stick);
          }
        }
      } finally {
        reply.classList.remove("pending");
        activity.remove();
      }
    } finally {
      streaming = false; refresh();
    }
    await loadSessions();
  }

  prompt.oninput = grow;
  prompt.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault(); send().catch(show);
    }
  };
  $("composer").onsubmit = (e) => { e.preventDefault(); send().catch(show); };
  $("camera").onclick = () => $("file").click();
  $("file").onchange = () => { for (const f of $("file").files) attach(f); $("file").value = ""; };
  $("ghost").onchange = () => { ghost = $("ghost").value; session = draft = null; clearTray(); watch(); loadSessions().catch(show); };
  $("session").onchange = () => { session = $("session").value; clearTray(); loadTranscript().catch(show); };
  $("new").onclick = () => {
    if (streaming || !ghost) return;
    if (session !== draft || !draft) draft = session = mint();
    clearTray(); loadSessions().catch(show);
    prompt.focus();
  };

  (async () => {
    const who = await api("/remote/whoami");
    owner = who.role !== "guest";
    const me = $("me"), label = who.login ? who.login + (owner ? "" : " (read-only)") : "";
    me.textContent = (who.name || who.login || "").trim().charAt(0);
    me.title = label; me.setAttribute("aria-label", label); me.classList.toggle("guest", !owner);
    $("composer").hidden = !owner;
    refresh();
    const ghosts = await api("/ghosts");
    for (const g of ghosts) { const o = document.createElement("option"); o.value = g.name; o.textContent = g.name; $("ghost").append(o); }
    $("ghost").disabled = ghosts.length < 2;
    ghost = ghosts[0]?.name || null;
    if (ghost) { watch(); await loadSessions(); } else empty();
  })().catch(show);
})();
</script>
`;

function inlineHash(tag: "script" | "style"): string {
  const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(REMOTE_VIEWER_HTML)?.[1] ?? "";
  return `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
}

/** Strict: only the page's own inline script and style, this origin's API, and its own photos. */
export const REMOTE_VIEWER_CSP = `default-src 'none'; script-src ${inlineHash("script")}; style-src ${inlineHash("style")}; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; form-action 'none'; base-uri 'none'`;

export const REMOTE_MANIFEST = {
  name: "Ghost",
  short_name: "Ghost",
  start_url: "/",
  display: "standalone",
  background_color: "#16161e",
  theme_color: "#16161e",
} as const;
