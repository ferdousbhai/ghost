#!/usr/bin/env node
/**
 * mock-ghostd — just enough of the CONTRACTS.md daemon API to build and demo
 * the Quickshell surfaces without pi, models, or a real ghost home.
 *
 * Implements:
 *   GET  /api/ghosts                          → [{ name, dir, createdAt }]
 *   POST /api/ghosts { name }                 → 201 + the new ghost
 *   DELETE /api/ghosts/:name?confirm=:name    → 200 { ok, trash } | 400 | 404 | 409
 *   POST /api/ghosts/:name/messages           → pi-messages SSE (canned reply)
 *   POST /api/ghosts/:name/greeting           → { greeting, onboarding }, ~800ms late
 *   GET  /api/ghosts/:name/sessions           → { sessions: [...] }, newest first
 *   DELETE /api/ghosts/:name/sessions/:id     → delete one conversation
 *   GET  /api/ghosts/:name/sessions/:id/transcript → { id, title, messages, … }
 *   POST /api/ghosts/:name/sessions/:id/branch → { action: "fork", entryId }
 *   GET  /api/ghosts/:name/providers          → loginable providers
 *   POST /api/ghosts/:name/login              → start a login → { loginId, status }
 *   GET  /api/ghosts/:name/login/:loginId     → current login step
 *   POST /api/ghosts/:name/login/:loginId/input → satisfy an awaiting prompt
 *
 * The login flows are scripted (no real provider): openai-codex OAuth offers a
 * select (browser callback vs device code), openrouter OAuth shows an auth URL
 * plus a paste field, and api-key flows ask for a masked key. Nothing touches
 * the filesystem: ghosts and logins live in memory and vanish on exit.
 *
 * Auth: none. The real daemon requires `Authorization: Bearer <token>` on
 * every /api route (CONTRACTS.md); the mock accepts and ignores the header so
 * the surfaces can be driven on a machine where `ghostd` has never run and no
 * token file exists. Ghostd.qml sends no header when it cannot read one, so
 * both paths work. Anything testing the *auth* itself belongs against the real
 * daemon, not here.
 *
 * Usage:  node dev/mock-ghostd.mjs [--port 7717] [--slow] [--fail]
 *   --slow   30ms between text deltas instead of 12ms
 *   --fail   terminate the next turn with a pi-messages `error` event
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(opt("--port", process.env.GHOSTD_PORT ?? "7717"));
const HOST = "127.0.0.1";
const DELTA_MS = flag("--slow") ? 30 : 12;
const GHOSTS_ROOT = join(homedir(), "Ghosts");
const TRASH_ROOT = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "Trash", "files");

/** @type {{ name: string, dir: string, createdAt: string }[]} */
const ghosts = ["casper", "moaning-myrtle"].map((name) => ({
  name,
  dir: join(GHOSTS_ROOT, name),
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
}));

// ---- Conversation store ----------------------------------------------------
// The daemon persists a ghost's conversations (pi sessions); the mock keeps
// them in memory. Each ghost is seeded with a titled thread and an untitled one
// (title === null exercises the HUD's fallback). A turn appends to its session
// and, on the first turn, "titles" it in the background like the real daemon.

/** @type {Map<string, Map<string, { id, title, createdAt, updatedAt, messages }>>} */
const sessionStore = new Map();

// Persisted messages carry an `entryId`; the branch glyph is bound to it, so a
// transcript without one has nothing to branch from and the surface cannot be
// demoed at all. Opaque and monotonic here, as it is in a real transcript.
let entrySeq = 0;
let forkSeq = 0;
const entry = (message) => ({ ...message, entryId: `entry-${++entrySeq}` });

function ghostSessions(name) {
  if (!sessionStore.has(name)) {
    const now = Date.now();
    const seed = new Map();
    const titled = {
      id: `sess-${name}-1`,
      title: "first contact",
      createdAt: new Date(now - 7_200_000).toISOString(),
      updatedAt: new Date(now - 3_600_000).toISOString(),
      messages: [
        entry({ role: "user", content: "hello, who lives here?", timestamp: now - 7_200_000 }),
        entry({ role: "assistant", content: `I'm **${name}**. This thread was seeded by the mock so resume has history to show.`, timestamp: now - 7_195_000 }),
        entry({ role: "user", content: "and what do you remember about me?", timestamp: now - 3_610_000 }),
        entry({ role: "assistant", content: "Nothing yet — but branch that question and you get a second thread to ask it differently.", timestamp: now - 3_600_000 }),
      ],
    };
    const untitled = {
      id: `sess-${name}-2`,
      title: null, // background titling hasn't run — exercises the fallback label
      createdAt: new Date(now - 600_000).toISOString(),
      updatedAt: new Date(now - 600_000).toISOString(),
      messages: [
        entry({ role: "user", content: "quick question about memory", timestamp: now - 600_000 }),
        entry({ role: "assistant", content: "Ask away — this is the untitled seed conversation.", timestamp: now - 595_000 }),
      ],
    };
    seed.set(titled.id, titled);
    seed.set(untitled.id, untitled);
    sessionStore.set(name, seed);
  }
  return sessionStore.get(name);
}

const transcriptOf = (s) => ({
  id: s.id,
  title: s.title ?? null,
  messages: s.messages,
  total: s.messages.length,
  truncated: false,
});

/**
 * The fork's name, on the file-copy convention the daemon uses: the source
 * title with any trailing " (k)" dropped, then the smallest free n >= 2. A
 * source nobody has titled yet forks into one nobody has titled either —
 * inventing "(2)" for a null title would name the copy better than the thing
 * it was copied from.
 */
function forkTitle(store, sourceTitle) {
  if (!sourceTitle) return null;
  // Same shape the daemon strips (session-host.ts forkConversationTitle), so a
  // demo names a copy the way the real thing would.
  const base = sourceTitle.replace(/^(.*\S)\s+\(\d+\)$/u, "$1");
  const taken = new Set([...store.values()].map((s) => s.title).filter(Boolean));
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Branch: copy the thread up to (not including) `entryId` into a conversation
 * of its own and hand back the branched text as a draft. The source is not
 * touched — that is the whole point of the action, so the mock must not cheat
 * it by rewinding in place.
 */
function forkSession(name, source, entryId) {
  const store = ghostSessions(name);
  const at = source.messages.findIndex((m) => m.entryId === entryId);
  if (at < 0 || source.messages[at].role !== "user") return null;
  const now = Date.now();
  const fork = {
    id: `sess-${name}-fork-${++forkSeq}`,
    title: forkTitle(store, source.title),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    // A copy is a new conversation, so its entries are new entries.
    messages: source.messages.slice(0, at).map(entry),
  };
  store.set(fork.id, fork);
  return { sessionId: fork.id, title: fork.title, draft: source.messages[at].content, transcript: transcriptOf(fork) };
}

const sessionSummary = (s) => ({
  id: s.id,
  title: s.title ?? null,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  messageCount: s.messages.length,
});

function recordTurn(name, sessionId, prompt, assistantText) {
  if (!sessionId) return;
  const store = ghostSessions(name);
  const now = Date.now();
  let s = store.get(sessionId);
  if (!s) {
    // A brand-new conversation the HUD minted: the daemon creates it lazily here.
    s = { id: sessionId, title: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), messages: [] };
    store.set(sessionId, s);
  }
  s.messages.push(entry({ role: "user", content: prompt, timestamp: now }));
  s.messages.push(entry({ role: "assistant", content: assistantText, timestamp: now }));
  s.updatedAt = new Date(now).toISOString();
  // Background titling after the first turn: derive a title from the prompt.
  if (!s.title) s.title = prompt.slice(0, 40) || "New conversation";
}

// ---- Greetings -------------------------------------------------------------
// The empty-chat opening line. Both branches of the contract are demoable:
// `casper` answers as a ghost that already knows the creator, `moaning-myrtle`
// answers `onboarding: true` (it has no character.md yet and says so), and any
// ghost created at runtime falls through to `greeting: null` — the "the daemon
// could not produce one" case, where the HUD must simply keep its static line.

/** @type {Record<string, { greeting: string, onboarding: boolean }>} */
const GREETINGS = {
  casper: {
    greeting:
      "You left the launch notes half-written last night, and the kettle is still on in roadmap.md. "
      + "Want to pick that thread back up? I can also just sit here quietly.",
    onboarding: false,
  },
  "moaning-myrtle": {
    greeting:
      "We haven’t met yet. I don’t have a character to speak from — no name I chose, no temperament, "
      + "nothing about how you want me to talk to you. Tell me any of it and I’ll write it down as mine.",
    onboarding: true,
  },
};

const GREETING_MS = 800;

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

/**
 * A scripted turn: the ghost narrating itself, one tool call — two for a ghost
 * still being written — then a two-paragraph answer.
 */
function* script(name, prompt) {
  let contentIndex = 0;
  yield { type: "start" };
  // The preamble a real model emits before reaching for a tool. It belongs
  // beside the orb, never in the reading column, so this is what the HUD's
  // split (qml/services/TurnBlocks.js) has to get right.
  const preamble = contentIndex++;
  const narration = "Checking what I remember about that";
  yield { type: "text_start", contentIndex: preamble };
  for (const chunk of narration.match(/\s*\S+/gu) ?? []) {
    yield { type: "text_delta", contentIndex: preamble, delta: chunk };
  }
  yield { type: "text_end", contentIndex: preamble, content: narration };
  const memory = contentIndex++;
  yield { type: "toolcall_start", contentIndex: memory, id: "call_1", toolName: "read_memory" };
  yield { type: "toolcall_delta", contentIndex: memory, delta: '{"query":"' };
  yield { type: "toolcall_delta", contentIndex: memory, delta: `${prompt.slice(0, 24)}"}` };
  yield {
    type: "toolcall_end",
    contentIndex: memory,
    toolCall: { type: "toolCall", id: "call_1", name: "read_memory", arguments: { query: prompt.slice(0, 24) } },
  };
  // A ghost whose greeting said it has no character writes one during the turn,
  // which is what puts a `ghost_character` card in the trace to look at.
  if (GREETINGS[name]?.onboarding) {
    const character = contentIndex++;
    const content = `# ${name}\n\nDrafted in the dev harness, from: ${prompt.slice(0, 40)}`;
    yield { type: "toolcall_start", contentIndex: character, id: "call_2", toolName: "ghost_character" };
    yield { type: "toolcall_delta", contentIndex: character, delta: '{"action":"write"' };
    yield { type: "toolcall_delta", contentIndex: character, delta: `,"content":${JSON.stringify(content)}}` };
    yield {
      type: "toolcall_end",
      contentIndex: character,
      toolCall: { type: "toolCall", id: "call_2", name: "ghost_character", arguments: { action: "write", content } },
    };
  }
  const answer = contentIndex++;
  yield { type: "text_start", contentIndex: answer };
  const reply =
    `You said: **${prompt}**\n\n`
    + `I am ${name}, a mock ghost. I live entirely in this dev harness — no pi session, `
    + `no model, no memory files. The real daemon streams the same pi-messages events, `
    + `so whatever renders here renders there.`;
  for (const chunk of reply.match(/\s*\S+/gu) ?? []) {
    yield { type: "text_delta", contentIndex: answer, delta: chunk };
  }
  yield { type: "text_end", contentIndex: answer, content: reply };
  const usage = {
    input: 812,
    output: reply.length >> 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 812 + (reply.length >> 2),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  yield flag("--fail")
    ? { type: "error", reason: "error", usage, errorMessage: "mock-ghostd --fail" }
    : { type: "done", reason: "stop", usage };
}

/** Ghosts with a turn in flight; a delete against one of these is 409 ghost_busy. */
const answering = new Set();

async function streamTurn(req, res, name, body) {
  const prompt = extractPrompt(body);
  const sessionId = body?.options?.sessionId;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-ghost-turn-id": req.headers["x-ghost-turn-id"] ?? crypto.randomUUID(),
  });
  const events = script(name, prompt);
  let closed = false;
  let assistantText = "";
  res.on("close", () => (closed = true));
  answering.add(name);
  try {
    for (const event of events) {
      if (closed) return;
      if (event.type === "text_end") assistantText = event.content;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      await new Promise((r) => setTimeout(r, event.type === "text_delta" ? DELTA_MS : 220));
    }
  } finally {
    answering.delete(name);
  }
  res.end();
  // Persist the completed turn so the session listing + transcript reflect it,
  // matching the daemon's lazy-create-and-title behaviour. A --fail turn wrote
  // no reply, so nothing is recorded.
  if (!flag("--fail")) recordTurn(name, sessionId, prompt, assistantText);
}

/** Pull the last user message's text out of a pi-messages `context`. */
function extractPrompt(body) {
  const messages = body?.context?.messages;
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  if (typeof last?.content === "string") return last.content;
  if (Array.isArray(last?.content)) {
    return last.content.filter((p) => p?.type === "text").map((p) => p.text).join(" ");
  }
  return "(no prompt)";
}

// ---- Scripted login flows --------------------------------------------------

const PROVIDERS = [
  { id: "openai-codex", name: "OpenAI Codex", subscription: true, authTypes: ["oauth"] },
  { id: "anthropic", name: "Anthropic", subscription: true, authTypes: ["oauth", "api_key"] },
  {
    id: "openrouter",
    name: "OpenRouter",
    subscription: false,
    authTypes: ["oauth", "api_key"],
    loginLabel: "Sign in with OpenRouter",
  },
];

/** loginId → mutable login session. */
const logins = new Map();

function startLogin(providerId, authType) {
  const loginId = "login-" + Math.random().toString(36).slice(2, 10);
  const session = { loginId, providerId, authType, view: { loginId, providerId, authType } };
  logins.set(loginId, session);
  if (authType === "api_key") {
    session.view.status = "awaiting_input";
    session.view.prompt = { kind: "secret", message: `${providerId} API key`, secret: true };
  } else if (providerId === "openai-codex") {
    // Offer the same choice pi's own codex flow does.
    session.view.status = "awaiting_select";
    session.view.prompt = {
      kind: "select",
      message: "How do you want to sign in?",
      secret: false,
      options: [
        { id: "callback", label: "Open a browser" },
        { id: "device_code", label: "Use a device code" },
      ],
    };
  } else {
    // openrouter (and anything else) OAuth: a callback URL plus a paste field.
    session.view.status = "awaiting_input";
    session.view.authUrl = "https://example.com/oauth/authorize?client=ghost&code=demo";
    session.view.prompt = { kind: "manual_code", message: "Paste the code from your browser", secret: true };
  }
  return session.view;
}

function loginInput(session, value) {
  const view = session.view;
  if (view.status === "awaiting_select") {
    if (value === "device_code") {
      view.status = "awaiting_device_code";
      view.deviceCode = "GHOST-1234";
      view.verificationUrl = "https://example.com/activate";
      view.deviceExpiresInSeconds = 900;
      delete view.prompt;
      // Auto-complete the device poll shortly, like a real provider would.
      setTimeout(() => finishLogin(session), 4000);
    } else {
      view.status = "awaiting_input";
      view.authUrl = "https://example.com/oauth/authorize?client=ghost&code=demo";
      view.prompt = { kind: "manual_code", message: "Paste the code from your browser", secret: true };
    }
    return view;
  }
  // A pasted code / api key completes the flow.
  finishLogin(session);
  return session.view;
}

// A finished login credentials the catalogue provider it maps to, so a model
// that was usable:false becomes usable after the switcher routes through login.
const LOGIN_TO_CATALOG = { "openai-codex": "openai", anthropic: "anthropic", openrouter: "google" };

function finishLogin(session) {
  const view = session.view;
  view.status = "succeeded";
  view.message = "Signed in.";
  const mapped = LOGIN_TO_CATALOG[session.providerId];
  if (mapped) credentialed.add(mapped);
  view.modelBound = { provider: session.providerId, modelId: "demo/first-model" };
  delete view.prompt;
}

// ---- Scripted model catalogue ----------------------------------------------
// A small stand-in for pi's ~1,270-model registry: enough providers and rows
// to exercise available-vs-catalog, the vision badge, search, and paging.

function modelVersion(id) {
  const dotted = id.match(/(?:^|[-_])(\d+\.\d+)/);
  if (dotted?.[1]) return Number.parseFloat(dotted[1]);
  const dashed = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
  if (dashed?.[1] && dashed[2]) return Number.parseFloat(`${dashed[1]}.${dashed[2]}`);
  const single = id.match(/(?:^|[-_])(\d+)/);
  return single?.[1] ? Number.parseFloat(single[1]) : 0;
}

function compareModels(a, b) {
  const provider = a.provider.localeCompare(b.provider);
  if (provider !== 0) return provider;
  const version = modelVersion(b.id) - modelVersion(a.id);
  return version || a.id.localeCompare(b.id);
}

/** @type {{ provider: string, id: string, name: string, contextWindow: number, cost: object, hasVision: boolean }[]} */
const CATALOG = [
  { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4", contextWindow: 200000, cost: { input: 15, output: 75 }, hasVision: true },
  { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200000, cost: { input: 3, output: 15 }, hasVision: true },
  { provider: "anthropic", id: "claude-haiku-3-5", name: "Claude Haiku 3.5", contextWindow: 200000, cost: { input: 0.8, output: 4 }, hasVision: true },
  { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1000000, cost: { input: 0.3, output: 2.5 }, hasVision: true },
  { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 2000000, cost: { input: 1.25, output: 10 }, hasVision: true },
  { provider: "ollama", id: "llama3.2", name: "Llama 3.2 (local)", contextWindow: 131072, cost: { input: 0, output: 0 }, hasVision: false },
  { provider: "ollama", id: "qwen2.5-coder", name: "Qwen2.5 Coder (local)", contextWindow: 32768, cost: { input: 0, output: 0 }, hasVision: false },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, cost: { input: 2.5, output: 10 }, hasVision: true },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini", contextWindow: 128000, cost: { input: 0.15, output: 0.6 }, hasVision: true },
  { provider: "openai", id: "o3", name: "o3", contextWindow: 200000, cost: { input: 2, output: 8 }, hasVision: true },
  { provider: "xai", id: "grok-4", name: "Grok 4", contextWindow: 256000, cost: { input: 5, output: 15 }, hasVision: false },
  { provider: "xai", id: "grok-4-fast", name: "Grok 4 Fast", contextWindow: 256000, cost: { input: 0.2, output: 0.5 }, hasVision: false },
].sort(compareModels);

// Which providers this mock pretends to be credentialed for. `anthropic` starts
// connected so the available list is non-empty; the rest route through login.
const credentialed = new Set(["anthropic"]);
/** ghost name → { provider, id } explicit chat-model role. */
const roles = new Map();
/** ghost name → { [ghostRole]: { primary, fallbacks } }. */
const routing = new Map();
const ROUTE_ROLES = [
  ["chat_model", "default", "Chat"],
  ["vision_model", "vision", "Vision"],
  ["smol_model", "smol", "Smol"],
  ["general_purpose_model", "general", "General purpose"],
  ["research_model", "research", "Research"],
];

const modelRow = (m) => ({
  provider: m.provider,
  id: m.id,
  name: m.name,
  contextWindow: m.contextWindow,
  cost: m.cost,
  hasVision: m.hasVision,
});

function resolveCurrent(name) {
  const role = roles.get(name);
  if (role) {
    const m = CATALOG.find((x) => x.provider === role.provider && x.id === role.id);
    if (m) {
      return {
        current: { provider: m.provider, id: m.id, name: m.name, contextWindow: m.contextWindow, hasVision: m.hasVision },
        source: "role",
      };
    }
  }
  const first = CATALOG.find((x) => credentialed.has(x.provider));
  if (first) {
    return {
      current: { provider: first.provider, id: first.id, name: first.name, contextWindow: first.contextWindow, hasVision: first.hasVision },
      source: "default",
    };
  }
  return { current: null, source: "none" };
}

function listModels(name, params) {
  const scope = params.get("scope") === "catalog" ? "catalog" : "available";
  const provider = params.get("provider") || "";
  const q = (params.get("q") || "").toLowerCase();
  const limit = Math.min(500, Number(params.get("limit")) || 100);
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const cur = resolveCurrent(name).current;

  let rows = CATALOG.filter((m) => (scope === "available" ? credentialed.has(m.provider) : true));
  if (provider) rows = rows.filter((m) => m.provider === provider);
  if (q) rows = rows.filter((m) => (m.id + " " + m.name).toLowerCase().includes(q));
  const total = rows.length;
  const page = rows.slice(offset, offset + limit).map((m) => {
    const row = modelRow(m);
    row.current = Boolean(cur && cur.provider === m.provider && cur.id === m.id);
    if (scope === "catalog") {
      row.usable = credentialed.has(m.provider);
      if (row.usable) row.connectedVia = "api_key";
    } else {
      row.connectedVia = "api_key";
    }
    return row;
  });
  return { scope, models: page, total, limit, offset, provider: provider || undefined, q: params.get("q") || undefined };
}

function routeState(name) {
  if (!routing.has(name)) routing.set(name, {});
  const state = routing.get(name);
  const chat = roles.get(name) || resolveCurrent(name).current;
  return {
    roles: ROUTE_ROLES.map(([role, ompRole, label]) => {
      const configured = state[role] || {};
      const primary = role === "chat_model" ? (configured.primary || chat) : configured.primary;
      const view = (binding) => {
        if (!binding) return null;
        const model = CATALOG.find((m) => m.provider === binding.provider && m.id === binding.id);
        return Object.assign(model ? modelRow(model) : { provider: binding.provider, id: binding.id, hasVision: false }, {
          resolved: Boolean(model),
          usable: Boolean(model && credentialed.has(model.provider)),
        });
      };
      return {
        role,
        ompRole,
        label,
        primary: view(primary),
        fallbacks: (configured.fallbacks || []).map(view),
      };
    }),
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","ghosts",...]
  console.error(`${req.method} ${url.pathname}`);

  if (parts[0] !== "api" || parts[1] !== "ghosts") return json(res, 404, { error: "not found" });

  if (parts.length === 2 && req.method === "GET") return json(res, 200, ghosts);

  if (parts.length === 2 && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]*$/iu.test(name)) return json(res, 400, { error: "invalid name" });
    if (ghosts.some((g) => g.name === name)) return json(res, 409, { error: "already exists" });
    const ghost = { name, dir: join(GHOSTS_ROOT, name), createdAt: new Date().toISOString() };
    ghosts.push(ghost);
    return json(res, 201, ghost);
  }

  const name = parts[2] ? decodeURIComponent(parts[2]) : "";
  const ghost = ghosts.find((g) => g.name === name);
  if (!ghost) return json(res, 404, { error: { message: `no ghost named ${name}`, code: "not_found" } });

  // Banishing a ghost. The real daemon moves the home to the XDG trash so it is
  // recoverable from the desktop; the mock just drops it from memory, and
  // answers the same `trash` path so the surfaces see the contract's shape.
  if (parts.length === 3 && req.method === "DELETE") {
    if (url.searchParams.get("confirm") !== name) {
      return json(res, 400, {
        error: { message: "type the ghost's name to confirm", code: "confirmation_required" },
      });
    }
    if (answering.has(name)) {
      return json(res, 409, {
        error: { message: `${name} is still answering — stop the turn first`, code: "ghost_busy" },
      });
    }
    ghosts.splice(ghosts.indexOf(ghost), 1);
    sessionStore.delete(name);
    roles.delete(name);
    routing.delete(name);
    return json(res, 200, { ok: true, trash: join(TRASH_ROOT, name) });
  }

  if (parts[3] === "messages" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    return streamTurn(req, res, name, body);
  }
  if (parts[3] === "greeting" && parts.length === 4 && req.method === "POST") {
    await readBody(req).catch(() => ({}));
    // The delay is the point, not an accident: the real daemon runs a model to
    // write this, so the HUD must paint its static line first and crossfade.
    await new Promise((r) => setTimeout(r, GREETING_MS));
    return json(res, 200, GREETINGS[name] ?? { greeting: null, onboarding: false });
  }
  if (parts[3] === "sessions" && parts.length === 4 && req.method === "GET") {
    const list = [...ghostSessions(name).values()]
      .map(sessionSummary)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return json(res, 200, { sessions: list });
  }
  if (parts[3] === "sessions" && parts.length === 5 && req.method === "DELETE") {
    const deleted = ghostSessions(name).delete(decodeURIComponent(parts[4]));
    return deleted
      ? json(res, 200, { ok: true })
      : json(res, 404, { error: { message: "no such session", code: "not_found" } });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "transcript" && req.method === "GET") {
    const s = ghostSessions(name).get(decodeURIComponent(parts[4]));
    if (!s) return json(res, 404, { error: { message: "no such session", code: "session_not_found" } });
    return json(res, 200, transcriptOf(s));
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "branch" && req.method === "POST") {
    const s = ghostSessions(name).get(decodeURIComponent(parts[4]));
    if (!s) return json(res, 404, { error: { message: "no such session", code: "not_found" } });
    if (answering.has(name)) {
      return json(res, 409, {
        error: { message: `${name} is still answering — stop the turn first`, code: "session_busy" },
      });
    }
    const body = await readBody(req).catch(() => ({}));
    if (body?.action !== "fork") {
      return json(res, 400, { error: { message: "action must be \"fork\"", code: "invalid_branch" } });
    }
    const forked = forkSession(name, s, typeof body?.entryId === "string" ? body.entryId : "");
    return forked
      ? json(res, 200, forked)
      : json(res, 400, { error: { message: "no user message with that entryId", code: "invalid_branch" } });
  }

  // ---- Model indicator + switcher ------------------------------------------
  if (parts[3] === "model" && parts.length === 4 && req.method === "GET") {
    return json(res, 200, resolveCurrent(name));
  }
  if (parts[3] === "models" && parts.length === 4 && req.method === "GET") {
    return json(res, 200, listModels(name, url.searchParams));
  }
  if (parts[3] === "model" && parts.length === 4 && req.method === "PUT") {
    const body = await readBody(req).catch(() => ({}));
    const provider = typeof body?.provider === "string" ? body.provider : "";
    const id = typeof body?.id === "string" ? body.id : "";
    if (!CATALOG.some((m) => m.provider === provider && m.id === id)) {
      return json(res, 400, { error: { message: `unknown model ${provider}/${id}`, code: "unknown_model" } });
    }
    roles.set(name, { provider, id });
    const usable = credentialed.has(provider);
    const { current, source } = resolveCurrent(name);
    return json(res, 200, usable
      ? { ok: true, usable: true, current, source }
      : { ok: true, usable: false, warning: `${provider} is not connected; sign in to use this model`, current, source });
  }
  if (parts[3] === "model-routing" && parts.length === 4 && req.method === "GET") {
    return json(res, 200, routeState(name));
  }
  if (parts[3] === "model-routing" && parts.length === 4 && req.method === "PUT") {
    const body = await readBody(req).catch(() => ({}));
    const definition = ROUTE_ROLES.find(([role]) => role === body?.role);
    if (!definition) return json(res, 400, { error: { message: "unknown role", code: "invalid_request" } });
    if (!routing.has(name)) routing.set(name, {});
    const state = routing.get(name);
    const route = state[body.role] || { primary: null, fallbacks: [] };
    if (body.target === "clear_fallbacks") {
      route.fallbacks = [];
    } else {
      const model = CATALOG.find((m) => m.provider === body.provider && m.id === body.id);
      if (!model) return json(res, 400, { error: { message: "unknown model", code: "unknown_model" } });
      const binding = { provider: model.provider, id: model.id };
      if (body.target === "primary") {
        route.primary = binding;
        if (body.role === "chat_model") roles.set(name, binding);
      } else if (body.target === "fallback") {
        if (!route.fallbacks.some((item) => item.provider === binding.provider && item.id === binding.id))
          route.fallbacks.push(binding);
      } else {
        return json(res, 400, { error: { message: "unknown target", code: "invalid_request" } });
      }
    }
    state[body.role] = route;
    return json(res, 200, routeState(name));
  }

  // ---- Login endpoints -----------------------------------------------------
  if (parts[3] === "providers" && req.method === "GET") {
    return json(res, 200, { providers: PROVIDERS });
  }
  if (parts[3] === "login" && parts.length === 4 && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const providerId = typeof body?.providerId === "string" ? body.providerId : "";
    const authType = body?.authType === "api_key" ? "api_key" : "oauth";
    if (!PROVIDERS.some((p) => p.id === providerId && p.authTypes.includes(authType))) {
      return json(res, 400, { error: { message: "unknown provider", code: "unknown_provider" } });
    }
    return json(res, 201, startLogin(providerId, authType));
  }
  if (parts[3] === "login" && parts.length === 5 && req.method === "GET") {
    const session = logins.get(parts[4]);
    if (!session) return json(res, 404, { error: { message: "no such login", code: "login_not_found" } });
    return json(res, 200, session.view);
  }
  if (parts[3] === "login" && parts.length === 6 && parts[5] === "input" && req.method === "POST") {
    const session = logins.get(parts[4]);
    if (!session) return json(res, 404, { error: { message: "no such login", code: "login_not_found" } });
    if (session.view.status === "succeeded" || session.view.status === "failed") {
      return json(res, 409, { error: { message: "login already settled", code: "login_settled" } });
    }
    const body = await readBody(req).catch(() => ({}));
    const value = typeof body?.value === "string" ? body.value : "";
    return json(res, 200, loginInput(session, value));
  }

  return json(res, 404, { error: "not found" });
}).listen(PORT, HOST, () => {
  console.error(`mock-ghostd on http://${HOST}:${PORT} — ghosts: ${ghosts.map((g) => g.name).join(", ")}`);
});
