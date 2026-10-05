/**
 * The page a phone or another laptop opens over the tailnet: one HTML file,
 * no framework, served by the daemon at `/`. It talks to the
 * same API the shell uses; `tailscale serve` supplies the caller's identity,
 * so the page carries no token. Guests see a read-only view; the owner can
 * type. It wears the HUD's look: Tokyo Night under the ghost's amber.
 */
import { createHash } from "node:crypto";
import { renderMarkdown } from "./remote-markdown.js";

const GLYPH = `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8zM9 10h.01M15 10h.01"/></svg>`;

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
    font: 16px/1.55 var(--sans);
    -webkit-text-size-adjust: 100%;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    display: flex; flex-direction: column; height: 100dvh; overflow: hidden;
  }
  button, select, textarea { font: inherit; color: inherit; }
  button { cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .glyph { width: 1em; height: 1em; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }

  header {
    background: var(--deep); border-bottom: 1px solid var(--line);
    padding: calc(env(safe-area-inset-top) + .55rem) max(1rem, env(safe-area-inset-right)) .6rem max(1rem, env(safe-area-inset-left));
    display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: .35rem .6rem;
    font-family: var(--mono); font-size: .8rem;
  }
  header > .glyph { font-size: 1.35rem; color: var(--amber); filter: drop-shadow(0 0 6px #fbbf2466); }
  .pick { position: relative; min-width: 0; display: flex; }
  .pick select {
    appearance: none; -webkit-appearance: none; background: none; border: 0; min-width: 0; width: 100%;
    padding: .2rem 1.1rem .2rem 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; outline: none;
  }
  .pick::after { content: ""; position: absolute; right: .2rem; top: 50%; width: .4rem; height: .4rem; margin-top: -.3rem; border: solid var(--faint); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); pointer-events: none; }
  .pick select:disabled { opacity: 1; }
  .pick[hidden] { display: none; }
  .pick:has(select:disabled)::after { display: none; }
  #ghost { color: var(--amber); font-weight: 600; letter-spacing: .02em; }
  #ghost option, #session option { background: var(--surface); color: var(--fg); }
  #role { color: var(--faint); white-space: nowrap; }
  #new {
    width: 2.1rem; height: 2.1rem; border-radius: 0; border: 1px solid var(--amber-line);
    background: var(--amber-soft); color: var(--amber); font-size: 1.25rem; line-height: 1; padding: 0;
    display: grid; place-items: center;
  }
  #new:active { background: #fbbf2440; }
  .conv { grid-column: 1 / -1; border: 1px solid var(--line); background: var(--bg); }
  .conv select { padding: .45rem 1.8rem .45rem .7rem; color: var(--dim); }
  .conv::after { right: .8rem; }

  main {
    flex: 1; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
    padding: 1.1rem max(1rem, env(safe-area-inset-right)) 1.5rem max(1rem, env(safe-area-inset-left));
    display: flex; flex-direction: column; gap: 1.1rem;
  }
  main > * { width: 100%; max-width: 46rem; margin-inline: auto; }
  .empty { margin: auto; text-align: center; color: var(--faint); font-family: var(--mono); font-size: .85rem; }
  .empty .glyph { display: block; font-size: 3.2rem; margin: 0 auto .9rem; color: var(--amber); opacity: .55; filter: drop-shadow(0 0 14px #fbbf2455); animation: float 4s ease-in-out infinite; }
  @keyframes float { 50% { transform: translateY(-5px); } }

  .msg { overflow-wrap: anywhere; }
  .user {
    width: auto; max-width: min(85%, 40rem); margin-right: 0; margin-left: auto;
    white-space: pre-wrap; background: var(--surface); border: 1px solid var(--line); border-right: 2px solid var(--amber);
    padding: .55rem .8rem; color: var(--fg);
  }
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
  .assistant code { font-family: var(--mono); font-size: .84em; background: var(--deep); border: 1px solid var(--line); padding: .05em .3em; }
  .assistant pre { margin: 0 0 .75em; overflow-x: auto; background: var(--deep); border: 1px solid var(--line); border-left: 2px solid var(--amber-line); padding: .7rem .85rem; line-height: 1.45; }
  .assistant pre code { background: none; border: 0; padding: 0; font-size: .8rem; }
  .assistant blockquote { margin: 0 0 .75em; padding: .1em 0 .1em .85em; border-left: 2px solid var(--faint); color: var(--dim); }
  .assistant hr { border: 0; border-top: 1px solid var(--line); margin: 1.2em 0; }
  .assistant table { border-collapse: collapse; display: block; overflow-x: auto; margin: 0 0 .75em; font-size: .9em; }
  .assistant :is(th, td) { border: 1px solid var(--line); padding: .35em .65em; text-align: left; vertical-align: top; }
  .assistant th { background: var(--deep); font-family: var(--mono); font-size: .85em; color: var(--amber); font-weight: 600; }
  .tool { font-family: var(--mono); font-size: .75rem; color: var(--faint); display: flex; gap: .45rem; align-items: center; margin-bottom: -.6rem; }
  .tool::before { content: ""; width: .35rem; height: .35rem; background: var(--amber); opacity: .6; flex: none; }

  #status { font-family: var(--mono); font-size: .75rem; color: var(--rose); padding: 0 1rem; text-align: center; }
  #status:empty { display: none; }
  form {
    background: var(--deep); border-top: 1px solid var(--line);
    padding: .65rem max(.75rem, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + .65rem) max(.75rem, env(safe-area-inset-left));
  }
  form[hidden] { display: none; }
  .box { max-width: 46rem; margin: 0 auto; display: flex; align-items: flex-end; gap: .5rem; background: var(--bg); border: 1px solid var(--line); padding: .35rem .35rem .35rem .8rem; transition: border-color .15s; }
  .box:focus-within { border-color: var(--amber-line); box-shadow: 0 0 0 3px #fbbf2412; }
  textarea { flex: 1; background: none; border: 0; outline: none; resize: none; font-size: 16px; line-height: 1.45; padding: .4rem 0; max-height: 40dvh; caret-color: var(--amber); }
  textarea::placeholder { color: var(--faint); }
  #send { width: 2.4rem; height: 2.4rem; border: 0; border-radius: 0; background: var(--amber); color: var(--deep); display: grid; place-items: center; padding: 0; flex: none; transition: opacity .15s; }
  #send:disabled { background: var(--surface); color: var(--faint); }
  #send svg { width: 1.15rem; height: 1.15rem; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
</style>
<header>
  ${GLYPH}
  <div class="pick"><select id="ghost" aria-label="Ghost"></select></div>
  <span id="role"></span>
  <button id="new" type="button" aria-label="New conversation" title="New conversation" hidden>+</button>
  <div class="pick conv"><select id="session" aria-label="Conversation"></select></div>
</header>
<main id="log"></main>
<div id="status" role="status"></div>
<form id="composer" hidden>
  <div class="box">
    <textarea id="prompt" placeholder="Say something…" rows="1" enterkeyhint="send"></textarea>
    <button id="send" aria-label="Send" disabled><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
  </div>
</form>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const api = (path, init) => fetch("/api" + path, init).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
    return r.json();
  });
  const text = (content) => typeof content === "string" ? content
    : (content || []).map((p) => p.type === "text" ? p.text : p.type === "toolCall" ? "\\u2699 " + p.name : "").join("");
  const seg = (id) => encodeURIComponent(id);
  const mint = () => "remote-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
  ${renderMarkdown.toString()}
  const GLYPH = ${JSON.stringify(GLYPH)};
  let ghost = null, session = null, draft = null, events = null, streaming = false, owner = false;

  const log = $("log");
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const follow = (stick) => { if (stick) log.scrollTop = log.scrollHeight; };
  function bubble(role, value) {
    const el = document.createElement("div");
    el.className = "msg " + role;
    if (role === "assistant") el.replaceChildren(renderMarkdown(value, document));
    else el.textContent = value;
    return el;
  }
  function toolLine(name) {
    const el = document.createElement("div"); el.className = "tool"; el.textContent = name; return el;
  }
  function empty() {
    const el = document.createElement("div"); el.className = "empty";
    el.innerHTML = GLYPH; el.append(ghost ? "Say something to " + ghost + "." : "No ghost here yet.");
    log.replaceChildren(el);
  }

  function render(messages) {
    log.textContent = "";
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (m.role === "assistant" && Array.isArray(m.content))
        for (const p of m.content) if (p.type === "toolCall") log.append(toolLine(p.name));
      const body = m.role === "assistant" && Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("") : text(m.content);
      if (body.trim()) log.append(bubble(m.role, body));
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
      o.value = s.id; o.textContent = s.title || s.preview || s.conversationId || s.id;
      select.append(o);
    }
    if (!list.some((s) => s.id === session)) session = list[0]?.id || null;
    select.value = session || "";
    select.parentElement.hidden = !list.length;
    await loadTranscript();
  }

  function watch() {
    events?.close();
    if (!ghost) return;
    events = new EventSource("/api/ghosts/" + seg(ghost) + "/events");
    events.onmessage = () => {
      if (!streaming) loadSessions().catch(show);
    };
  }

  function show(err) { $("status").textContent = err?.message || String(err || ""); }

  async function send(prompt) {
    streaming = true; show("");
    if (!session) { draft = session = mint(); }
    const r = await fetch("/api/ghosts/" + seg(ghost) + "/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, sessionId: session }),
    });
    if (!r.ok) { streaming = false; throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText); }
    log.querySelector(".empty")?.remove();
    log.append(bubble("user", prompt));
    const reply = bubble("assistant", ""); reply.classList.add("pending"); log.append(reply);
    follow(true);
    let replyText = "";
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
          if (ev.type === "text_delta") { replyText += ev.delta; reply.replaceChildren(renderMarkdown(replyText, document)); }
          else if (ev.type === "tool_execution_start") reply.before(toolLine(ev.toolName));
          else if (ev.type === "error") show(ev.errorMessage);
          follow(stick);
        }
      }
    } finally {
      reply.classList.remove("pending");
      streaming = false;
    }
    await loadSessions();
  }

  const prompt = $("prompt");
  const grow = () => { prompt.style.height = "auto"; prompt.style.height = prompt.scrollHeight + "px"; $("send").disabled = !prompt.value.trim(); };
  prompt.oninput = grow;
  prompt.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault(); $("composer").requestSubmit();
    }
  };
  $("ghost").onchange = () => { ghost = $("ghost").value; session = draft = null; watch(); loadSessions().catch(show); };
  $("session").onchange = () => { session = $("session").value; loadTranscript().catch(show); };
  $("new").onclick = () => {
    if (streaming || !ghost) return;
    if (session !== draft || !draft) draft = session = mint();
    loadSessions().catch(show);
    prompt.focus();
  };
  $("composer").onsubmit = (e) => {
    e.preventDefault();
    const value = prompt.value.trim();
    if (!value || streaming || !ghost) return;
    prompt.value = ""; grow();
    send(value).catch(show);
  };

  (async () => {
    const who = await api("/remote/whoami");
    $("role").textContent = who.login ? who.login + " \\u00b7 " + who.role : "local";
    owner = who.role !== "guest";
    $("composer").hidden = !owner; $("new").hidden = !owner;
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

/** Strict: only the page's own inline script and style, and only this origin's API. */
export const REMOTE_VIEWER_CSP = `default-src 'none'; script-src ${inlineHash("script")}; style-src ${inlineHash("style")}; connect-src 'self'; manifest-src 'self'; form-action 'none'; base-uri 'none'`;

export const REMOTE_MANIFEST = {
  name: "Ghost",
  short_name: "Ghost",
  start_url: "/",
  display: "standalone",
  background_color: "#16161e",
  theme_color: "#16161e",
} as const;
