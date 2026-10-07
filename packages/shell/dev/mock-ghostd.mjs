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
  copyFileSync,
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
/** Seconds a next-work countdown shows after each reply (the handoff is skipped); 0 shows none. */
const NEXT_WORK_MS = Math.max(0, Number(opt("--next-work", "0")) || 0) * 1000;
/** How long a session_stop hook decides after each reply; 0 runs none. */
const STOP_HOOK_MS = Math.max(0, Number(opt("--stop-hook", "0")) || 0) * 1000;
/**
 * The agent CLIs the mock pretends are installed, in Omarchy's order; codex
 * has no room in its usage windows. A turn runs on the conversation's chosen
 * agent, then the ghost's default, then Omarchy's.
 */
const MOCK_HARNESSES = [
  {
    id: "claude", eligible: true, reason: null, effort: "low",
    usage: { updatedAt: new Date().toISOString(), stale: false, status: "ok",
      windows: [{ label: "5h", percent: 42, resetsAt: new Date(Date.now() + 7_200_000).toISOString() }] },
  },
  {
    id: "codex", eligible: false, reason: "weekly window is full", effort: "low",
    usage: { updatedAt: new Date().toISOString(), stale: false, status: "ok",
      windows: [{ label: "weekly", percent: 100, resetsAt: new Date(Date.now() + 172_800_000).toISOString() }] },
  },
  { id: "pi", eligible: true, reason: null, effort: "low", usage: null },
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
    pairing: relayPairingCode === "" ? null : { code: relayPairingCode },
    pending: 0,
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

/** @type {{ name: string, dir: string }[]} */
const ghosts = ["casper", "moaning-myrtle"].map((name) => ({ name, dir: join(GHOSTS_ROOT, name) }));

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

// The mock stores only what ghostd's GET /mcp returns: each server's
// sanitized view (sanitizeMcpServerConfig in the daemon's
// mcp-catalog-policy.ts), with key names and counts but never argument,
// environment, header, or URL-query values. The daemon's redaction is not
// repeated here; a write keeps the minimal view `mcpView` derives.
const mcpStore = new Map();

function ghostMcp(name) {
  if (!mcpStore.has(name)) {
    mcpStore.set(name, new Map([
      ["local-files", {
        enabled: true,
        config: {
          type: "stdio",
          command: "npx",
          cwd: "/tmp/demo",
          envPolicy: "literal",
          argumentCount: 3,
          environment: { keys: ["MCP_DEMO_TOKEN"], configured: true },
        },
      }],
      ["project-api", {
        enabled: true,
        config: {
          type: "http",
          url: "https://example.com/mcp?token=%5Bconfigured%5D",
          headerPolicy: "origin-locked",
          headers: { keys: ["Authorization"], configured: true },
        },
      }],
      ["legacy-events", { enabled: false, config: { type: "sse", url: "https://example.com/events" } }],
    ]));
  }
  return mcpStore.get(name);
}

/** A written config as a minimal sanitized view: no value of it is kept. */
function mcpView(config) {
  const keys = (value) => (value && typeof value === "object"
    ? { keys: Object.keys(value).sort(), configured: true } : undefined);
  return config.type === "http" || config.type === "sse"
    ? { type: config.type, url: config.url.replace(/[?#].*$/u, ""), headers: keys(config.headers) }
    : { type: "stdio", command: config.command, argumentCount: config.args?.length ?? 0, environment: keys(config.env) };
}

function mcpSnapshot(name) {
  return {
    servers: [...ghostMcp(name)].map(([serverName, server]) => ({
      name: serverName,
      enabled: server.enabled,
      path: "mcp.json",
      config: server.config,
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

/** @type {Map<string, Map<string, { id, title, harness, updatedAt, messages }>>} */
const sessionStore = new Map();

// Persisted messages carry an `entryId`; opaque and monotonic here, as in a
// real transcript.
let entrySeq = 0;
function append(s, message) {
  s.messages.push({ ...message, entryId: `entry-${++entrySeq}` });
}

/** Message content as the daemon's transcript sends it: an ordered part list, never a bare string. */
const textParts = (text) => [{ type: "text", text }];

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
    // nothing to open. `content` is an ordered part list, the stored shape
    // the daemon always sends.
    const titled = seedSession({
      id: `sess-${name}-1`,
      title: "first contact",
      harness: "claude",
      updatedAt: new Date(now - 3_600_000).toISOString(),
    }, [
      { role: "user", content: textParts("hello, who lives here?") },
      { role: "assistant", content: [{ type: "text", text: `I'm **${name}**. This thread was seeded by the mock so resume has history to show.` }] },
      { role: "user", content: textParts("open the current project brief and tell me what's left") },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Opening the current project brief" },
          // A restored call has no summary, so the card falls back to the
          // arguments: they have to say what it was for.
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
      updatedAt: new Date(now - 600_000).toISOString(),
    }, [
      { role: "user", content: textParts("quick question about memory") },
      { role: "assistant", content: [], errorMessage: "codex usage limit reached" },
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
    messages,
    total: s.messages.length,
    truncated: offset > 0 || offset + messages.length < s.messages.length,
  };
};

const firstLine = (text) => String(text).split("\n")[0].slice(0, 120);

const sessionSummary = (name) => (s) => {
  const first = s.messages.find((m) => m.role === "user");
  return {
    id: s.id,
    title: s.title ?? null,
    preview: s.preview ?? (first ? firstLine(first.content.map((part) => part.text ?? "").join("")) : null),
    harness: s.harness ?? null,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    pinned: s.pinned === true,
    unread: !s.readAt || s.updatedAt > s.readAt,
    running: answering.has(turnKey(name, s.id)),
    continuesAt: s.continuesAt ?? null,
  };
};

/** A finished turn's conversation takes its harness, its time, and a title from its prompt. */
function recordTurn(name, id, prompt) {
  const s = ghostSessions(name).get(id);
  if (!s) return;
  s.harness = s.harness ?? draftHarness.get(turnKey(name, id))
    ?? ghostDefaultHarness.get(name) ?? OMARCHY_DEFAULT_HARNESS;
  draftHarness.delete(turnKey(name, id));
  s.updatedAt = new Date().toISOString();
  // The first owner message titles it; a `!command` never does, as in ghostd.
  if (!s.title && !prompt.startsWith("!")) s.title = prompt.slice(0, 40) || "New conversation";
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
/** `GET /api/status`; `--update` makes it report a newer release. */
const MOCK_VERSION = "0.0.0-mock";
const MOCK_UPDATE = { latest: "0.0.1", command: "ghost update" };

/** `GET /api/board`: readBoard's shape for a small Documents/board.md. */
const MOCK_BOARD = {
  path: join(homedir(), "Documents", "board.md"),
  exists: true,
  modified: new Date().toISOString(),
  title: "Board",
  columns: [
    { title: "Doing", cards: [{ text: "Draft the project brief", done: false, notes: ["owner reviews Friday"] }] },
    { title: "Done", cards: [{ text: "Set up the ghost", done: true, notes: [] }, { text: "A plain card", notes: [] }] },
  ],
  truncated: false,
};

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
    const maxima = { handoff_idle_seconds: 86_400, next_work_turns: 10_000 };
    for (const [key, value] of Object.entries(builtin)) {
      if (!(key in maxima)) return `${path}: unsupported builtin key ${JSON.stringify(key)}.`;
      if (!Number.isInteger(value) || value < 0 || value > maxima[key]) return `${path}: builtin.${key} must be an integer in [0, ${maxima[key]}].`;
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
function* toolCall(id, toolName, args, summary) {
  yield { type: "tool_execution_start", id, toolName, arguments: args, cwd: SESSION_CWD };
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
    arguments: { command },
    cwd: SESSION_CWD,
  };
  yield { type: "tool_execution_update", id, summary: `mock output of ${command}` };
  yield { type: "tool_execution_end", id, toolName: "bash", isError: false, summary: `mock output of ${command}` };
  yield { type: "done" };
}

/**
 * A scripted pass: the ghost narrating itself, one tool call — two for a ghost
 * still being written — then a two-paragraph answer. Follow-ups queued while
 * it runs are drained by `pump` before the terminal event.
 */
function* script(name, prompt) {
  let contentIndex = 0;
  yield { type: "start" };
  // The preamble a real model emits before reaching for a tool: it stays as its
  // own message, and the reply after the call is the next one
  // (qml/services/TurnBlocks.js).
  yield* textBlock(contentIndex++, "Checking what I remember about that");
  // Tool calls take no content index; the daemon numbers text blocks only.
  yield* toolCall("call_1", "Grep", { pattern: prompt.slice(0, 24) }, "Note checked");
  for (let step = 1; step < TOOL_STEPS; step++) {
    const toolName = step % 3 === 0 ? "Grep" : (step % 3 === 1 ? "Read" : "Glob");
    yield* toolCall(`call_long_${step}`, toolName,
      { step: step + 1, file_path: join(SESSION_CWD, `step-${step + 1}.md`) }, `Completed step ${step + 1}`);
  }
  // A ghost with no character writes one during the turn with the same
  // native file tool the real harnesses use.
  if (ONBOARDING.has(name)) {
    const content = `# ${name}\n\nDrafted in the dev harness, from: ${prompt.slice(0, 40)}`;
    const path = join(GHOSTS_ROOT, name, "character.md");
    yield* toolCall("call_2", "Write", { file_path: path, content }, "Character written");
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
const ghostIsAnswering = (name) => [...answering].some((key) => JSON.parse(key)[0] === name);

function openStream(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const keepalive = flag("--stall-stream") ? null : setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);
  // A turn outlives its client, as in ghostd: `closed` only stops the writes,
  // and `stopped` (POST …/stop) ends the turn.
  const stream = { closed: false, stopped: false };
  res.on("close", () => {
    stream.closed = true;
    clearInterval(keepalive);
  });
  return stream;
}

/** Write a frame while the client still listens. */
function send(res, stream, event) {
  if (!stream.closed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Drive scripted events onto an SSE response. Returns the reply text, or null
 * if the turn was stopped.
 */
async function pump(res, events, stream) {
  let reply = "";
  for (const event of events) {
    if (stream.stopped) return null;
    if (event.type === "text_end") reply = event.content;
    send(res, stream, event);
    await new Promise((r) => setTimeout(r, event.type === "text_delta" ? DELTA_MS : 220));
  }
  return reply;
}

async function streamTurn(res, name, body) {
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : "(no prompt)";
  const sessionId = body.sessionId;
  const stream = openStream(res);
  const key = turnKey(name, sessionId);
  // An owner command has no passes, so nothing queues into it.
  const turn = { streaming: !prompt.startsWith("!"), followUp: [], res, stream };
  activeTurns.set(key, turn);
  answering.add(key);
  // Like ghostd, a turn creates its conversation and logs its prompt as it
  // starts (an owner command logs when it ends), so another client sees what
  // is running.
  const store = ghostSessions(name);
  let existing = store.get(sessionId);
  if (!existing && validConversationId(sessionId)) {
    const now = new Date().toISOString();
    existing = { id: sessionId, title: null, updatedAt: now, messages: [] };
    store.set(sessionId, existing);
  }
  // As ghostd's does, a new turn cancels a counting-down next-work turn.
  if (existing?.continuesAt) {
    clearTimeout(existing.continuation);
    existing.continuesAt = null;
  }
  if (existing && !prompt.startsWith("!")) append(existing, { role: "user", content: textParts(prompt) });
  // As in ghostd, the first owner text previews it, a `!command` included.
  if (existing) existing.preview ??= firstLine(prompt);
  if (existing) publishConversationUpdated(name, sessionId);
  const failing = flag("--fail") && !flag("--omit-terminal");
  // Each pass's reply is logged as it ends, as ghostd does: a stopped one as
  // "Turn aborted.", a --fail one with its error.
  const logReply = (reply) => existing && append(existing, reply === null
    ? { role: "assistant", content: [], errorMessage: "Turn aborted." }
    : { role: "assistant", content: textParts(reply), ...(failing ? { errorMessage: "mock-ghostd --fail" } : {}) });
  let stopped = false;
  try {
    if (prompt.startsWith("!")) {
      const command = prompt.slice(1).trim();
      const ran = await pump(res, ownerCommand(command), stream) !== null;
      // ghostd logs the command as it ends; the transcript shows the owner's
      // `!command`, then its output as the ghost's message.
      if (existing) {
        append(existing, { role: "user", content: textParts(prompt) });
        append(existing, { role: "assistant", content: textParts(ran
          ? `\`\`\`\nmock output of ${command}\n\`\`\``
          : `\`\`\`\n\n\`\`\`\n\n(exit signal)`) });
      }
      if (ran) res.end();
    } else {
      let reply = await pump(res, script(name, prompt), stream);
      logReply(reply);
      // After each pass a stop hook decides (never continuing, here); a queued
      // follow-up then runs: the daemon logs and announces it, says
      // owner_message, then streams the pass that answers it.
      while (reply !== null) {
        if (STOP_HOOK_MS > 0 && turn.followUp.length === 0) {
          const hook = { name: "Deciding whether to keep going", event: "session_stop" };
          send(res, stream, { type: "hook_start", ...hook });
          await new Promise((resolve) => setTimeout(resolve, STOP_HOOK_MS));
          send(res, stream, { type: "hook_end", ...hook });
        }
        if (turn.followUp.length === 0) break;
        const text = turn.followUp.shift();
        if (existing) append(existing, { role: "user", content: textParts(text) });
        publishConversationUpdated(name, sessionId);
        send(res, stream, { type: "queue", followUp: turn.followUp });
        send(res, stream, { type: "owner_message", text });
        reply = await pump(res, textBlock(0, `Following up on **${text}**.`), stream);
        logReply(reply);
      }
      stopped = reply === null;
      // A stopped turn already ended its stream with `aborted`.
      if (!stopped) {
        if (flag("--stall-stream")) {
          await new Promise((resolve) => res.once("close", resolve));
          return;
        }
        if (!flag("--omit-terminal")) {
          send(res, stream, failing
            ? { type: "error", reason: "error", errorMessage: "mock-ghostd --fail" }
            : { type: "done" });
        }
        res.end();
      }
    }
  } finally {
    answering.delete(key);
    turn.streaming = false;
    activeTurns.delete(key);
    // Every end announces, as ghostd's does: stopped, failed, or done.
    if (existing) publishConversationUpdated(name, sessionId);
    // --next-work: the countdown ghostd shows after an idle handoff, then its
    // turn; as in ghostd, none follows a turn the owner stopped.
    if (existing && NEXT_WORK_MS > 0 && !prompt.startsWith("!") && !stopped) {
      existing.continuesAt = new Date(Date.now() + NEXT_WORK_MS).toISOString();
      existing.continuation = setTimeout(() => {
        existing.continuesAt = null;
        append(existing, { role: "handoff", content: textParts("Updated plan.md") });
        append(existing, { role: "auto", content: textParts("What should we work on next?") });
        append(existing, { role: "assistant", content: textParts("Next, the **colophon**: it still names the old press.") });
        publishConversationUpdated(name, sessionId);
      }, NEXT_WORK_MS);
      publishConversationUpdated(name, sessionId);
    }
  }
  recordTurn(name, sessionId, prompt);
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
    return json(res, 200, { outcome: body.allow ? "paired" : "denied", ...relaySnapshot() });
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

  if (parts.length === 2 && parts[0] === "api" && parts[1] === "status" && req.method === "GET") {
    return json(res, 200, {
      version: MOCK_VERSION,
      source: { commit: null, root: null },
      update: flag("--update") ? MOCK_UPDATE : null,
    });
  }
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "board" && req.method === "GET") {
    return json(res, 200, MOCK_BOARD);
  }

  if (parts[0] !== "api" || parts[1] !== "ghosts") return json(res, 404, { error: "not found" });

  if (parts.length === 2 && req.method === "GET") return json(res, 200, ghosts);

  if (parts.length === 2 && req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]*$/iu.test(name)) return json(res, 400, { error: "invalid name" });
    if (ghosts.some((g) => g.name === name)) return json(res, 409, { error: "already exists" });
    const ghost = { name, dir: join(GHOSTS_ROOT, name) };
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
    const sessionId = body?.sessionId;
    if (!validConversationId(sessionId)) {
      return json(res, 400, { error: { message: "sessionId is not a conversation id", code: "invalid_conversation_id" } });
    }
    if (answering.has(turnKey(name, sessionId))) {
      return json(res, 409, {
        error: {
          message: "This ghost is already answering in this conversation",
          code: "session_busy",
        },
      });
    }
    return streamTurn(res, name, body);
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
    ghostMcp(name).set(serverName, { enabled: body.config.enabled === true, config: mcpView(body.config) });
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
      // Like ghostd: the written config replaces the row, `enabled` included.
      servers.set(serverName, { enabled: body.config.enabled !== false, config: mcpView(body.config) });
      return json(res, 200, mcpSnapshot(name));
    }
    if (parts.length === 6 && parts[5] === "enabled" && req.method === "PUT") {
      const body = await readBody(req).catch(() => ({}));
      if (typeof body?.enabled !== "boolean") {
        return json(res, 400, {
          error: { message: '"enabled" must be a boolean', code: "invalid_request" },
        });
      }
      servers.get(serverName).enabled = body.enabled;
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
  // The machine-local `{ path }` form of an attachment: the file is copied
  // into the conversation directory, created if the draft has none yet.
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "attachments" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const match = typeof body?.path === "string" && /\.(png|jpe?g|webp|gif)$/iu.exec(body.path);
    if (!match) return json(res, 415, { error: { message: "Attach a PNG, JPEG, WebP, or GIF image.", code: "unsupported_media_type" } });
    const file = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}.${match[1].toLowerCase().replace("jpeg", "jpg")}`;
    const dir = join(ghost.dir, "sessions", conversation, "attachments");
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(body.path, join(dir, file));
    } catch (error) {
      return json(res, 400, { error: { message: `Could not read ${body.path}: ${error.code ?? error}`, code: "invalid_request" } });
    }
    return json(res, 201, { path: `attachments/${file}` });
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
      .map(sessionSummary(name))
      .sort((a, b) => (a.pinned === b.pinned
        ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : (a.pinned ? -1 : 1)));
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
  // Idempotent like the daemon's: the HUD sends the state it wants.
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "pin" && req.method === "PUT") {
    const body = await readBody(req).catch(() => ({}));
    if (typeof body?.pinned !== "boolean") {
      return json(res, 400, { error: { message: '"pinned" must be a boolean.', code: "invalid_request" } });
    }
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const s = ghostSessions(name).get(conversation);
    if (!s) return json(res, 404, { error: { message: "no such session", code: "not_found" } });
    s.pinned = body.pinned;
    publishConversationUpdated(name, s.id, s.updatedAt);
    return json(res, 200, { ok: true, pinned: s.pinned });
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
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "continuation" && req.method === "DELETE") {
    const s = ghostSessions(name).get(routeConversation(parts));
    if (s?.continuesAt) {
      clearTimeout(s.continuation);
      s.continuesAt = null;
      publishConversationUpdated(name, s.id);
    }
    return json(res, 200, { cancelled: true });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "stop" && req.method === "POST") {
    const turn = activeTurns.get(turnKey(name, routeConversation(parts)));
    if (!turn) {
      return json(res, 409, {
        error: { message: "this conversation is not streaming", code: "session_not_streaming" },
      });
    }
    turn.stream.stopped = true;
    if (!turn.stream.closed) turn.res.end(`data: ${JSON.stringify({ type: "error", reason: "aborted", errorMessage: "Turn aborted." })}\n\n`);
    return json(res, 200, { stopped: true });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "queue") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const turn = activeTurns.get(turnKey(name, conversation));
    const snapshot = () => ({
      streaming: turn?.streaming === true,
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
      if (!turn) {
        return json(res, 409, {
          error: { message: "this conversation is not streaming", code: "session_not_streaming" },
        });
      }
      if (!turn.streaming) {
        return json(res, 409, {
          error: { message: "An owner command is running in this conversation; send this when it ends.", code: "session_busy" },
        });
      }
      turn.followUp.push(text);
      send(turn.res, turn.stream, { type: "queue", followUp: turn.followUp });
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
