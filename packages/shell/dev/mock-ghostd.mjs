#!/usr/bin/env node
/**
 * In-memory shell demo backend. Only an owned temporary Markdown fixture
 * touches disk, and it is removed on exit. Authentication is intentionally not
 * enforced here; auth behavior is tested against the real daemon.
 *
 * A prompt starting with "!" runs as the owner's own command, the way the
 * daemon streams one: a `bash` tool card and no reply.
 */
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(opt("--port", process.env.GHOSTD_PORT ?? "7717"));
const HOST = "127.0.0.1";
const SESSION_CWD = homedir();
const DELTA_MS = flag("--slow") ? 30 : 12;
const TOOL_STEPS = Math.max(1, Math.min(100, Number(opt("--tool-steps", "1")) || 1));
/**
 * The agent CLIs the mock pretends are installed, in Omarchy's order; codex
 * has no room in its usage windows. A turn runs on the conversation's chosen
 * agent, then the ghost's default, then Omarchy's.
 */
const MOCK_HARNESSES = [
  {
    id: "claude", eligible: true, reason: null,
    usage: { updatedAt: new Date().toISOString(), stale: false, status: "ok",
      windows: [{ label: "5h", percent: 42, resetsAt: new Date(Date.now() + 7_200_000).toISOString() }] },
  },
  {
    id: "codex", eligible: false, reason: "weekly window is full",
    usage: { updatedAt: new Date().toISOString(), stale: false, status: "ok",
      windows: [{ label: "weekly", percent: 100, resetsAt: new Date(Date.now() + 172_800_000).toISOString() }] },
  },
  { id: "pi", eligible: true, reason: null, usage: null },
];
const OMARCHY_DEFAULT_HARNESS = "claude";
/** ghost name -> its own default agent; absent means automatic. */
const ghostDefaultHarness = new Map();
/** turnKey -> the agent picked for a conversation the mock has not stored yet. */
const draftHarness = new Map();
const knownHarness = (id) => MOCK_HARNESSES.some((h) => h.id === id);
const harnessSnapshot = (name) => ({
  harnesses: MOCK_HARNESSES,
  ghostDefault: ghostDefaultHarness.get(name) ?? null,
  omarchyDefault: OMARCHY_DEFAULT_HARNESS,
});
const OWNS_GHOSTS_ROOT = !process.env.GHOSTS_ROOT;
const GHOSTS_ROOT = process.env.GHOSTS_ROOT
  || mkdtempSync(join(tmpdir(), "ghost-shell-mock-"));
const TRASH_ROOT = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "Trash", "files");
const REMOTE_HOSTNAME = "omarchy-thinkpad.tail58bdd3.ts.net";
const REMOTE_PROBLEM = opt(
  "--remote-problem",
  process.env.GHOST_REMOTE_PROBLEM ?? process.env.REMOTE_PROBLEM ?? "",
);

// Each problem breaks the Tailscale capability ladder at one rung; the rungs
// below it stay true.
const REMOTE_LADDER = ["installed", "running", "loggedIn", "operator"];
const REMOTE_PROBLEMS = {
  tailscale_missing: {
    message: "Tailscale is not installed.",
    action: "omarchy-install-service-tailscale",
    breaks: "installed",
  },
  tailscale_stopped: {
    message: "Tailscale is installed but not running.",
    breaks: "running",
  },
  not_logged_in: {
    message: "This machine is not logged in to Tailscale.",
    action: "tailscale up",
    breaks: "loggedIn",
  },
  operator_required: {
    message: "Ghost needs permission to manage Tailscale Serve.",
    action: "sudo tailscale set --operator=$USER",
    breaks: "operator",
  },
  serve_failed: {
    message: "tailscale serve failed: mock CLI error",
  },
};

if (REMOTE_PROBLEM !== "" && !Object.hasOwn(REMOTE_PROBLEMS, REMOTE_PROBLEM)) {
  console.error(`unknown --remote-problem=${REMOTE_PROBLEM}; expected ${Object.keys(REMOTE_PROBLEMS).join(", ")}`);
  process.exit(2);
}

let remoteEnabled = false;
// --relay-pairing=482913 starts the mock with a browser waiting for Allow.
let relayPairingCode = opt("--relay-pairing", process.env.GHOST_RELAY_PAIRING ?? "");
function relaySnapshot() {
  return {
    enabled: true,
    connected: false,
    peer: null,
    since: null,
    pairing: relayPairingCode === "" ? null : { code: relayPairingCode, since: new Date().toISOString() },
    protocol: 4,
    path: "/relay",
    url: null,
    pending: 0,
    tokenPath: null,
  };
}

function remoteSnapshot() {
  const { breaks, ...problemFields } = REMOTE_PROBLEMS[REMOTE_PROBLEM] ?? {};
  const cut = REMOTE_LADDER.indexOf(breaks ?? "");
  const tailscale = Object.fromEntries(REMOTE_LADDER.map((rung, index) => [rung, cut < 0 || index < cut]));
  tailscale.certs = tailscale.installed;
  const { loggedIn } = tailscale;
  const problem = REMOTE_PROBLEM === "" ? null : { code: REMOTE_PROBLEM, ...problemFields };
  const available = problem === null;
  return {
    enabled: remoteEnabled,
    state: available ? (remoteEnabled ? "on" : "off") : "unavailable",
    scheme: loggedIn ? "https" : null,
    hostname: loggedIn ? REMOTE_HOSTNAME : null,
    url: available && remoteEnabled ? `https://${REMOTE_HOSTNAME}` : null,
    tailscale,
    guests: "read-only",
    owner: loggedIn ? "owner@example.com" : null,
    problem,
  };
}

const REMOTE_QR_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges">
  <rect width="29" height="29" fill="white"/>
  <path fill="black" d="M2 2h7v7H2zm2 2v3h3V4zm16-2h7v7h-7zm2 2v3h3V4zM2 20h7v7H2zm2 2v3h3v-3zm8-20h2v2h-2zm3 1h2v3h-2zm-4 4h3v2h-3zm5 3h3v3h-3zm-5 3h2v3h-2zm4 2h2v4h-2zm4-5h2v2h-2zm2 3h3v2h-3zm-7 8h3v3h-3zm5-3h2v2h-2zm3 3h3v2h-3zm-8 5h2v2h-2zm4-1h3v2h-3zm5 0h2v2h-2z"/>
</svg>`;

/** @type {{ name: string, dir: string, createdAt: string }[]} */
const ghosts = ["casper", "moaning-myrtle"].map((name) => ({
  name,
  dir: join(GHOSTS_ROOT, name),
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
}));

const conversationEventClients = new Map();

/** The daemon's conversation-id rule: 1–128 of `[A-Za-z0-9._-]`, not led by a dot. */
const validConversationId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u.test(id);

function routeConversation(parts) {
  try {
    const id = decodeURIComponent(parts[4]);
    return validConversationId(id) ? id : null;
  } catch {
    return null;
  }
}

function publishConversationUpdated(name, id, updatedAt = new Date().toISOString()) {
  const event = `data: ${JSON.stringify({ type: "conversation-updated", id, updatedAt })}\n\n`;
  for (const response of conversationEventClients.get(name) ?? []) {
    if (!response.writableEnded) response.write(event);
  }
}

// Raw values stay only in the mock's in-memory store. `mcpSnapshot` mirrors the
// real daemon's sanitized GET response, including names/counts but never the
// argument, environment, header, OAuth, or URL-query values themselves.
const mcpStore = new Map();

function ghostMcp(name) {
  if (!mcpStore.has(name)) {
    mcpStore.set(name, new Map([
      ["local-files", {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/demo"],
        env: { MCP_DEMO_TOKEN: "never-return-this-value" },
        envPolicy: "literal",
        cwd: "/tmp/demo",
      }],
      ["project-api", {
        type: "http",
        url: "https://example.com/mcp?token=never-return-this-query",
        headers: { Authorization: "Bearer never-return-this-header" },
        headerPolicy: "origin-locked",
      }],
      ["legacy-events", {
        type: "sse",
        url: "https://example.com/events",
        enabled: false,
      }],
    ]));
  }
  return mcpStore.get(name);
}

function configuredKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  return keys.length > 0 ? { keys, configured: true } : undefined;
}

function sanitizeRemoteUrl(value) {
  const lower = value.toLowerCase();
  if (value.includes("${")
    || (!lower.startsWith("http://") && !lower.startsWith("https://"))) {
    return "[configured]";
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      return "[configured]";
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of new Set(url.searchParams.keys())) {
      url.searchParams.delete(key);
      url.searchParams.append(key, "[configured]");
    }
    return url.toString();
  } catch {
    return "[configured]";
  }
}

function sanitizeMcpConfig(config) {
  const type = config?.type === "http" || config?.type === "sse" ? config.type : "stdio";
  const shared = {};
  if (typeof config?.timeout === "number") shared.timeout = config.timeout;
  if (config?.requestIdFormat === "string" || config?.requestIdFormat === "number")
    shared.requestIdFormat = config.requestIdFormat;
  if (config?.auth) shared.auth = { type: config.auth.type || "oauth", configured: Boolean(config.auth.credentialId) };
  if (config?.oauth) {
    shared.oauth = {
      configured: Object.keys(config.oauth).length > 0,
      clientIdConfigured: Boolean(config.oauth.clientId),
      clientSecretConfigured: Boolean(config.oauth.clientSecret),
    };
  }
  if (type === "http" || type === "sse") {
    const headers = configuredKeys(config.headers);
    return {
      ...shared,
      type,
      url: sanitizeRemoteUrl(config.url),
      ...(config.headerPolicy === "origin-locked" ? { headerPolicy: config.headerPolicy } : {}),
      ...(headers ? { headers } : {}),
    };
  }
  const environment = configuredKeys(config.env);
  return {
    ...shared,
    type: "stdio",
    command: String(config.command || ""),
    ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
    ...(config.envPolicy === "literal" ? { envPolicy: config.envPolicy } : {}),
    argumentCount: Array.isArray(config.args) ? config.args.length : 0,
    ...(environment ? { environment } : {}),
  };
}

function mcpSnapshot(name) {
  return {
    servers: [...ghostMcp(name)].map(([serverName, config]) => ({
      name: serverName,
      enabled: config.enabled !== false,
      source: "canonical",
      path: "mcp.json",
      config: sanitizeMcpConfig(config),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    skipped: [],
  };
}

function validMcpConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const type = config.type || "stdio";
  if (type === "stdio") return typeof config.command === "string" && config.command.trim() !== "";
  if (type === "http" || type === "sse") return typeof config.url === "string" && config.url.trim() !== "";
  return false;
}

/** The daemon's character cap (MAX_CHARACTER_BODY_LENGTH); shells must read
    it from responses, never pin it. */
const CHARACTER_LIMIT = 20000;
/** Per-ghost owner-written persona, layered over the seeded character.md. */
const writtenCharacter = new Map();

function characterBodyFor(name) {
  if (writtenCharacter.has(name)) return writtenCharacter.get(name);
  // Matches what seedMockHome writes to disk.
  return `# ${name}\n\nI am ${name}, a quiet local ghost who answers directly.\n`;
}

function seedMockHome(name) {
  const dir = join(GHOSTS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "character.md"),
    `# ${name}\n\nI am ${name}, a quiet local ghost who answers directly.\n`,
    "utf8",
  );
}

if (OWNS_GHOSTS_ROOT) {
  for (const ghost of ghosts) seedMockHome(ghost.name);
  process.once("exit", () => rmSync(GHOSTS_ROOT, { recursive: true, force: true }));
  const stop = () => process.exit(0);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

// The daemon persists a ghost's conversations; the mock keeps them in memory.
// Each ghost is seeded with a titled thread and an untitled one (title === null
// exercises the HUD's fallback). A turn appends to its conversation and, on
// the first turn, "titles" it like the real daemon.

/** @type {Map<string, Map<string, { id, title, harness, createdAt, updatedAt, messages }>>} */
const sessionStore = new Map();

// Persisted messages carry an `entryId` and the `parentId` before it; opaque
// and monotonic here, as in a real transcript.
let entrySeq = 0;
function append(s, message) {
  const parentId = s.messages.at(-1)?.entryId ?? null;
  s.messages.push({ ...message, entryId: `entry-${++entrySeq}`, parentId });
}

function seedSession(fields, messages) {
  const s = { ...fields, messages: [] };
  for (const message of messages) append(s, message);
  return s;
}

function ghostSessions(name) {
  if (!sessionStore.has(name)) {
    const now = Date.now();
    // A failed tool call and a failed turn are rehydrate-only surfaces: no
    // scripted turn produces them, so unless they are in the seed there is
    // nothing to open. `content` as an ordered part list is the stored shape
    // that can carry a tool call (TurnBlocks.partsOf); a plain string cannot.
    const titled = seedSession({
      id: `sess-${name}-1`,
      title: "first contact",
      harness: "claude",
      createdAt: new Date(now - 7_200_000).toISOString(),
      updatedAt: new Date(now - 3_600_000).toISOString(),
    }, [
      { role: "user", content: "hello, who lives here?", timestamp: now - 7_200_000 },
      { role: "assistant", content: [{ type: "text", text: `I'm **${name}**. This thread was seeded by the mock so resume has history to show.` }], timestamp: now - 7_195_000 },
      { role: "user", content: "open the current project brief and tell me what's left", timestamp: now - 3_608_000 },
      {
        role: "assistant",
        timestamp: now - 3_607_000,
        content: [
          { type: "text", text: "Opening the current project brief" },
          // A restored call has no live intent and no summary, so the card
          // falls back to the arguments: they have to say what it was for.
          {
            type: "toolCall",
            id: "call-seed-read",
            name: "Read",
            arguments: { file_path: join(SESSION_CWD, "project-brief.md") },
            failed: true,
          },
          { type: "text", text: "The brief isn't where I expected, so I stopped there." },
        ],
      },
    ]);
    const untitled = seedSession({
      id: `sess-${name}-2`,
      title: null, // titling hasn't run — exercises the fallback label
      harness: "codex",
      createdAt: new Date(now - 600_000).toISOString(),
      updatedAt: new Date(now - 600_000).toISOString(),
    }, [
      { role: "user", content: "quick question about memory", timestamp: now - 600_000 },
      { role: "assistant", content: [], errorMessage: "codex usage limit reached", timestamp: now - 595_000 },
    ]);
    sessionStore.set(name, new Map([[titled.id, titled], [untitled.id, untitled]]));
  }
  return sessionStore.get(name);
}

const transcriptOf = (s, params) => {
  const limitValue = params?.get("limit");
  const offsetValue = params?.get("offset");
  const requestedLimit = limitValue === null || limitValue === undefined
    ? undefined : Number(limitValue);
  const requestedOffset = offsetValue === null || offsetValue === undefined
    ? undefined : Number(offsetValue);
  const limit = requestedLimit === undefined ? 1000
    : Math.max(1, Math.min(2000, Math.floor(requestedLimit)));
  const offset = Math.min(s.messages.length,
    requestedOffset === undefined || requestedOffset < 0
      ? 0 : Math.floor(requestedOffset));
  const messages = s.messages.slice(offset, offset + limit);
  return {
    id: s.id,
    title: s.title ?? null,
    harness: s.harness ?? null,
    messages,
    total: s.messages.length,
    truncated: offset > 0 || offset + messages.length < s.messages.length,
    historyTruncated: s.historyTruncated === true,
  };
};

const firstLine = (text) => String(text).split("\n")[0].slice(0, 120);

const sessionSummary = (s) => {
  const first = s.messages.find((m) => m.role === "user" && typeof m.content === "string");
  return {
    id: s.id,
    title: s.title ?? null,
    preview: first ? firstLine(first.content) : null,
    harness: s.harness ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    // Pin state is in the listing shape; the pin route itself is not mocked, so
    // nothing here ever flips it and the listing order is plain newest-first.
    pinned: s.pinned === true,
    unread: !s.readAt || s.updatedAt > s.readAt,
  };
};

/** Persist one turn's exchanges: `[{ prompt, reply }]`, follow-ups after the first. */
function recordTurn(name, id, exchanges) {
  if (!validConversationId(id)) return;
  const store = ghostSessions(name);
  const now = Date.now();
  let s = store.get(id);
  if (!s) {
    // A brand-new conversation the HUD minted: the daemon creates it lazily here.
    s = { id, title: null, createdAt: new Date(now).toISOString(), messages: [] };
    store.set(id, s);
  }
  for (const { prompt, reply } of exchanges) {
    append(s, { role: "user", content: prompt, timestamp: now });
    append(s, { role: "assistant", content: [{ type: "text", text: reply }], timestamp: now });
  }
  s.harness = s.harness ?? draftHarness.get(turnKey(name, id))
    ?? ghostDefaultHarness.get(name) ?? OMARCHY_DEFAULT_HARNESS;
  draftHarness.delete(turnKey(name, id));
  s.updatedAt = new Date(now).toISOString();
  // Titling after the first turn: derive a title from the prompt.
  if (!s.title) s.title = exchanges[0]?.prompt.slice(0, 40) || "New conversation";
  publishConversationUpdated(name, id, s.updatedAt);
}

/** Ghosts that have no character yet; their scripted turn writes one. */
const ONBOARDING = new Set(["moaning-myrtle"]);

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

// The daemon's hooks.json, kept as one document the way ghostd does, with
// its status projection derived from it. The loader's shape check is the
// small subset a pane edit can plausibly trip, worded the way ghostd words it.
const HOOKS_CONFIG_PATH = "/home/owner/.config/ghost/hooks.json";
const HOOK_EVENTS = ["before_prompt", "session_stop"];
let hooksDocument = {
  hooks: {
    before_prompt: [{ hooks: [{
      type: "command",
      command: "/home/owner/.local/bin/prompt-context",
      name: "Prompt context",
      description: "Adds bounded guidance before an owner prompt.",
      timeout: 10,
    }] }],
    session_stop: [{ hooks: [{
      type: "command",
      command: "/home/owner/.local/bin/completion-check",
      name: "Completion check",
      description: "Reviews the current assistant pass before it settles.",
    }] }],
  },
};
function hooksDocumentProblem(document) {
  const path = HOOKS_CONFIG_PATH;
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return `${path} must contain a JSON object.`;
  }
  const builtin = document.builtin;
  if (builtin !== undefined) {
    if (builtin === null || typeof builtin !== "object" || Array.isArray(builtin)) return `${path}: "builtin" must be an object.`;
    for (const key of Object.keys(builtin)) {
      if (!/^[a-z][a-z0-9_]*$/u.test(key)) return `${path}: builtin key ${JSON.stringify(key)} must match [a-z][a-z0-9_]*.`;
      return `${path}: unsupported builtin key ${JSON.stringify(key)}.`;
    }
  }
  const hooks = document.hooks;
  if (hooks === undefined) return null;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return `${path}: "hooks" must be an object.`;
  for (const event of Object.keys(hooks)) {
    if (!HOOK_EVENTS.includes(event)) return `${path}: unsupported hook event ${JSON.stringify(event)}.`;
    if (!Array.isArray(hooks[event])) return `${path}: "hooks.${event}" must be an array.`;
    for (const [g, group] of hooks[event].entries()) {
      if (!group || !Array.isArray(group.hooks)) return `${path}: hooks.${event}[${g}].hooks must be an array.`;
      for (const [h, handler] of group.hooks.entries()) {
        const label = `hooks.${event}[${g}].hooks[${h}]`;
        if (handler?.type !== "command" || typeof handler.command !== "string" || !handler.command.trim()
            || handler.command.includes("\0")) {
          return `${path}: ${label} must be a command hook with a non-empty NUL-free command.`;
        }
        for (const [field, max] of [["name", 80], ["description", 240]]) {
          const value = handler[field];
          if (value !== undefined && (typeof value !== "string" || !value.trim() || value.trim().length > max)) {
            return `${path}: ${label}.${field} must be a non-empty string of at most ${max} characters.`;
          }
        }
        if (handler.timeout !== undefined && !(typeof handler.timeout === "number" && handler.timeout > 0 && handler.timeout <= 600)) {
          return `${path}: ${label}.timeout must be a number in (0, 600].`;
        }
      }
    }
  }
  return null;
}

function hooksStatus() {
  const rows = [];
  for (const event of HOOK_EVENTS) {
    for (const group of hooksDocument.hooks?.[event] ?? []) {
      for (const handler of group.hooks) {
        const trigger = event === "before_prompt" ? "Before-prompt" : "Session-stop";
        rows.push({
          event,
          name: handler.name ?? `${trigger} command hook`,
          description: handler.description ?? (event === "before_prompt"
            ? "Adds context before the owner prompt is sent."
            : "Runs after the assistant pass and may continue it."),
        });
      }
    }
  }
  const events = HOOK_EVENTS
    .map((event) => ({ event, count: rows.filter((row) => row.event === event).length }))
    .filter(({ count }) => count > 0);
  return { active: rows.length > 0, total: rows.length, events, hooks: rows };
}

const svg = (res, body) => {
  res.writeHead(200, {
    "content-type": "image/svg+xml",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
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

/** A finished tool call: the start/end pair the daemon brackets every call with. */
function* toolCall(id, toolName, args, intent, summary) {
  yield { type: "tool_execution_start", id, toolName, arguments: args, cwd: SESSION_CWD, intent };
  yield { type: "tool_execution_end", id, toolName, isError: false, summary };
}

function* textBlock(contentIndex, text) {
  yield { type: "text_start", contentIndex };
  for (const chunk of text.match(/\s*\S+/gu) ?? []) {
    yield { type: "text_delta", contentIndex, delta: chunk };
  }
  yield { type: "text_end", contentIndex, content: text };
}

/**
 * The owner's own `!command`: the daemon streams it as a `bash` tool card and
 * ends the turn with no reply.
 */
function* ownerCommand(command) {
  yield { type: "start" };
  const id = "owner-command";
  yield {
    type: "tool_execution_start",
    id,
    toolName: "bash",
    arguments: { command, excludeFromContext: false },
    cwd: SESSION_CWD,
    intent: "Run a local command",
  };
  yield { type: "tool_execution_update", id, toolName: "bash", summary: `mock output of ${command}` };
  yield { type: "tool_execution_end", id, toolName: "bash", isError: false, summary: `mock output of ${command}` };
  yield { type: "done", reason: "stop" };
}

/**
 * A scripted pass: the ghost narrating itself, one tool call — two for a ghost
 * still being written — then a two-paragraph answer. Follow-ups queued while
 * it runs are drained by `pump` before the terminal event.
 */
function* script(name, prompt) {
  let contentIndex = 0;
  yield { type: "start" };
  // The preamble a real model emits before reaching for a tool. It belongs
  // beside the orb, never in the reading column, so this is what the HUD's
  // split (qml/services/TurnBlocks.js) has to get right.
  yield* textBlock(contentIndex++, "Checking what I remember about that");
  // Tool calls take no content index; the daemon numbers text blocks only.
  yield* toolCall("call_1", "Grep", { pattern: prompt.slice(0, 24) },
    "Read the relevant note", "Note checked");
  for (let step = 1; step < TOOL_STEPS; step++) {
    const toolName = step % 3 === 0 ? "Grep" : (step % 3 === 1 ? "Read" : "Glob");
    yield* toolCall(`call_long_${step}`, toolName,
      { step: step + 1, file_path: join(SESSION_CWD, `step-${step + 1}.md`) },
      `Run tool-heavy step ${step + 1}`, `Completed step ${step + 1}`);
  }
  // A ghost with no character writes one during the turn with the same
  // native file tool the real harnesses use.
  if (ONBOARDING.has(name)) {
    const content = `# ${name}\n\nDrafted in the dev harness, from: ${prompt.slice(0, 40)}`;
    const path = join(GHOSTS_ROOT, name, "character.md");
    yield* toolCall("call_2", "Write", { file_path: path, content },
      "Write my character", "Character written");
  }
  const reply =
    `You said: **${prompt}**\n\n`
    + `I am ${name}, a mock ghost. I live entirely in this dev harness — no agent CLI, `
    + `no model, no memory files. The real daemon streams the same turn events, `
    + `so whatever renders here renders there.`;
  yield* textBlock(contentIndex++, reply);
}

const answering = new Set();
const activeTurns = new Map();
const turnKey = (name, sessionId) => JSON.stringify([name, sessionId]);
const ghostIsAnswering = (name) => [...answering].some((key) => {
  try {
    return JSON.parse(key)[0] === name;
  } catch {
    return false;
  }
});

function openStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-ghost-turn-id": req.headers["x-ghost-turn-id"] ?? crypto.randomUUID(),
  });
  const keepalive = flag("--stall-stream") ? null : setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);
  const stream = { closed: false };
  res.on("close", () => {
    stream.closed = true;
    clearInterval(keepalive);
  });
  return stream;
}

/**
 * Drive scripted events onto an SSE response. Returns the reply text, or null
 * if the client left mid-stream.
 */
async function pump(res, events, stream) {
  let reply = "";
  for (const event of events) {
    if (stream.closed) return null;
    if (event.type === "text_end") reply = event.content;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    await new Promise((r) => setTimeout(r, event.type === "text_delta" ? DELTA_MS : 220));
  }
  return reply;
}

async function streamTurn(req, res, name, body) {
  const prompt = extractPrompt(body);
  const sessionId = body.options.sessionId;
  const stream = openStream(req, res);
  const key = turnKey(name, sessionId);
  const turn = { streaming: true, followUp: [] };
  activeTurns.set(key, turn);
  answering.add(key);
  const exchanges = [];
  let failed = false;
  try {
    if (prompt.startsWith("!")) {
      if (await pump(res, ownerCommand(prompt.slice(1).trim()), stream) === null) return;
      res.end();
      return;
    }
    let reply = await pump(res, script(name, prompt), stream);
    if (reply === null) return;
    exchanges.push({ prompt, reply });
    // A queued follow-up runs after the current pass: the daemon announces it
    // with owner_message, then streams the pass that answers it.
    while (turn.followUp.length > 0) {
      const text = turn.followUp.shift();
      res.write(`data: ${JSON.stringify({ type: "owner_message", text })}\n\n`);
      reply = await pump(res, textBlock(0, `Following up on **${text}**.`), stream);
      if (reply === null) return;
      exchanges.push({ prompt: text, reply });
    }
    if (flag("--stall-stream")) {
      await new Promise((resolve) => res.once("close", resolve));
      return;
    }
    if (!flag("--omit-terminal")) {
      failed = flag("--fail");
      res.write(`data: ${JSON.stringify(failed
        ? { type: "error", reason: "error", errorMessage: "mock-ghostd --fail" }
        : { type: "done", reason: "stop" })}\n\n`);
    }
    res.end();
  } finally {
    answering.delete(key);
    turn.streaming = false;
    activeTurns.delete(key);
  }
  // Persist the completed turn so the listing and transcript reflect it,
  // matching the daemon's lazy-create-and-title behaviour. A --fail turn wrote
  // no reply, so nothing is recorded.
  if (!failed) recordTurn(name, sessionId, exchanges);
}

function extractPrompt(body) {
  const messages = body?.context?.messages;
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  if (typeof last?.content === "string") return last.content;
  if (Array.isArray(last?.content)) {
    return last.content.filter((p) => p?.type === "text").map((p) => p.text).join(" ");
  }
  return "(no prompt)";
}

const mockServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","ghosts",...]
  console.error(`${req.method} ${url.pathname}`);

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "hooks" && parts[2] === "config") {
    if (req.method === "GET") return json(res, 200, { path: HOOKS_CONFIG_PATH, document: hooksDocument });
    if (req.method !== "PUT") return json(res, 405, {
      error: { code: "method_not_allowed", message: `${req.method} is not allowed here.` },
    });
    const body = await readBody(req).catch(() => null);
    const problem = hooksDocumentProblem(body);
    if (problem) return json(res, 400, { error: { code: "invalid_request", message: problem } });
    hooksDocument = body;
    return json(res, 200, { path: HOOKS_CONFIG_PATH, document: hooksDocument });
  }
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "hooks") {
    if (req.method !== "GET") return json(res, 405, {
      error: { code: "method_not_allowed", message: `${req.method} is not allowed here.` },
    });
    return json(res, 200, hooksStatus());
  }

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "relay" && parts[2] === "status") {
    return json(res, 200, relaySnapshot());
  }
  if (parts.length === 3 && parts[0] === "api" && parts[1] === "relay" && parts[2] === "pair") {
    if (req.method !== "POST") return json(res, 405, {
      error: { code: "method_not_allowed", message: `${req.method} is not allowed here.` },
    });
    const body = await readBody(req).catch(() => null);
    if (typeof body?.code !== "string" || typeof body?.allow !== "boolean") {
      return json(res, 400, { error: { code: "invalid_request", message: '"code" and "allow" are required' } });
    }
    if (relayPairingCode === "" || body.code !== relayPairingCode) {
      return json(res, 404, { error: { code: "pairing_not_found", message: "No browser is waiting to pair with that code." } });
    }
    relayPairingCode = "";
    return json(res, 200, { ok: true, outcome: body.allow ? "paired" : "denied", ...relaySnapshot() });
  }
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "remote") {
    if (req.method === "GET") return json(res, 200, remoteSnapshot());
    if (req.method !== "POST") return json(res, 405, {
      error: { code: "method_not_allowed", message: `${req.method} is not allowed here.` },
    });
    const body = await readBody(req).catch(() => null);
    if (typeof body?.enabled !== "boolean") {
      return json(res, 400, {
        error: { code: "invalid_request", message: '"enabled" must be a boolean' },
      });
    }
    remoteEnabled = body.enabled;
    return json(res, 200, remoteSnapshot());
  }

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "remote"
      && parts[2] === "qr.svg") {
    if (req.method !== "GET") return json(res, 405, {
      error: { code: "method_not_allowed", message: `${req.method} is not allowed here.` },
    });
    const status = remoteSnapshot();
    if (!status.enabled || status.state !== "on" || !status.url) {
      return json(res, 404, {
        error: { code: "remote_off", message: "Remote access is off." },
      });
    }
    return svg(res, REMOTE_QR_SVG);
  }

  if (parts[0] !== "api" || parts[1] !== "ghosts") return json(res, 404, { error: "not found" });

  if (parts.length === 2 && req.method === "GET") return json(res, 200, ghosts);

  if (parts.length === 2 && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]*$/iu.test(name)) return json(res, 400, { error: "invalid name" });
    if (ghosts.some((g) => g.name === name)) return json(res, 409, { error: "already exists" });
    const ghost = { name, dir: join(GHOSTS_ROOT, name), createdAt: new Date().toISOString() };
    ghosts.push(ghost);
    if (OWNS_GHOSTS_ROOT) seedMockHome(name);
    return json(res, 201, ghost);
  }

  const name = parts[2] ? decodeURIComponent(parts[2]) : "";
  const ghost = ghosts.find((g) => g.name === name);
  if (!ghost) return json(res, 404, { error: { message: `no ghost named ${name}`, code: "not_found" } });

  if (parts[3] === "events" && parts.length === 4 && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": keepalive\n\n");
    const clients = conversationEventClients.get(name) ?? new Set();
    clients.add(res);
    conversationEventClients.set(name, clients);
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 15_000);
    res.on("close", () => {
      clearInterval(keepalive);
      clients.delete(res);
      if (clients.size === 0) conversationEventClients.delete(name);
    });
    return;
  }


  if (parts.length === 4 && parts[3] === "character" && req.method === "GET") {
    return json(res, 200, { body: characterBodyFor(name), limit: CHARACTER_LIMIT });
  }
  if (parts.length === 4 && parts[3] === "character" && req.method === "PUT") {
    const payload = await readBody(req).catch(() => ({}));
    const body = typeof payload?.body === "string" ? payload.body : null;
    if (body === null) {
      return json(res, 400, {
        error: { message: '"body" must be a string.', code: "invalid_request" },
      });
    }
    if (body.length > CHARACTER_LIMIT) {
      return json(res, 400, {
        error: {
          message: `character.md is limited to ${CHARACTER_LIMIT} characters.`,
          code: "limit_exceeded",
        },
      });
    }
    writtenCharacter.set(name, body);
    if (OWNS_GHOSTS_ROOT) writeFileSync(join(ghost.dir, "character.md"), body, "utf8");
    return json(res, 200, { ok: true, limit: CHARACTER_LIMIT });
  }

  // recoverable from the desktop; the mock just drops it from memory, and
  // answers the same `trash` path so the surfaces see the contract's shape.
  if (parts.length === 3 && req.method === "DELETE") {
    if (url.searchParams.get("confirm") !== name) {
      return json(res, 400, {
        error: { message: "type the ghost's name to confirm", code: "confirmation_required" },
      });
    }
    if (ghostIsAnswering(name)) {
      return json(res, 409, {
        error: { message: `${name} is still answering — stop the turn first`, code: "ghost_busy" },
      });
    }
    if (OWNS_GHOSTS_ROOT) rmSync(ghost.dir, { recursive: true, force: true });
    ghosts.splice(ghosts.indexOf(ghost), 1);
    sessionStore.delete(name);
    writtenCharacter.delete(name);
    ghostDefaultHarness.delete(name);
    mcpStore.delete(name);
    return json(res, 200, { ok: true, trash: join(TRASH_ROOT, name) });
  }

  // Renaming a ghost moves its home directory; conversation ids survive it
  // untouched, so the mock re-keys the ghost's state under the new name rather
  // than rebuilding any of it.
  if (parts.length === 4 && parts[3] === "name" && req.method === "PUT") {
    const body = await readBody(req).catch(() => ({}));
    const next = typeof body?.name === "string" ? body.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]*$/iu.test(next)) {
      return json(res, 400, { error: { message: `${next || "that"} is not a usable ghost name`, code: "invalid_request" } });
    }
    if (next === name) return json(res, 200, { ok: true, name });
    if (ghosts.some((g) => g.name === next)) {
      return json(res, 409, { error: { message: `there is already a ghost called ${next}`, code: "already_exists" } });
    }
    if (ghostIsAnswering(name)) {
      return json(res, 409, {
        error: { message: `${name} is still answering — stop the turn first`, code: "ghost_busy" },
      });
    }
    for (const store of [sessionStore, writtenCharacter, mcpStore, ghostDefaultHarness]) {
      if (store.has(name)) {
        store.set(next, store.get(name));
        store.delete(name);
      }
    }
    if (OWNS_GHOSTS_ROOT) renameSync(ghost.dir, join(GHOSTS_ROOT, next));
    ghost.name = next;
    ghost.dir = join(GHOSTS_ROOT, next);
    return json(res, 200, { ok: true, name: next });
  }

  if (parts[3] === "messages" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const sessionId = body?.options?.sessionId;
    if (!validConversationId(sessionId)) {
      return json(res, 400, { error: { message: "options.sessionId is not a conversation id", code: "invalid_conversation_id" } });
    }
    if (answering.has(turnKey(name, sessionId))) {
      return json(res, 409, {
        error: {
          message: "This ghost is already answering in this conversation",
          code: "session_busy",
        },
      });
    }
    return streamTurn(req, res, name, body);
  }
  if (parts[3] === "mcp" && parts.length === 4 && req.method === "GET") {
    return json(res, 200, mcpSnapshot(name));
  }
  if (parts[3] === "mcp" && parts.length === 4 && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const serverName = typeof body?.name === "string" ? body.name.trim() : "";
    if (!/^[A-Za-z0-9_.-]+$/u.test(serverName) || !validMcpConfig(body?.config)) {
      return json(res, 400, {
        error: { message: "MCP server name or configuration is invalid", code: "invalid_mcp_server" },
      });
    }
    if (ghostMcp(name).has(serverName)) {
      return json(res, 409, {
        error: { message: `MCP server ${serverName} already exists`, code: "mcp_server_exists" },
      });
    }
    // Like ghostd: a newly added server starts disabled unless the row says otherwise.
    ghostMcp(name).set(serverName, { enabled: false, ...structuredClone(body.config) });
    return json(res, 201, mcpSnapshot(name));
  }
  if (parts[3] === "mcp" && parts.length >= 5) {
    const serverName = decodeURIComponent(parts[4]);
    const servers = ghostMcp(name);
    if (!servers.has(serverName)) {
      return json(res, 404, {
        error: { message: `No MCP server named ${serverName}`, code: "mcp_server_not_found" },
      });
    }
    if (parts.length === 5 && req.method === "PUT") {
      const body = await readBody(req).catch(() => ({}));
      if (!validMcpConfig(body?.config)) {
        return json(res, 400, {
          error: { message: "MCP server configuration is invalid", code: "invalid_mcp_server" },
        });
      }
      servers.set(serverName, structuredClone(body.config));
      return json(res, 200, mcpSnapshot(name));
    }
    if (parts.length === 6 && parts[5] === "enabled" && req.method === "PUT") {
      const body = await readBody(req).catch(() => ({}));
      if (typeof body?.enabled !== "boolean") {
        return json(res, 400, {
          error: { message: '"enabled" must be a boolean', code: "invalid_request" },
        });
      }
      servers.set(serverName, { ...servers.get(serverName), enabled: body.enabled });
      return json(res, 200, mcpSnapshot(name));
    }
    if (parts.length === 5 && req.method === "DELETE") {
      servers.delete(serverName);
      return json(res, 200, mcpSnapshot(name));
    }
  }
  if (parts[3] === "harness" && parts.length === 4 && req.method === "GET") {
    return json(res, 200, harnessSnapshot(name));
  }
  if (parts[3] === "harness" && parts.length === 4 && req.method === "PUT") {
    const body = await readBody(req).catch(() => ({}));
    const harness = body?.harness;
    if (harness !== null && !knownHarness(harness)) {
      return json(res, 400, { error: { message: `no installed agent called ${harness}`, code: "unknown_harness" } });
    }
    if (harness === null) ghostDefaultHarness.delete(name);
    else ghostDefaultHarness.set(name, harness);
    return json(res, 200, harnessSnapshot(name));
  }
  // A conversation's next turn runs on the picked agent; a draft the HUD
  // minted is not stored yet, so its pick waits for its first turn.
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "harness" && req.method === "PUT") {
    const body = await readBody(req).catch(() => ({}));
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (!knownHarness(body?.harness)) {
      return json(res, 400, { error: { message: `no installed agent called ${body?.harness}`, code: "unknown_harness" } });
    }
    const s = ghostSessions(name).get(conversation);
    if (s) {
      s.harness = body.harness;
      publishConversationUpdated(name, s.id, s.updatedAt);
    } else {
      draftHarness.set(turnKey(name, conversation), body.harness);
    }
    return json(res, 200, { id: conversation, harness: body.harness });
  }
  if (parts[3] === "sessions" && parts.length === 4 && req.method === "GET") {
    const list = [...ghostSessions(name).values()]
      .map(sessionSummary)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return json(res, 200, { sessions: list });
  }
  if (parts[3] === "sessions" && parts.length === 5 && req.method === "DELETE") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const deleted = ghostSessions(name).delete(conversation);
    if (deleted) publishConversationUpdated(name, conversation);
    return deleted
      ? json(res, 200, { ok: true })
      : json(res, 404, { error: { message: "no such session", code: "not_found" } });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "read" && req.method === "PUT") {
    await readBody(req).catch(() => ({}));
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const s = ghostSessions(name).get(conversation);
    if (!s) return json(res, 404, { error: { message: "no such session", code: "not_found" } });
    s.readAt = new Date().toISOString();
    publishConversationUpdated(name, s.id, s.updatedAt);
    return json(res, 200, { ok: true, readAt: s.readAt });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "transcript" && req.method === "GET") {
    for (const field of ["limit", "offset"]) {
      const value = url.searchParams.get(field);
      if (value !== null && !Number.isFinite(Number(value))) {
        return json(res, 400, {
          error: { message: `"${field}" must be a number.`, code: "invalid_request" },
        });
      }
    }
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const s = ghostSessions(name).get(conversation);
    if (!s) {
      return json(res, 404, {
        error: { message: "no such session", code: "session_not_found" },
      });
    }
    return json(res, 200, transcriptOf(s, url.searchParams));
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "queue") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const turn = activeTurns.get(turnKey(name, conversation));
    const snapshot = () => ({
      streaming: turn?.streaming === true,
      count: turn?.followUp.length ?? 0,
      followUp: turn?.followUp ?? [],
    });
    if (req.method === "GET") return json(res, 200, snapshot());
    if (req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (text === "") {
        return json(res, 400, {
          error: { message: "text must not be empty", code: "invalid_request" },
        });
      }
      if (!turn?.streaming) {
        return json(res, 409, {
          error: { message: "this conversation is not streaming", code: "session_not_streaming" },
        });
      }
      turn.followUp.push(text);
      return json(res, 200, snapshot());
    }
  }
  // Renaming one conversation. An empty title is how the HUD clears it back to
  // its own "New conversation" label, so it stores as null rather than "".
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "title" && req.method === "PUT") {
    const body = await readBody(req).catch(() => ({}));
    const raw = body?.title;
    // A conversation is renamed, never un-named: there is no "clear it" here,
    // so an emptied field is a refusal rather than a reset to untitled.
    const title = typeof raw === "string" ? raw.trim() : "";
    if (typeof raw !== "string" || title === "") {
      return json(res, 400, { error: { message: '"title" must be a non-empty string', code: "invalid_request" } });
    }
    if (title.length > 120) {
      return json(res, 400, { error: { message: "a title is at most 120 characters", code: "invalid_request" } });
    }
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const s = ghostSessions(name).get(conversation);
    if (!s) return json(res, 404, { error: { message: "no such session", code: "not_found" } });
    s.title = title;
    publishConversationUpdated(name, s.id, s.updatedAt);
    return json(res, 200, { ok: true, title: s.title });
  }
  return json(res, 404, { error: "not found" });
});
mockServer.listen(PORT, HOST, () => {
  const address = mockServer.address();
  const listeningPort = typeof address === "object" && address ? address.port : PORT;
  console.error(`mock-ghostd on http://${HOST}:${listeningPort} — ghosts: ${ghosts.map((g) => g.name).join(", ")}`);
});
