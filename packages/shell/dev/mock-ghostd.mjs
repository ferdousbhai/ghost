#!/usr/bin/env node
/**
 * mock-ghostd — just enough of the CONTRACTS.md daemon API to build and demo
 * the Quickshell surfaces without pi, models, or a real ghost home.
 *
 * Implements:
 *   GET  /api/ghosts                          → [{ name, dir, createdAt }]
 *   POST /api/ghosts { name }                 → 201 + the new ghost
 *   POST /api/ghosts/:name/messages           → pi-messages SSE (canned reply)
 *   GET  /api/ghosts/:name/sessions           → { sessions: [...] }, newest first
 *   GET  /api/ghosts/:name/sessions/:id/transcript → { id, title, messages }
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
        { role: "user", content: "hello, who lives here?", timestamp: now - 7_200_000 },
        { role: "assistant", content: `I'm **${name}**. This thread was seeded by the mock so resume has history to show.`, timestamp: now - 7_195_000 },
      ],
    };
    const untitled = {
      id: `sess-${name}-2`,
      title: null, // background titling hasn't run — exercises the fallback label
      createdAt: new Date(now - 600_000).toISOString(),
      updatedAt: new Date(now - 600_000).toISOString(),
      messages: [
        { role: "user", content: "quick question about memory", timestamp: now - 600_000 },
        { role: "assistant", content: "Ask away — this is the untitled seed conversation.", timestamp: now - 595_000 },
      ],
    };
    seed.set(titled.id, titled);
    seed.set(untitled.id, untitled);
    sessionStore.set(name, seed);
  }
  return sessionStore.get(name);
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
  s.messages.push({ role: "user", content: prompt, timestamp: now });
  s.messages.push({ role: "assistant", content: assistantText, timestamp: now });
  s.updatedAt = new Date(now).toISOString();
  // Background titling after the first turn: derive a title from the prompt.
  if (!s.title) s.title = prompt.slice(0, 40) || "New conversation";
}

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

/** A scripted turn: one tool call, then a two-paragraph answer. */
function* script(name, prompt) {
  yield { type: "start" };
  yield { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read_memory" };
  yield { type: "toolcall_delta", contentIndex: 0, delta: '{"query":"' };
  yield { type: "toolcall_delta", contentIndex: 0, delta: `${prompt.slice(0, 24)}"}` };
  yield {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: { type: "toolCall", id: "call_1", name: "read_memory", arguments: { query: prompt.slice(0, 24) } },
  };
  yield { type: "text_start", contentIndex: 1 };
  const reply =
    `You said: **${prompt}**\n\n`
    + `I am ${name}, a mock ghost. I live entirely in this dev harness — no pi session, `
    + `no model, no memory files. The real daemon streams the same pi-messages events, `
    + `so whatever renders here renders there.\n\n`
    + `Visitors get their own memory scope; this mock has none.`;
  for (const chunk of reply.match(/\s*\S+/gu) ?? []) {
    yield { type: "text_delta", contentIndex: 1, delta: chunk };
  }
  yield { type: "text_end", contentIndex: 1, content: reply };
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
  for (const event of events) {
    if (closed) return;
    if (event.type === "text_end") assistantText = event.content;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    await new Promise((r) => setTimeout(r, event.type === "text_delta" ? DELTA_MS : 220));
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
  ["title_model", "title", "Titles"],
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
  if (!ghost) return json(res, 404, { error: `no ghost named ${name}` });

  if (parts[3] === "messages" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    return streamTurn(req, res, name, body);
  }
  if (parts[3] === "sessions" && parts.length === 4 && req.method === "GET") {
    const list = [...ghostSessions(name).values()]
      .map(sessionSummary)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return json(res, 200, { sessions: list });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "transcript" && req.method === "GET") {
    const s = ghostSessions(name).get(decodeURIComponent(parts[4]));
    if (!s) return json(res, 404, { error: { message: "no such session", code: "session_not_found" } });
    return json(res, 200, { id: s.id, title: s.title ?? null, messages: s.messages });
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
