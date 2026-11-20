#!/usr/bin/env node
/**
 * Shell demo backend. State lives in memory, except what the HUD reads back
 * as files: ghost homes (a temporary root it removes on exit, unless
 * GHOSTS_ROOT names one, in which case it seeds and rewrites no
 * character.md), and copied attachments.
 * Authentication is intentionally not enforced here; auth behavior is tested
 * against the real daemon.
 *
 * A prompt starting with "!" runs as the owner's own command, the way the
 * daemon streams one: a `bash` tool card and no reply.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

// No default port: 7717 is the owner's real ghostd, and a mock there would answer the live HUD.
const PORT = Number(opt("--port", process.env.GHOSTD_PORT ?? ""));
if (opt("--port", process.env.GHOSTD_PORT ?? "") === "" || !Number.isInteger(PORT) || PORT < 0 || PORT > 65_535 || PORT === 7717) {
  console.error("mock-ghostd: pass --port <port> (any but 7717, the real ghostd's)");
  process.exit(2);
}
const HOST = "127.0.0.1";
const SESSION_CWD = homedir();
const DELTA_MS = flag("--slow") ? 30 : 12;
const TOOL_STEPS = Math.max(1, Math.min(100, Number(opt("--tool-steps", "1")) || 1));
/** The first tool call fails, as a nonzero exit does, so its card stays in the reading column. */
const TOOL_ERROR = flag("--tool-error");
/** Where a turn response is cut and resumed, as ghostd cuts at about 1 MB; smaller to exercise it. */
const CUT_BYTES = Math.max(1, Number(opt("--cut-bytes", "1048576")) || 1_048_576);
/** How long a session_stop hook decides after each reply; 0 runs none. */
const STOP_HOOK_MS = Math.max(0, Number(opt("--stop-hook", "0")) || 0) * 1000;
/** Each scripted pass begins with the harness compacting its context, as Claude Code reports. */
const COMPACT = flag("--compact");
/** Each scripted turn ends with the ghost asking the owner a question, as `ghost ask` does. */
const ASK = flag("--ask");
/** `--resting <id>`: that agent rests after a refusal, as ghostd reports one. */
const RESTING = opt("--resting", "");
const resting = (id) => id === RESTING
  ? { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "429 usage limit reached" }
  : null;
/**
 * The agent CLIs the mock pretends are installed, in Omarchy's order, then the
 * configured local model; codex reports a full usage window, which is
 * informational. A turn runs on the conversation's chosen agent, then the
 * ghost's default, then the local model, as ghostd does when `local` is
 * configured.
 */
const MOCK_HARNESSES = [
  {
    id: "claude",
    usage: { updatedAt: new Date().toISOString(), stale: false, status: "ok",
      windows: [{ label: "5h", percent: 0.42, resetsAt: new Date(Date.now() + 7_200_000).toISOString() }] },
    effort: "low",
  },
  {
    id: "codex",
    usage: { updatedAt: new Date().toISOString(), stale: false, status: "ok",
      windows: [{ label: "weekly", percent: 1, resetsAt: new Date(Date.now() + 172_800_000).toISOString() }] },
    effort: "low",
  },
  { id: "pi", usage: null, effort: "low" },
  { id: "local", usage: null, effort: null },
].map((harness) => ({ ...harness, resting: resting(harness.id) }));
const DEFAULT_RUNTIME = "local";
/** ghost name -> its own default agent; absent means automatic. */
const ghostDefaultHarness = new Map();
/** turnKey -> the agent picked for a conversation the mock has not stored yet. */
const draftHarness = new Map();
/**
 * The mock's rows are its installed agents, so ghostd's 409
 * harness_not_installed (a row whose CLI is missing) has no mock situation.
 */
const knownHarness = (id) => MOCK_HARNESSES.some((h) => h.id === id);
/** session-host.ts requireRow. */
const unknownHarness = (res, id) => refuse(res, 400, "unknown_harness",
  `Ghost cannot run on ${JSON.stringify(id)}; it has no row for that agent.`);
const harnessSnapshot = (name) => ({
  harnesses: MOCK_HARNESSES,
  ghostDefault: ghostDefaultHarness.get(name) ?? null,
  automatic: ghostDefaultHarness.get(name) ?? DEFAULT_RUNTIME,
});
const OWNS_GHOSTS_ROOT = !process.env.GHOSTS_ROOT;
const GHOSTS_ROOT = process.env.GHOSTS_ROOT
  || mkdtempSync(join(tmpdir(), "ghost-shell-mock-"));
const REMOTE_HOSTNAME = "omarchy-thinkpad.tail58bdd3.ts.net";
const REMOTE_PROBLEM = opt("--remote-problem", "");

// ghostd's problems, with its messages. Only a Tailscale that cannot be asked
// makes remote access unavailable; with the others it stays off or on.
const REMOTE_PROBLEMS = {
  tailscale_missing: {
    message: "Tailscale is not installed.",
    action: "omarchy-install-service-tailscale",
    unavailable: true,
  },
  tailscale_stopped: {
    message: "Tailscale is not running.",
    unavailable: true,
  },
  not_logged_in: {
    message: "This machine is not logged in to Tailscale.",
    action: "tailscale up",
    unavailable: true,
  },
  operator_required: {
    message: "Access denied: serve config denied",
    action: "sudo tailscale set --operator=$USER",
  },
  https_required: {
    message: "This tailnet has no HTTPS certificates, which the app needs: turn on HTTPS Certificates on the DNS page of the Tailscale admin console (https://login.tailscale.com/admin/dns), then turn remote access on again.",
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
/** Like ghostd, `https_required` appears only in the reply to turning Serve on, never on GET. */
function remoteSnapshot(turningOn = false) {
  const { unavailable = false, ...problemFields } = REMOTE_PROBLEMS[REMOTE_PROBLEM] ?? {};
  const reported = REMOTE_PROBLEM !== "" && (REMOTE_PROBLEM !== "https_required" || turningOn);
  const problem = reported ? { code: REMOTE_PROBLEM, ...problemFields } : null;
  const enabled = remoteEnabled && !unavailable;
  return {
    state: unavailable ? "unavailable" : (enabled ? "on" : "off"),
    hostname: unavailable ? null : REMOTE_HOSTNAME,
    guests: "none",
    owner: unavailable ? null : "owner@example.com",
    app: {
      origin: "https://summonghost.com",
      url: enabled ? `https://summonghost.com/#add=${REMOTE_HOSTNAME}` : null,
    },
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

/** The daemon's conversation-id rule (CONTRACTS.md "Conversations"). */
const validConversationId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u.test(id)
  && !["pins.json", "reads.json", "questions.json"].includes(id);

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

/** The daemon's character cap (MAX_CHARACTER_BODY_LENGTH); shells must read
    it from responses, never pin it. */
const CHARACTER_LIMIT = 20000;
/** Per-ghost owner-written persona, layered over the seeded character.md. */
const writtenCharacter = new Map();

const seedCharacter = (name) => `# ${name}\n\nI am ${name}, a quiet local ghost who answers directly.\n`;

function characterBodyFor(name) {
  return writtenCharacter.has(name) ? writtenCharacter.get(name) : seedCharacter(name);
}

function seedMockHome(name) {
  const dir = join(GHOSTS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "character.md"), seedCharacter(name), "utf8");
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

// Persisted messages carry an `entryId`, `e<n>` for log entry n as
// CONTRACTS.md's transcript row says: entries count from 0, the conversation
// header the mock does not keep being e0, and a `!command` is one entry whose
// output is `e<n>o`.
function nextEntry(s) {
  s.entries = s.entries ?? 1;
  return `e${s.entries++}`;
}
function append(s, message) {
  s.messages.push({ ...message, entryId: nextEntry(s) });
}
function appendCommand(s, command, output) {
  const entryId = nextEntry(s);
  s.messages.push({ role: "user", content: textParts(command), entryId }, { role: "assistant", content: textParts(output), entryId: `${entryId}o` });
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
      // Claude Code compacted its context as this turn began (CONTRACTS.md, "Turn wire").
      { role: "compacted", content: textParts("auto · 288k tokens") },
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

/** The route has already refused a non-numeric `limit` or `offset`. */
const transcriptOf = (s, params) => {
  const limit = params.has("limit") ? Math.max(1, Math.min(2000, Math.floor(Number(params.get("limit"))))) : 1000;
  const offset = Math.min(s.messages.length, Math.max(0, Math.floor(Number(params.get("offset") ?? 0))));
  const messages = s.messages.slice(offset, offset + limit);
  return {
    id: s.id,
    messages,
    total: s.messages.length,
    truncated: offset > 0 || offset + messages.length < s.messages.length,
    // When this page was read; the HUD sends it back to PUT …/read.
    readThrough: new Date().toISOString(),
  };
};

const firstLine = (text) => String(text).split("\n")[0].slice(0, 120);

const sessionSummary = (name) => (s) => {
  const first = s.messages.find((m) => m.role === "user");
  return {
    id: s.id,
    title: s.title ?? null,
    // As in ghostd, the first owner text logged previews it, a `!command` included.
    preview: first ? firstLine(first.content.map((part) => part.text ?? "").join("")) : null,
    harness: s.harness ?? null,
    // What the harness reported it ran on; the mock's scripted turns report none.
    model: null,
    provider: null,
    effort: null,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    pinned: s.pinned === true,
    unread: !s.readAt || s.updatedAt > s.readAt,
    running: activeTurns.has(turnKey(name, s.id)),
    question: s.question ?? null,
  };
};

/** The harness a turn runs on: the conversation's, its draft choice, the ghost's default, then the local model. */
const turnHarness = (name, id, s) => s?.harness ?? draftHarness.get(turnKey(name, id))
  ?? ghostDefaultHarness.get(name) ?? DEFAULT_RUNTIME;

/** A finished turn's conversation takes its harness, its time, and a title from its prompt. */
function recordTurn(name, id, prompt) {
  const s = ghostSessions(name).get(id);
  if (!s) return;
  s.harness = turnHarness(name, id, s);
  draftHarness.delete(turnKey(name, id));
  s.updatedAt = new Date().toISOString();
  // The first owner message titles it; a `!command` never does, as in ghostd.
  if (!s.title && !prompt.startsWith("!")) s.title = prompt.slice(0, 40) || "New conversation";
  publishConversationUpdated(name, id, s.updatedAt);
}

/** Ghosts whose scripted turn rewrites character.md, to show a Write tool card. */
const ONBOARDING = new Set(["moaning-myrtle"]);

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

/**
 * A refusal, as ghostd's errorResponse sends it. Every one the mock answers
 * carries the code and message ghostd answers the same situation with; the
 * source each copies is named beside it, and the parity probe pins several.
 */
const refuse = (res, status, code, message) => json(res, status, { error: { message, code } });
/** conversation-log.ts requireConversationId; ghostd checks a route's `:id` before anything else. */
const badConversation = (res) => refuse(res, 400, "invalid_conversation_id",
  "Conversation ids are 1-128 letters, digits, '.', '_' or '-', and not pins.json, reads.json, questions.json.");
/** session-host.ts requireConversation: the conversation has no log. */
const noConversation = (res, id) => refuse(res, 404, "not_found", `This ghost has no conversation ${JSON.stringify(id)}.`);
/** server.ts stringField and booleanField. */
const notString = (res, key) => refuse(res, 400, "invalid_request", `"${key}" must be a string.`);
const notBoolean = (res, key) => refuse(res, 400, "invalid_request", `"${key}" must be a boolean.`);


// The daemon's hooks.json, kept as one document the way ghostd does. The
// loader's shape check is the small subset a pane edit can plausibly trip,
// worded the way ghostd words it.
const HOOKS_CONFIG_PATH = "/home/owner/.config/ghost/hooks.json";
const HOOK_EVENTS = ["session_stop", "turn_end"];
let hooksDocument = {
  hooks: {
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
  const stray = Object.keys(document).filter((key) => key !== "hooks");
  if (stray.length > 0) return `${path} has no top-level ${stray.map((key) => JSON.stringify(key)).join(", ")}; send the document itself.`;
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

const svg = (res, body) => {
  res.writeHead(200, {
    "content-type": "image/svg+xml",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
};

/**
 * Lenient where ghostd is strict: an empty body reads as {} and a malformed
 * one rejects for the caller to default, so ghostd's "Request body …" 400s
 * have no counterpart here.
 */
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
function* toolCall(id, toolName, args, summary, isError = false) {
  yield { type: "tool_execution_start", id, toolName, arguments: args, cwd: SESSION_CWD };
  yield { type: "tool_execution_end", id, toolName, isError, summary };
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
 * A scripted pass: the ghost narrating itself, one tool call — two for an
 * ONBOARDING ghost — then a two-paragraph answer.
 */
function* script(name, prompt, harness) {
  let contentIndex = 0;
  yield { type: "start" };
  // Each pass names the agent it runs on, as ghostd does (CONTRACTS.md, "Turn wire").
  yield { type: "harness", harness };
  if (COMPACT) yield { type: "compacted", trigger: "auto", preTokens: 287_944 };
  // The preamble a real model emits before reaching for a tool: it stays as its
  // own message, and the reply after the call is the next one
  // (qml/services/TurnBlocks.js).
  yield* textBlock(contentIndex++, "Checking what I remember about that");
  // Tool calls take no content index; the daemon numbers text blocks only.
  yield* toolCall("call_1", "Grep", { pattern: prompt.slice(0, 24) }, TOOL_ERROR ? "" : "Note checked", TOOL_ERROR);
  for (let step = 1; step < TOOL_STEPS; step++) {
    const toolName = step % 3 === 0 ? "Grep" : (step % 3 === 1 ? "Read" : "Glob");
    yield* toolCall(`call_long_${step}`, toolName,
      { step: step + 1, file_path: join(SESSION_CWD, `step-${step + 1}.md`) }, `Completed step ${step + 1}`);
  }
  // An ONBOARDING ghost rewrites its character during the turn with the same
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

const activeTurns = new Map();
const turnKey = (name, sessionId) => JSON.stringify([name, sessionId]);
/** ghosts.ts's ghost-name grammar, which every route shares. */
const validGhostName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name);
/** ghosts.ts assertValidGhostName. */
const badGhostName = (res, name) => refuse(res, 400, "invalid_name",
  `Ghost names must be 1-64 characters of letters, digits, ".", "_", or "-", and may not start with a dot (got ${JSON.stringify(name)}).`);

/** Each turn's events by turn id, kept as ghostd keeps them so a cut response can resume. */
const turnLogs = new Map();

function openTurnLog(name, sessionId) {
  // A turn outlives its client, as in ghostd: `stopped` (POST …/stop) ends it.
  const log = { id: randomUUID(), name, sessionId, frames: [], ended: false, stopped: false, followers: new Set() };
  turnLogs.set(log.id, log);
  return log;
}

/** Close the log: a terminal was sent, or --omit-terminal ends the response without one. */
function endLog(log) {
  if (log.ended) return;
  log.ended = true;
  for (const follower of [...log.followers]) follower();
  setTimeout(() => turnLogs.delete(log.id), 60_000).unref();
}

/** Append one event to the turn, for every response following it. */
function send(log, event) {
  if (log.ended) return;
  log.frames.push(`data: ${JSON.stringify(event)}\n\n`);
  if (event.type === "done" || event.type === "error") return endLog(log);
  for (const follower of [...log.followers]) follower();
}

/** Stream the turn from event `from`, until it ends or CUT_BYTES end the response with `resume`. */
function followTurn(res, log, from) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const keepalive = flag("--stall-stream") ? null : setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);
  let next = from;
  let written = 0;
  const finish = () => {
    log.followers.delete(pump);
    clearInterval(keepalive);
    if (!res.writableEnded) res.end();
  };
  const pump = () => {
    if (res.writableEnded) return finish();
    while (next < log.frames.length) {
      const frame = log.frames[next++];
      res.write(frame);
      written += frame.length;
      if (written >= CUT_BYTES && !(log.ended && next === log.frames.length)) {
        res.write(`data: ${JSON.stringify({ type: "resume", turn: log.id, from: next })}\n\n`);
        return finish();
      }
    }
    if (log.ended) finish();
  };
  res.on("close", finish);
  log.followers.add(pump);
  pump();
}

/**
 * Drive scripted events into the turn. Returns the pass as ghostd logs it —
 * its text and tool-call parts in order — or null if the turn was stopped.
 */
async function pump(log, events) {
  const parts = [];
  for (const event of events) {
    if (log.stopped) return null;
    if (event.type === "text_end") parts.push({ type: "text", text: event.content });
    if (event.type === "tool_execution_start") parts.push({ type: "toolCall", id: event.id, name: event.toolName, arguments: event.arguments });
    if (event.type === "tool_execution_end" && event.isError) {
      const index = parts.findIndex((part) => part.type === "toolCall" && part.id === event.id);
      if (index >= 0) parts[index] = { ...parts[index], failed: true };
    }
    send(log, event);
    await new Promise((r) => setTimeout(r, event.type === "text_delta" ? DELTA_MS : 220));
  }
  return parts;
}

async function streamTurn(res, name, body) {
  const prompt = body.prompt.trim(); // The route refused an empty one.
  const sessionId = body.sessionId;
  const log = openTurnLog(name, sessionId);
  followTurn(res, log, 0);
  const key = turnKey(name, sessionId);
  // An owner command has no passes, so nothing queues into it.
  const turn = { streaming: !prompt.startsWith("!"), followUp: [], log };
  activeTurns.set(key, turn);
  // Like ghostd, a turn creates its conversation and logs its prompt as it
  // starts (an owner command logs when it ends), so another client sees what
  // is running.
  // The route has already refused an invalid conversation id.
  const store = ghostSessions(name);
  let existing = store.get(sessionId);
  if (!existing) {
    existing = { id: sessionId, title: null, updatedAt: new Date().toISOString(), messages: [] };
    store.set(sessionId, existing);
  }
  if (!prompt.startsWith("!")) {
    append(existing, { role: "user", content: textParts(prompt) });
    // The owner's message answers whatever the ghost asked there.
    existing.question = null;
  }
  publishConversationUpdated(name, sessionId);
  const failing = flag("--fail") && !flag("--omit-terminal");
  // Each pass's reply is logged as it ends, as ghostd does: a stopped one as
  // "Turn aborted.", a --fail one with its error.
  const logReply = (reply) => {
    append(existing, reply === null
    ? { role: "assistant", content: [], errorMessage: "Turn aborted." }
    : { role: "assistant", content: reply, ...(failing ? { errorMessage: "mock-ghostd --fail" } : {}) });
  };
  let stopped = false;
  try {
    if (prompt.startsWith("!")) {
      const command = prompt.slice(1).trim();
      const ran = await pump(log, ownerCommand(command)) !== null;
      // ghostd logs the command as it ends; the transcript shows the owner's
      // `!command`, then its output as the ghost's message.
      appendCommand(existing, prompt, ran
        ? `\`\`\`\nmock output of ${command}\n\`\`\``
        : `\`\`\`\n\n\`\`\`\n\n(exit signal)`);
    } else {
      if (COMPACT) append(existing, { role: "compacted", content: textParts("auto · 288k tokens") });
      const harness = turnHarness(name, sessionId, existing);
      let reply = await pump(log, script(name, prompt, harness));
      logReply(reply);
      // After each pass a stop hook decides (never continuing, here); a queued
      // follow-up then runs: the daemon logs and announces it, says
      // owner_message, then streams the pass that answers it.
      while (reply !== null && !log.stopped) {
        if (STOP_HOOK_MS > 0 && turn.followUp.length === 0) {
          const hook = { name: "Deciding whether to keep going", event: "session_stop" };
          send(log, { type: "hook_start", ...hook });
          await new Promise((resolve) => setTimeout(resolve, STOP_HOOK_MS));
          send(log, { type: "hook_end", ...hook });
        }
        if (log.stopped) break;
        if (turn.followUp.length === 0) break;
        const text = turn.followUp.shift();
        append(existing, { role: "user", content: textParts(text) });
        existing.question = null;
        publishConversationUpdated(name, sessionId);
        send(log, { type: "queue", followUp: turn.followUp });
        send(log, { type: "owner_message", text });
        send(log, { type: "harness", harness });
        reply = await pump(log, textBlock(0, `Following up on **${text}**.`));
        logReply(reply);
      }
      stopped = reply === null || log.stopped;
      if (ASK && !stopped) {
        existing.question = { text: "Shall I go ahead with that?", options: ["Yes", "Not yet"], askedAt: new Date().toISOString() };
      }
      // A stopped turn already ended its stream with `aborted`.
      if (!stopped) {
        if (flag("--stall-stream")) {
          await new Promise((resolve) => res.once("close", resolve));
          return;
        }
        if (!flag("--omit-terminal")) {
          send(log, failing
            ? { type: "error", reason: "error", errorMessage: "mock-ghostd --fail" }
            : { type: "done" });
        }
        endLog(log);
      }
    }
  } finally {
    turn.streaming = false;
    activeTurns.delete(key);
    // Every end records the turn and announces it once, as ghostd's does:
    // stopped, failed, stalled, or done.
    recordTurn(name, sessionId, prompt);
  }
}

const mockServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","ghosts",...]
  console.error(`${req.method} ${url.pathname}`);

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "hooks" && parts[2] === "config") {
    if (req.method === "GET") return json(res, 200, { path: HOOKS_CONFIG_PATH, document: hooksDocument });
    if (req.method !== "PUT") return refuse(res, 405, "method_not_allowed", `${req.method} is not allowed here.`);
    const body = await readBody(req).catch(() => null);
    const problem = hooksDocumentProblem(body);
    if (problem) return refuse(res, 400, "invalid_request", problem);
    hooksDocument = body;
    return json(res, 200, { path: HOOKS_CONFIG_PATH, document: hooksDocument });
  }
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "remote") {
    if (req.method === "GET") return json(res, 200, remoteSnapshot());
    if (req.method !== "POST") return refuse(res, 405, "method_not_allowed", `${req.method} is not allowed here.`);
    const body = await readBody(req).catch(() => null);
    if (typeof body?.enabled !== "boolean") return notBoolean(res, "enabled");
    // A problem refuses the write, as Tailscale does, and leaves Serve off.
    remoteEnabled = body.enabled && REMOTE_PROBLEM === "";
    return json(res, 200, remoteSnapshot(body.enabled));
  }

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "remote"
      && parts[2] === "qr.svg") {
    if (req.method !== "GET") return refuse(res, 405, "method_not_allowed", `${req.method} is not allowed here.`);
    const status = remoteSnapshot();
    if (status.state !== "on" || !status.app.url) {
      return refuse(res, 404, "not_found", "Remote access is off, or remote.apps names no app.");
    }
    return svg(res, REMOTE_QR_SVG);
  }

  if (parts[0] !== "api" || parts[1] !== "ghosts") return refuse(res, 404, "not_found", "Not found.");

  if (parts.length === 2 && req.method === "GET") return json(res, 200, ghosts);

  let name;
  try {
    name = decodeURIComponent(parts[2] ?? "");
  } catch {
    return refuse(res, 400, "invalid_request", "URL path segments must use valid percent-encoding.");
  }
  if (!validGhostName(name)) return badGhostName(res, name);
  const ghost = ghosts.find((g) => g.name === name);
  if (!ghost) return refuse(res, 404, "not_found", `No ghost named ${JSON.stringify(name)}.`);

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
    if (body === null) return notString(res, "body");
    if (body.length > CHARACTER_LIMIT) {
      // home.ts writeCharacter.
      return refuse(res, 400, "limit_exceeded",
        `character.md may be at most ${CHARACTER_LIMIT} characters; that body is ${body.length}. Nothing was written.`);
    }
    writtenCharacter.set(name, body);
    if (OWNS_GHOSTS_ROOT) writeFileSync(join(ghost.dir, "character.md"), body, "utf8");
    return json(res, 200, { ok: true, limit: CHARACTER_LIMIT });
  }

  if (parts[3] === "messages" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    // turn-events.ts parseTurnRequest, then session-host.ts admitTurn: no
    // sessionId is the conversation `default`.
    if (typeof body?.prompt !== "string" || body.prompt.trim() === "") {
      return refuse(res, 400, "invalid_request", '"prompt" must be non-empty text.');
    }
    const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "default";
    if (!validConversationId(sessionId)) return badConversation(res);
    if (activeTurns.has(turnKey(name, sessionId))) {
      return refuse(res, 409, "session_busy", "This ghost is already answering in this conversation.");
    }
    if (/^(?!!\[)!!?\s*$/u.test(body.prompt.trim())) return refuse(res, 400, "invalid_request", "Write a command after ! or !!.");
    return streamTurn(res, name, { ...body, sessionId });
  }
  if (parts[3] === "harness" && parts.length === 4 && req.method === "GET") {
    return json(res, 200, harnessSnapshot(name));
  }
  if (parts[3] === "harness" && parts.length === 4 && req.method === "PUT") {
    const body = await readBody(req).catch(() => ({}));
    const harness = body?.harness;
    if (harness !== null && (typeof harness !== "string" || harness === "")) {
      return refuse(res, 400, "invalid_request", '"harness" must be an agent id or null.');
    }
    if (harness !== null && !knownHarness(harness)) return unknownHarness(res, harness);
    if (harness === null) ghostDefaultHarness.delete(name);
    else ghostDefaultHarness.set(name, harness);
    return json(res, 200, harnessSnapshot(name));
  }
  // The machine-local `{ path }` form of an attachment: the file is copied
  // into the conversation directory, created if the draft has none yet.
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "attachments" && req.method === "POST") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const body = await readBody(req).catch(() => ({}));
    // server.ts handleSaveAttachment, then attachments.ts saveAttachment
    // (which sniffs the bytes; the mock reads the extension).
    if (typeof body?.path !== "string") return notString(res, "path");
    if (!isAbsolute(body.path)) return refuse(res, 400, "invalid_request", '"path" must be absolute.');
    const size = (() => {
      try {
        const info = statSync(body.path);
        return info.isFile() ? info.size : -1;
      } catch {
        return -1;
      }
    })();
    if (size < 0) return refuse(res, 404, "not_found", `No file at ${body.path}.`);
    if (size > 20 * 1024 * 1024) return refuse(res, 413, "payload_too_large", "An attachment is at most 20 MiB.");
    const match = /\.(png|jpe?g|webp|gif)$/iu.exec(body.path);
    if (!match) return refuse(res, 415, "unsupported_media_type", "An attachment must be a PNG, JPEG, GIF, or WebP image.");
    const file = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}.${match[1].toLowerCase().replace("jpeg", "jpg")}`;
    const dir = join(ghost.dir, "sessions", conversation, "attachments");
    mkdirSync(dir, { recursive: true });
    copyFileSync(body.path, join(dir, file));
    return json(res, 201, { path: `attachments/${file}` });
  }
  // A conversation's next turn runs on the picked agent; a draft the HUD
  // minted is not stored yet, so its pick waits for its first turn.
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "harness" && req.method === "PUT") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const body = await readBody(req).catch(() => ({}));
    // server.ts readHarnessBody, then session-host.ts chooseHarness.
    if (typeof body?.harness !== "string" || body.harness === "") {
      return refuse(res, 400, "invalid_request", '"harness" must be an agent id.');
    }
    if (!knownHarness(body.harness)) return unknownHarness(res, body.harness);
    if (activeTurns.has(turnKey(name, conversation))) {
      return refuse(res, 409, "session_busy", "Wait for this conversation to finish before switching agents.");
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
    if (!conversation) return badConversation(res);
    if (!ghostSessions(name).has(conversation)) return noConversation(res, conversation);
    if (activeTurns.has(turnKey(name, conversation))) {
      return refuse(res, 409, "session_busy", "Wait for this conversation to finish before deleting it.");
    }
    ghostSessions(name).delete(conversation);
    publishConversationUpdated(name, conversation);
    return json(res, 200, { ok: true });
  }
  // Idempotent like the daemon's: the HUD sends the state it wants.
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "pin" && req.method === "PUT") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const body = await readBody(req).catch(() => ({}));
    if (typeof body?.pinned !== "boolean") return notBoolean(res, "pinned");
    const s = ghostSessions(name).get(conversation);
    if (!s) return noConversation(res, conversation);
    s.pinned = body.pinned;
    publishConversationUpdated(name, s.id, s.updatedAt);
    return json(res, 200, { ok: true, pinned: s.pinned });
  }
  // A ghost asking the owner (`ghost ask`), and its withdrawal unanswered.
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "question" && (req.method === "PUT" || req.method === "DELETE")) {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const body = req.method === "PUT" ? await readBody(req).catch(() => ({})) : null;
    const options = body?.options ?? [];
    let question = null;
    if (body) {
      // server.ts's question route, then session-host.ts validQuestion.
      if (!Array.isArray(options) || options.some((option) => typeof option !== "string")) {
        return refuse(res, 400, "invalid_request", '"options" must be an array of strings.');
      }
      if (typeof body.text !== "string") return notString(res, "text");
      const text = body.text.trim();
      const kept = [...new Set(options.map((option) => option.trim()).filter(Boolean))];
      if (text === "") return refuse(res, 400, "invalid_request", "A question needs text.");
      if (text.length > 2000) return refuse(res, 400, "invalid_request", "A question must be at most 2000 characters.");
      if (kept.length > 6) return refuse(res, 400, "invalid_request", "A question takes at most 6 options.");
      if (kept.some((option) => option.length > 120)) return refuse(res, 400, "invalid_request", "Each option must be at most 120 characters.");
      question = { text, options: kept, askedAt: new Date().toISOString() };
    }
    const s = ghostSessions(name).get(conversation);
    if (!s) return noConversation(res, conversation);
    s.question = question;
    publishConversationUpdated(name, s.id, s.updatedAt);
    return json(res, 200, body ? { ok: true, question: s.question } : { ok: true });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "read" && req.method === "PUT") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const input = await readBody(req).catch(() => ({}));
    if (input?.readThrough !== undefined && typeof input.readThrough !== "string") return notString(res, "readThrough");
    const readAt = input?.readThrough === undefined ? new Date() : new Date(input.readThrough);
    if (!Number.isFinite(readAt.getTime()) || readAt.getTime() > Date.now()) {
      return refuse(res, 400, "invalid_request", "readThrough must be a valid timestamp no later than now.");
    }
    const s = ghostSessions(name).get(conversation);
    if (!s) return noConversation(res, conversation);
    s.readAt = readAt.toISOString();
    publishConversationUpdated(name, s.id, s.updatedAt);
    return json(res, 200, { ok: true, readAt: s.readAt });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "stream" && req.method === "GET") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const log = turnLogs.get(url.searchParams.get("turn") ?? "");
    if (!log || log.name !== name || log.sessionId !== conversation) {
      return refuse(res, 404, "turn_not_found", "That turn is no longer resumable; read the transcript.");
    }
    const raw = url.searchParams.get("from");
    const from = raw === null ? undefined : Number(raw);
    if (from !== undefined && !Number.isFinite(from)) return refuse(res, 400, "invalid_request", '"from" must be a number.');
    if (from === undefined || !Number.isInteger(from) || from < 0 || from > log.frames.length) {
      return refuse(res, 400, "invalid_request", '"from" must be an event index this turn has reached.');
    }
    return followTurn(res, log, from);
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "transcript" && req.method === "GET") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    for (const field of ["limit", "offset"]) {
      const value = url.searchParams.get(field);
      if (value !== null && !Number.isFinite(Number(value))) {
        return refuse(res, 400, "invalid_request", `"${field}" must be a number.`);
      }
    }
    // As in ghostd, a conversation with no log yet reads as an empty page.
    const s = ghostSessions(name).get(conversation) ?? { id: conversation, messages: [] };
    return json(res, 200, transcriptOf(s, url.searchParams));
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "stop" && req.method === "POST") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const turn = activeTurns.get(turnKey(name, conversation));
    if (!turn) return refuse(res, 409, "session_not_streaming", "This conversation is not currently streaming.");
    turn.log.stopped = true;
    send(turn.log, { type: "error", reason: "aborted", errorMessage: "Turn aborted." });
    return json(res, 200, { stopped: true });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "queue") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const turn = activeTurns.get(turnKey(name, conversation));
    const snapshot = () => ({
      streaming: turn?.streaming === true,
      followUp: turn?.followUp ?? [],
    });
    if (req.method === "GET") return json(res, 200, snapshot());
    if (req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (text === "") return refuse(res, 400, "invalid_request", '"text" must be a non-empty string.');
      if (!turn) {
        return refuse(res, 409, "session_not_streaming",
          "This conversation is not currently streaming; send a normal message instead.");
      }
      if (!turn.streaming) {
        return refuse(res, 409, "session_busy", "An owner command is running in this conversation; send this when it ends.");
      }
      turn.followUp.push(text);
      send(turn.log, { type: "queue", followUp: turn.followUp });
      return json(res, 200, snapshot());
    }
  }
  // Renaming one conversation.
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "title" && req.method === "PUT") {
    const conversation = routeConversation(parts);
    if (!conversation) return badConversation(res);
    const body = await readBody(req).catch(() => ({}));
    const raw = body?.title;
    // A conversation is renamed, never un-named: there is no "clear it" here,
    // so an emptied field is a refusal rather than a reset to untitled
    // (session-host.ts renameConversation).
    if (typeof raw !== "string") return notString(res, "title");
    const title = raw.trim();
    if (title === "") return refuse(res, 400, "invalid_request", '"title" must not be empty.');
    if (title.length > 120) return refuse(res, 400, "invalid_request", '"title" must be at most 120 characters.');
    if (!/\P{C}/u.test(title)) {
      return refuse(res, 400, "invalid_request", "A conversation title needs at least one printable character.");
    }
    const s = ghostSessions(name).get(conversation);
    if (!s) return noConversation(res, conversation);
    s.title = title;
    publishConversationUpdated(name, s.id, s.updatedAt);
    return json(res, 200, { ok: true, title: s.title });
  }
  // ghostd answers 405 where the path has a route for another method.
  return refuse(res, 404, "not_found", "Not found.");
});
mockServer.listen(PORT, HOST, () => {
  const address = mockServer.address();
  const listeningPort = typeof address === "object" && address ? address.port : PORT;
  console.error(`mock-ghostd on http://${HOST}:${listeningPort} — ghosts: ${ghosts.map((g) => g.name).join(", ")}`);
});
