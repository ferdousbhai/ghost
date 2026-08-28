/**
 * The page a phone or another laptop opens over the tailnet: one HTML file,
 * no framework, served by the daemon at `/`. It talks to the
 * same API the shell uses; `tailscale serve` supplies the caller's identity,
 * so the page carries no token. Guests see a read-only view; the owner can
 * type.
 */
import { createHash } from "node:crypto";

export const REMOTE_VIEWER_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#111318">
<link rel="manifest" href="/manifest.webmanifest">
<title>ghost</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.45 system-ui, sans-serif; }
  body { margin: 0; display: grid; grid-template-rows: auto 1fr auto; height: 100dvh; }
  header { display: flex; gap: .5rem; align-items: center; padding: .5rem .75rem; border-bottom: 1px solid #8884; }
  header select { max-width: 45vw; }
  #role { margin-left: auto; opacity: .7; font-size: .85em; }
  main { overflow: auto; padding: .75rem; display: flex; flex-direction: column; gap: .6rem; }
  .msg { max-width: 60rem; white-space: pre-wrap; word-break: break-word; padding: .5rem .7rem; border-radius: .6rem; }
  .user { align-self: flex-end; background: #4a7cff22; }
  .assistant { align-self: flex-start; background: #8883; }
  .tool { font-size: .85em; opacity: .75; font-family: ui-monospace, monospace; }
  form { display: flex; gap: .5rem; padding: .5rem .75rem; border-top: 1px solid #8884; }
  form textarea { flex: 1; resize: none; min-height: 2.6rem; font: inherit; }
  #status { padding: 0 .75rem .4rem; font-size: .85em; opacity: .7; min-height: 1.2em; }
</style>
<header>
  <select id="ghost"></select>
  <select id="session"></select>
  <span id="role"></span>
</header>
<main id="log"></main>
<div id="status"></div>
<form id="composer" hidden>
  <textarea id="prompt" placeholder="Say something…" rows="1"></textarea>
  <button>Send</button>
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
  let ghost = null, session = null, events = null, streaming = false;

  function render(messages) {
    const log = $("log");
    log.textContent = "";
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const el = document.createElement("div");
      el.className = "msg " + m.role;
      el.textContent = text(m.content);
      log.append(el);
    }
    log.scrollTop = log.scrollHeight;
  }

  async function loadTranscript() {
    if (!ghost || !session) return;
    const t = await api("/ghosts/" + seg(ghost) + "/sessions/" + seg(session) + "/transcript");
    render(t.messages);
  }

  async function loadSessions() {
    const { sessions } = await api("/ghosts/" + seg(ghost) + "/sessions");
    const select = $("session");
    select.textContent = "";
    for (const s of sessions) {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = s.title || s.conversationId;
      select.append(o);
    }
    if (!sessions.some((s) => s.id === session)) session = sessions[0]?.id || null;
    select.value = session || "";
    await loadTranscript();
  }

  function watch() {
    events?.close();
    if (!ghost) return;
    events = new EventSource("/api/ghosts/" + seg(ghost) + "/events");
    events.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (streaming) return;
      if (ev.id === session) loadTranscript().catch(show);
      else loadSessions().catch(show);
    };
  }

  function show(err) { $("status").textContent = err?.message || String(err || ""); }

  async function send(prompt) {
    streaming = true;
    const conversationId = session ? session.replace(/^pi:/, "") : "remote";
    const r = await fetch("/api/ghosts/" + seg(ghost) + "/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        context: { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
        options: { sessionId: conversationId },
      }),
    });
    if (!r.ok) { streaming = false; throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText); }
    const me = document.createElement("div"); me.className = "msg user"; me.textContent = prompt; $("log").append(me);
    const reply = document.createElement("div"); reply.className = "msg assistant"; $("log").append(reply);
    const reader = r.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
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
        if (ev.type === "text_delta") reply.textContent += ev.delta;
        else if (ev.type === "tool_execution_start") { const t = document.createElement("div"); t.className = "msg tool"; t.textContent = "\\u2699 " + ev.toolName; reply.before(t); }
        else if (ev.type === "error") show(ev.errorMessage);
        $("log").scrollTop = $("log").scrollHeight;
      }
    }
    streaming = false;
    await loadTranscript();
  }

  $("ghost").onchange = () => { ghost = $("ghost").value; session = null; watch(); loadSessions().catch(show); };
  $("session").onchange = () => { session = $("session").value; loadTranscript().catch(show); };
  $("composer").onsubmit = (e) => {
    e.preventDefault();
    const prompt = $("prompt").value.trim();
    if (!prompt || streaming) return;
    $("prompt").value = "";
    send(prompt).catch(show);
  };

  (async () => {
    const who = await api("/remote/whoami");
    $("role").textContent = who.login ? who.login + " (" + who.role + ")" : "local";
    $("composer").hidden = who.role === "guest";
    const ghosts = await api("/ghosts");
    for (const g of ghosts) { const o = document.createElement("option"); o.value = g.name; o.textContent = g.name; $("ghost").append(o); }
    ghost = ghosts[0]?.name || null;
    if (ghost) { watch(); await loadSessions(); }
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
  background_color: "#111318",
  theme_color: "#111318",
} as const;
