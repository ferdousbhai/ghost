#!/usr/bin/env node
/**
 * mock-ghostd — just enough of the CONTRACTS.md daemon API to build and demo
 * the Quickshell surfaces without pi, models, or a real ghost home.
 *
 * Implements:
 *   GET  /api/ghosts                          → [{ name, dir, createdAt }]
 *   POST /api/ghosts { name }                 → 201 + the new ghost
 *   DELETE /api/ghosts/:name?confirm=:name    → 200 { ok, trash } | 400 | 404 | 409
 *   GET  /api/ghosts/:name/context            → docs, memory, character, agents
 *   DELETE /api/ghosts/:name/context          → move one doc/memory file to mock Trash
 *   GET  /api/ghosts/:name/mcp                → sanitized project MCP catalog
 *   POST/PUT/DELETE /api/ghosts/:name/mcp/... → manage project MCP servers
 *   GET/POST /api/ghosts/:name/sessions/:id/live   → remote live-voice status/actions
 *   GET/POST /api/ghosts/:name/sessions/:id/collab → relay collaboration status/actions
 *   POST /api/ghosts/:name/messages           → pi-messages SSE (canned reply)
 *   POST /api/ghosts/:name/greeting           → { greeting, onboarding }, ~800ms late
 *   PUT  /api/ghosts/:name/name { name }      → { ok, name } | 400 | 404 | 409
 *   GET  /api/ghosts/:name/sessions           → { sessions: [...] }, newest first
 *   GET  /api/ghosts/:name/events             → conversation invalidation SSE
 *   GET  /api/ghosts/:name/sessions/:id/commands → effective OMP slash commands
 *   DELETE /api/ghosts/:name/sessions/:id     → delete one conversation
 *   PUT  /api/ghosts/:name/sessions/:id/read  → mark one conversation read
 *   GET  /api/ghosts/:name/sessions/:id/transcript → { id, title, messages, … }
 *   PUT  /api/ghosts/:name/sessions/:id/title → { ok, title } | 400 | 404 | 409
 *   POST /api/ghosts/:name/sessions/:id/branch → { action: "fork", entryId }
 *   GET  /api/ghosts/:name/sessions/:id/ask   → { ask } while a turn is paused
 *   POST /api/ghosts/:name/sessions/:id/ask   → resolve it | 409 ask_not_pending
 *   POST /api/ghosts/:name/sessions/:id/reanswer → SSE: branch_changed, then the
 *                                               same question asked live again
 *   GET  /api/ghosts/:name/providers          → loginable providers
 *   POST /api/ghosts/:name/login              → start a login → { loginId, status }
 *   GET  /api/ghosts/:name/login/:loginId     → current login step
 *   POST /api/ghosts/:name/login/:loginId/input → satisfy an awaiting prompt
 *
 * The login flows are scripted (no real provider): openai-codex OAuth offers a
 * select (browser callback vs device code), openrouter OAuth shows an auth URL
 * plus a paste field, and api-key flows ask for a masked key. Ghosts, sessions,
 * and logins live in memory; only an owned temporary markdown fixture touches
 * disk so the context editors have real files. It vanishes on exit.
 *
 * A turn stops to ask a question when the prompt contains the word "ask" —
 * the dialog has no other way to open with no model in the loop, and a word
 * the demoer types on purpose beats a random one in ten turns. Every other
 * prompt runs the plain scripted turn.
 *
 * Auth: none. The real daemon requires `Authorization: Bearer <token>` on
 * every /api route (CONTRACTS.md); the mock accepts and ignores the header so
 * the surfaces can be driven on a machine where `ghostd` has never run and no
 * token file exists. Ghostd.qml sends no header when it cannot read one, so
 * both paths work. Anything testing the *auth* itself belongs against the real
 * daemon, not here.
 *
 * Usage:  node dev/mock-ghostd.mjs [--port 7717] [--slow] [--fail]
 *                                  [--ask-timeout 120] [--tool-steps 1]
 *                                  [--omit-terminal] [--stall-stream]
 *   --slow         30ms between text deltas instead of 12ms
 *   --fail         terminate the next turn with a pi-messages `error` event
 *   --ask-timeout  seconds a pending ask waits before answering itself; 0 waits
 *                  forever. The dialog keeps a static line until 30s remain and
 *                  only counts down inside that, so 40 is the demo value.
 *   --tool-steps    tool-call steps before the answer; 14 mirrors the owner's
 *                  reported long-turn shape and leaves time to steer it.
 *   --omit-terminal end the HTTP response without `done`/`error`.
 *   --stall-stream  leave the response open after the script, without a terminal
 *                  event or keepalive; the shell watchdog must settle it.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
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
const TOOL_STEPS = Math.max(1, Math.min(100, Number(opt("--tool-steps", "1")) || 1));
/** The contract's `askTimeoutSeconds` default; 0 means no deadline is armed. */
const ASK_TIMEOUT_S = Math.max(0, Number(opt("--ask-timeout", "120")) || 0);
const OWNS_GHOSTS_ROOT = !process.env.GHOSTS_ROOT;
const GHOSTS_ROOT = process.env.GHOSTS_ROOT
  || mkdtempSync(join(tmpdir(), "ghost-shell-mock-"));
const TRASH_ROOT = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "Trash", "files");

/** @type {{ name: string, dir: string, createdAt: string }[]} */
const ghosts = ["casper", "moaning-myrtle"].map((name) => ({
  name,
  dir: join(GHOSTS_ROOT, name),
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
}));

const conversationEventClients = new Map();

function conversationIdentity(runtime, conversationId) {
  return { id: `${runtime}:${conversationId}`, runtime, conversationId };
}

function parseConversationIdentity(id) {
  for (const runtime of ["pi", "claude-code"]) {
    const prefix = `${runtime}:`;
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { id, runtime, conversationId: id.slice(prefix.length) };
    }
  }
  return null;
}

function routeConversation(parts) {
  try {
    return parseConversationIdentity(decodeURIComponent(parts[4]));
  } catch {
    return null;
  }
}

function publishConversationUpdated(name, runtime, conversationId,
    updatedAt = new Date().toISOString()) {
  const event = `data: ${JSON.stringify({
    type: "conversation-updated",
    ...conversationIdentity(runtime, conversationId),
    updatedAt,
  })}\n\n`;
  for (const response of conversationEventClients.get(name) ?? []) {
    if (!response.writableEnded) response.write(event);
  }
}

// ---- Browsable ghost context ----------------------------------------------
// Metadata stays in memory. The default root gets matching temporary files so
// FilePane exercises real atomic reads/writes without touching ~/ghosts.
const MOCK_DOCS = [
  {
    path: "docs/launch-notes.md",
    relativePath: "launch-notes.md",
    title: "Launch notes",
    tags: ["launch", "product"],
    archived: false,
  },
  {
    path: "docs/reference/working-agreement.md",
    relativePath: "reference/working-agreement.md",
    title: "Working agreement",
    tags: ["reference"],
    archived: true,
  },
];

const MOCK_MEMORY = [
  {
    path: "memory/preferred-tone.md",
    slug: "preferred-tone",
    description: "The owner prefers direct...",
    content: "The owner prefers direct, evidence-first answers. Use terse, concrete language. Lead with the decision and evidence.",
    updated: "2026-08-24",
  },
  {
    path: "memory/current-project.md",
    slug: "current-project",
    description: "Ghost is the owner's local...",
    content: "Ghost is the owner's local sovereign assistant. Keep context in plain files and keep cloud credentials out of exports.",
    updated: "2026-08-25",
  },
];

const MOCK_AGENTS = [
  {
    name: "designer",
    description: "UI/UX implementation and visual refinement.",
    systemPrompt: "Implement and review interfaces with close attention to hierarchy, accessibility, and the existing design system.",
    tools: ["read", "grep", "glob"],
    model: ["@designer"],
    spawns: null,
  },
  {
    name: "librarian",
    description: "Source-verified external library research.",
    systemPrompt: "Research external libraries and APIs from source code and official documentation. Ground every answer in evidence.",
    tools: ["read", "grep", "glob", "web_search"],
    model: ["@smol"],
    spawns: null,
  },
  {
    name: "reviewer",
    description: "Correctness and quality review.",
    systemPrompt: "Review changes for concrete, actionable defects and return an evidence-backed verdict.",
    tools: ["read", "grep", "glob"],
    model: ["@slow"],
    spawns: ["scout"],
  },
  {
    name: "scout",
    description: "Fast read-only codebase investigation.",
    systemPrompt: "Investigate the codebase rapidly and return compressed findings for handoff.",
    tools: ["read", "grep", "glob"],
    model: ["@smol"],
    spawns: null,
  },
  {
    name: "security-reviewer",
    description: "Evidence-backed vulnerability discovery.",
    systemPrompt: "Trace attacker-controlled input to dangerous sinks and report only demonstrated vulnerabilities.",
    tools: ["read", "grep", "glob"],
    model: [],
    spawns: null,
  },
  {
    name: "sonic",
    description: "Strictly mechanical updates and collection.",
    systemPrompt: "Perform only the assigned mechanical update or data-collection task.",
    tools: null,
    model: ["@smol"],
    spawns: null,
  },
  {
    name: "task",
    description: "General-purpose delegated implementation.",
    systemPrompt: "Complete the delegated task with full access to the available tools.",
    tools: null,
    model: ["@task"],
    spawns: "*",
  },
].map(agent => ({ ...agent, source: "bundled" }));

// Effective command discovery is session-scoped in the real daemon. These
// exercise built-ins, aliases, input hints, subcommands, skills, and a project
// command so both the full browser and slash completion have meaningful data.
const MOCK_COMMANDS = [
  {
    name: "help",
    aliases: ["?"],
    description: "Show OMP's command help and keyboard shortcuts.",
    input: null,
    subcommands: [],
    source: "built-in",
  },
  {
    name: "tree",
    aliases: ["branch", "branches"],
    description: "Inspect and move through the current conversation tree.",
    input: "[entry]",
    subcommands: [{ name: "show" }, { name: "list" }],
    source: "built-in",
    availability: "unsupported",
    unavailableReason: "Ghost forks conversations instead of rewinding an in-place tree.",
  },
  {
    name: "settings",
    aliases: ["config"],
    description: "Open OMP settings for this ghost.",
    input: null,
    subcommands: [],
    source: "built-in",
    availability: "partial",
    unavailableReason: "Model routing is available in Ghost's model switcher; other OMP settings remain file-backed.",
  },
  {
    name: "skill:research",
    aliases: [],
    description: "Force-invoke the research skill with optional arguments.",
    input: "[topic]",
    subcommands: [],
    source: "skill",
  },
  {
    name: "release-notes",
    aliases: ["release"],
    description: "Draft release notes from the current project history.",
    input: { usage: "<version>" },
    subcommands: [],
    source: "project",
  },
];

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
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    for (const key of new Set(url.searchParams.keys())) {
      url.searchParams.delete(key);
      url.searchParams.append(key, "[configured]");
    }
    return url.toString();
  } catch {
    return String(value || "").replace(/[?#].*$/, "?[configured]");
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

// ---- Connect fixtures ----------------------------------------------------
const liveStates = new Map();
const collabStates = new Map();
let collabSeq = 0;

function ghostLive(name, sessionId) {
  if (!liveStates.has(name)) liveStates.set(name, new Map());
  const sessions = liveStates.get(name);
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      phase: "idle",
      muted: false,
      inputLevel: 0,
      transcript: [],
      provider: "openai-codex",
      remote: true,
    });
  }
  return sessions.get(sessionId);
}

function setGhostLive(name, sessionId, state) {
  if (!liveStates.has(name)) liveStates.set(name, new Map());
  liveStates.get(name).set(sessionId, state);
  return state;
}

function ghostCollab(name, sessionId) {
  if (!collabStates.has(name)) collabStates.set(name, new Map());
  const sessions = collabStates.get(name);
  if (!sessions.has(sessionId)) sessions.set(sessionId, { active: false, phase: "idle" });
  return sessions.get(sessionId);
}

function setGhostCollab(name, sessionId, state) {
  if (!collabStates.has(name)) collabStates.set(name, new Map());
  collabStates.get(name).set(sessionId, state);
  return state;
}

const deletedContext = new Map();

function contextDeletedFor(name) {
  if (!deletedContext.has(name)) deletedContext.set(name, new Set());
  return deletedContext.get(name);
}

function contextSnapshot(name) {
  const deleted = contextDeletedFor(name);
  return {
    character: { path: "character.md", title: name },
    docs: MOCK_DOCS.filter((item) => !deleted.has(item.path)),
    memory: MOCK_MEMORY.filter((item) => !deleted.has(item.path)),
    agents: MOCK_AGENTS,
    skipped: [],
  };
}

function seedMockHome(name) {
  const dir = join(GHOSTS_ROOT, name);
  mkdirSync(join(dir, "docs", "reference"), { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(
    join(dir, "character.md"),
    `# ${name}\n\nI am ${name}, a quiet local ghost who answers directly.\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "docs", "launch-notes.md"),
    "# Launch notes\n\nShip the context navigator with the right rail, a document index, and a lossless editor.\n\n#launch #product\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "docs", "reference", "working-agreement.md"),
    "# Working agreement\n\nDecisions first. Evidence next. No second source of truth.\n\n#reference #archived\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "memory", "preferred-tone.md"),
    `${MOCK_MEMORY[0].content}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "memory", "current-project.md"),
    `${MOCK_MEMORY[1].content}\n`,
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
const nextEntryId = () => `entry-${++entrySeq}`;
const entry = (message) => ({ ...message, entryId: nextEntryId() });

/**
 * The two questions the seeded transcript timed out on. They are the live ask
 * again when that card is re-answered, so they live where both readers reach
 * them. The first recommends an option; the second recommends nothing, which is
 * the other thing a restored card has to be able to say.
 */
const SEEDED_QUESTIONS = {
  notes: {
    id: "q-notes",
    header: "Launch notes",
    question: "Three sections in roadmap.md are unfinished. Which do you want me to draft first?",
    recommended: 1,
    options: [
      { label: "The roadmap section", description: "Six bullets, mostly written. I'd tidy and finish it." },
      {
        label: "The pricing page copy",
        description: "Nothing written yet; I'd draft it from your docs and memory.",
        preview: "Three tiers, no annual discount, one sentence each.",
      },
      { label: "The changelog", description: "Mechanical — I can generate it from the git log." },
      { label: "None of them; just tell me what's left", description: "No writing. One paragraph back." },
    ],
  },
  archive: {
    id: "q-archive",
    header: "Old exports",
    question: "The archive holds 340 files from the hosted export. What should I do with them?",
    options: [
      { label: "Leave them exactly as they are" },
      { label: "Index them into memory", description: "Slow, and it rewrites nothing on disk." },
      { label: "Move them to the trash", description: "Recoverable from the file manager." },
    ],
  },
};

function ghostSessions(name) {
  if (!sessionStore.has(name)) {
    const now = Date.now();
    const seed = new Map();
    // A failed tool call and a timed-out ask are rehydrate-only surfaces: no
    // turn produces them on demand, so unless they are in the seed there is
    // nothing to open. `content` as an ordered part list is the stored shape
    // that can carry them (TurnBlocks.partsOf); a plain string cannot.
    const notesResult = nextEntryId();
    const archiveResult = nextEntryId();
    const notesAsk = {
      type: "toolCall",
      id: "call-seed-ask-notes",
      name: "ask",
      arguments: { questions: [SEEDED_QUESTIONS.notes] },
      ghostAsk: { resultEntryId: notesResult, settled: "timedOut" },
    };
    const archiveAsk = {
      type: "toolCall",
      id: "call-seed-ask-archive",
      name: "ask",
      arguments: { questions: [SEEDED_QUESTIONS.archive] },
      ghostAsk: { resultEntryId: archiveResult, settled: "timedOut" },
    };
    const titled = {
      ...conversationIdentity("pi", `sess-${name}-1`),
      title: "first contact",
      createdAt: new Date(now - 7_200_000).toISOString(),
      updatedAt: new Date(now - 3_600_000).toISOString(),
      messages: [
        entry({ role: "user", content: "hello, who lives here?", timestamp: now - 7_200_000 }),
        entry({ role: "assistant", content: `I'm **${name}**. This thread was seeded by the mock so resume has history to show.`, timestamp: now - 7_195_000 }),
        entry({ role: "user", content: "and what do you remember about me?", timestamp: now - 3_610_000 }),
        entry({ role: "assistant", content: "Nothing yet — but branch that question and you get a second thread to ask it differently.", timestamp: now - 3_609_000 }),
        entry({ role: "user", content: "open the launch notes and tell me what's left", timestamp: now - 3_608_000 }),
        entry({
          role: "assistant",
          timestamp: now - 3_607_000,
          content: [
            { type: "text", text: "Opening the notes" },
            // A restored call has no live intent and no summary, so the card
            // falls back to the arguments: they have to say what it was for.
            {
              type: "toolCall",
              id: "call-seed-browser",
              name: "ghost_browser",
              arguments: { action: "open", url: "https://example.com/launch-notes" },
              failed: true,
            },
            notesAsk,
          ],
        }),
        entry({ role: "assistant", content: "I never got an answer, so I stopped at the roadmap section and left the rest alone.", timestamp: now - 3_606_000 }),
        entry({ role: "user", content: "and the old export archive?", timestamp: now - 3_605_000 }),
        entry({
          role: "assistant",
          timestamp: now - 3_604_000,
          content: [
            { type: "text", text: "One thing before I touch the archive" },
            archiveAsk,
          ],
        }),
        entry({ role: "assistant", content: "Nothing was chosen for me either, so the archive is exactly where it was.", timestamp: now - 3_600_000 }),
      ],
      // The ask *results* are entries of this conversation that no renderable
      // message carries — the transcript route drops tool-result messages — so
      // the mock keeps them here, which is also what makes an unknown
      // re-answer entryId a 400 rather than a guess.
      askResults: new Map([
        [notesResult, { call: notesAsk }],
        [archiveResult, { call: archiveAsk }],
      ]),
    };
    const untitled = {
      ...conversationIdentity("pi", `sess-${name}-2`),
      title: null, // background titling hasn't run — exercises the fallback label
      createdAt: new Date(now - 600_000).toISOString(),
      updatedAt: new Date(now - 600_000).toISOString(),
      messages: [
        entry({ role: "user", content: "quick question about memory", timestamp: now - 600_000 }),
        entry({ role: "assistant", content: "Ask away — this is the untitled seed conversation.", timestamp: now - 595_000 }),
      ],
    };
    // The Claude Code resume sidecar. It lists like any other conversation, but
    // that runtime owns both its title and its transcript, so the mock holds
    // neither: renaming it is 409 and reading it is 404. Its `messageCount` is
    // a number the sidecar reports rather than one derived from messages the
    // daemon has, so it is stored instead of counted.
    const sidecar = {
      ...conversationIdentity("claude-code", `sess-${name}-claude`),
      title: "Claude Code",
      createdAt: new Date(now - 1_800_000).toISOString(),
      updatedAt: new Date(now - 1_500_000).toISOString(),
      messageCount: 18,
      messages: [],
    };
    seed.set(titled.id, titled);
    seed.set(untitled.id, untitled);
    seed.set(sidecar.id, sidecar);
    sessionStore.set(name, seed);
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
    conversationId: s.conversationId,
    runtime: s.runtime,
    title: s.title ?? null,
    messages,
    total: s.messages.length,
    truncated: offset > 0 || offset + messages.length < s.messages.length,
  };
};

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
    ...conversationIdentity("pi", `sess-${name}-fork-${++forkSeq}`),
    title: forkTitle(store, source.title),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    // A copy is a new conversation, so its entries are new entries.
    messages: source.messages.slice(0, at).map(entry),
  };
  store.set(fork.id, fork);
  return {
    ...conversationIdentity("pi", fork.conversationId),
    sessionId: fork.conversationId,
    title: fork.title,
    draft: source.messages[at].content,
    transcript: transcriptOf(fork),
  };
}

const sessionSummary = (s) => ({
  id: s.id,
  conversationId: s.conversationId,
  runtime: s.runtime,
  title: s.title ?? null,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  messageCount: s.messageCount ?? s.messages.length,
  // Pin state is in the listing shape; the pin route itself is not mocked, so
  // nothing here ever flips it and the listing order is plain newest-first.
  pinned: s.pinned === true,
  unread: !s.readAt || s.updatedAt > s.readAt,
});

function recordTurn(name, sessionId, prompt, assistantText, ownerMessages = []) {
  if (!sessionId) return;
  const store = ghostSessions(name);
  const now = Date.now();
  const runtime = resolveCurrent(name).current?.provider === "claude-code" ? "claude-code" : "pi";
  const identity = conversationIdentity(runtime, sessionId);
  let s = store.get(identity.id);
  if (!s) {
    // A brand-new conversation the HUD minted: the daemon creates it lazily here.
    s = {
      ...identity,
      title: runtime === "claude-code" ? "Claude Code" : null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      messages: [],
    };
    store.set(identity.id, s);
  }
  s.messages.push(entry({ role: "user", content: prompt, timestamp: now }));
  for (const text of ownerMessages) {
    s.messages.push(entry({ role: "user", content: text, timestamp: now }));
  }
  s.messages.push(entry({ role: "assistant", content: assistantText, timestamp: now }));
  s.updatedAt = new Date(now).toISOString();
  // Background titling after the first turn: derive a title from the prompt.
  if (!s.title) s.title = prompt.slice(0, 40) || "New conversation";
  publishConversationUpdated(name, runtime, sessionId, s.updatedAt);
}

// ---- Greetings -------------------------------------------------------------
// The empty-chat opening line. Both branches of the contract are demoable:
// `casper` answers as a ghost that already knows the owner, `moaning-myrtle`
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

// ---- Pending asks ----------------------------------------------------------
// OMP's ask tool pauses the turn while the SSE stream stays open, so the mock
// pauses the same way: the turn script awaits a promise and the HTTP routes
// settle it. One ask per conversation, which is all OMP allows.

/** "<ghost> <conversation>" → the ask a paused turn is waiting on. */
const pendingAsks = new Map();
const askKey = (name, sessionId) => JSON.stringify([name, sessionId]);
let askSeq = 0;

/** Yielded by a script where a real turn blocks inside the ask tool. */
const ASK_WAIT = Symbol("ask-wait");

/** What the clock submits on expiry: the recommended option, or nothing. */
function timedOutResults(questions) {
  return questions.map((question) => {
    const options = question.options ?? [];
    const recommended = typeof question.recommended === "number"
      ? options[question.recommended] : undefined;
    return { id: question.id, selectedOptions: recommended ? [recommended.label] : [] };
  });
}

/**
 * Present a question and hand back the promise the turn blocks on. It resolves
 * with whichever got there first — a valid POST, or the deadline.
 */
function openAsk(name, sessionId, questions) {
  const key = askKey(name, sessionId);
  const { promise, resolve } = Promise.withResolvers();
  const armed = ASK_TIMEOUT_S > 0;
  const pending = {
    view: {
      id: `ask-${++askSeq}`,
      questions,
      ...(armed ? { timeoutAt: new Date(Date.now() + ASK_TIMEOUT_S * 1000).toISOString() } : {}),
    },
    timer: null,
    settle(answer) {
      if (pendingAsks.get(key) !== pending) return false;
      pendingAsks.delete(key);
      clearTimeout(pending.timer);
      resolve(answer);
      return true;
    },
  };
  pendingAsks.set(key, pending);
  // On expiry the daemon answers with the question's own recommendation and
  // lets the turn carry on, so a question nobody is there for never stalls one.
  if (armed) {
    pending.timer = setTimeout(
      () => pending.settle({ kind: "submit", timedOut: true, results: timedOutResults(questions) }),
      ASK_TIMEOUT_S * 1000,
    );
  }
  return promise;
}

/** How the question closed, for the tool card's summary line. */
function askSummary(answer) {
  if (answer.kind === "chat") return "Moved to chat";
  if (answer.kind !== "submit") return "Dismissed without an answer";
  const chosen = (answer.results ?? []).flatMap((result) => result.selectedOptions ?? []);
  const picked = chosen.length > 0 ? chosen.join(", ") : "nothing";
  return answer.timedOut ? `Timed out — answered with ${picked}` : `Answered with ${picked}`;
}

/** The persisted `ghostAsk.settled` a live answer becomes on a re-answer. */
const settledFrom = (answer) => {
  if (answer.kind === "chat") return "chat";
  if (answer.kind !== "submit") return "cancelled";
  return answer.timedOut ? "timedOut" : "submitted";
};

/** The question a scripted turn stops on. */
const LIVE_QUESTION = {
  id: "q-live",
  header: "Before I write anything",
  question: "I can take this three ways. Which do you want?",
  recommended: 1,
  options: [
    { label: "Answer here and stop", description: "One paragraph back, nothing written to disk." },
    {
      label: "Answer and keep it as a memory",
      description: "One concise memory file.",
      preview: "memory/what-the-owner-asked-for.md",
    },
    { label: "Answer and draft a doc", description: "A new file under docs/, yours to edit after." },
    { label: "Neither — forget I asked", description: "No answer, no files." },
  ],
};

/**
 * A scripted turn: the ghost narrating itself, one tool call — two for a ghost
 * still being written, and one more when the prompt asks for a question —
 * then a two-paragraph answer.
 */
function* script(name, prompt, sessionId) {
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
  yield {
    type: "tool_execution_start",
    id: "call_1",
    toolName: "read_memory",
    arguments: { query: prompt.slice(0, 24) },
    intent: "Read the relevant memory",
  };
  yield {
    type: "tool_execution_end",
    id: "call_1",
    toolName: "read_memory",
    isError: false,
    summary: "Memory checked",
  };
  for (let step = 1; step < TOOL_STEPS; step++) {
    const index = contentIndex++;
    const id = `call_long_${step}`;
    const toolName = step % 3 === 0 ? "grep" : (step % 3 === 1 ? "read" : "glob");
    const args = { step: step + 1, path: `docs/step-${step + 1}.md` };
    yield { type: "toolcall_start", contentIndex: index, id, toolName };
    yield { type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args) };
    yield {
      type: "toolcall_end",
      contentIndex: index,
      toolCall: { type: "toolCall", id, name: toolName, arguments: args },
    };
    yield {
      type: "tool_execution_start",
      id,
      toolName,
      arguments: args,
      intent: `Run tool-heavy step ${step + 1}`,
    };
    yield {
      type: "tool_execution_end",
      id,
      toolName,
      isError: false,
      summary: `Completed step ${step + 1}`,
    };
  }
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
  // The ask surface, on the documented trigger word. `toolcall_end` clears the
  // HUD's pending ask, so the question opens after it — on the
  // `tool_execution_start` the client answers by starting its ask poll.
  let asked = "";
  if (/ask/iu.test(prompt)) {
    const index = contentIndex++;
    const questions = [LIVE_QUESTION];
    const call = { type: "toolCall", id: "call_ask", name: "ask", arguments: { questions } };
    yield { type: "toolcall_start", contentIndex: index, id: call.id, toolName: "ask" };
    yield { type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments) };
    yield { type: "toolcall_end", contentIndex: index, toolCall: call };
    const wait = openAsk(name, sessionId, questions);
    yield {
      type: "tool_execution_start",
      id: call.id,
      toolName: "ask",
      arguments: call.arguments,
      intent: "Ask before writing anything",
    };
    const answered = yield { sentinel: ASK_WAIT, wait };
    asked = askSummary(answered);
    yield { type: "tool_execution_end", id: call.id, toolName: "ask", isError: false, summary: asked };
  }
  const answer = contentIndex++;
  yield { type: "text_start", contentIndex: answer };
  const reply =
    `You said: **${prompt}**\n\n`
    + (asked ? `On the question: **${asked}**.\n\n` : "")
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
  if (!flag("--omit-terminal") && !flag("--stall-stream")) {
    yield flag("--fail")
      ? { type: "error", reason: "error", usage, errorMessage: "mock-ghostd --fail" }
      : { type: "done", reason: "stop", usage };
  }
}

/** Conversation keys with a turn in flight; the real daemon's busy gate is per conversation. */
const answering = new Set();
/** Active turn queues, keyed exactly like the daemon's session routes. */
const activeTurns = new Map();
const turnKey = (name, sessionId) => JSON.stringify([name, sessionId]);
const ghostIsAnswering = (name) => [...answering].some((key) => {
  try {
    return JSON.parse(key)[0] === name;
  } catch {
    return false;
  }
});

/** Open an SSE response, and free a paused turn if the client walks away. */
function openStream(req, res, name, sessionId) {
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
    // Nobody is left to answer, and the ask holds `answering` open until it is
    // settled — which would leave the ghost busy for the whole timeout.
    pendingAsks.get(askKey(name, sessionId))?.settle({ kind: "cancel" });
  });
  return stream;
}

/**
 * Drive a scripted generator onto an SSE response. Events go out as they are
 * yielded; the ASK_WAIT sentinel is awaited instead and its answer fed back in,
 * which is how a turn pauses on a question. Returns the last completed
 * assistant text, or null if the client left mid-stream.
 */
async function pump(res, events, stream, turn) {
  let assistantText = "";
  let resumeWith;
  for (;;) {
    const step = events.next(resumeWith);
    resumeWith = undefined;
    if (step.done) return assistantText;
    if (stream.closed) return null;
    const event = step.value;
    if (event.sentinel === ASK_WAIT) {
      resumeWith = await event.wait;
      continue;
    }
    if (event.type === "text_end") assistantText = event.content;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // OMP injects accepted steering at the next provider boundary and emits a
    // user message before the following assistant step. QueueLine owns it until
    // this point; owner_message moves it into transcript order.
    if (event.type === "tool_execution_end" && turn.steering.length > 0) {
      for (const text of turn.steering.splice(0)) {
        turn.consumedOwners.push(text);
        res.write(`data: ${JSON.stringify({ type: "owner_message", text })}\n\n`);
      }
    }
    await new Promise((r) => setTimeout(r, event.type === "text_delta" ? DELTA_MS : 220));
  }
}

async function streamTurn(req, res, name, body) {
  const prompt = extractPrompt(body);
  const sessionId = body?.options?.sessionId;
  const stream = openStream(req, res, name, sessionId);
  const key = turnKey(name, sessionId);
  const turn = { streaming: true, steering: [], followUp: [], consumedOwners: [] };
  activeTurns.set(key, turn);
  answering.add(key);
  let assistantText;
  try {
    assistantText = await pump(res, script(name, prompt, sessionId), stream, turn);
  } finally {
    answering.delete(key);
    turn.streaming = false;
    activeTurns.delete(key);
  }
  if (assistantText === null) return;
  if (flag("--stall-stream")) {
    await new Promise((resolve) => res.once("close", resolve));
    return;
  }
  res.end();
  // Persist the completed turn so the session listing + transcript reflect it,
  // matching the daemon's lazy-create-and-title behaviour. A --fail turn wrote
  // no reply, so nothing is recorded.
  if (!flag("--fail")) {
    recordTurn(name, sessionId, prompt, assistantText, turn.consumedOwners);
  }
}

/** Where the message carrying an ask sits, or -1 once a branch discarded it. */
const askCallIndex = (session, call) =>
  session.messages.findIndex((m) => Array.isArray(m.content) && m.content.includes(call));

/**
 * Re-answering a persisted ask: rewind to the message that carried it, put the
 * same question back on screen, then answer from there. The real daemon reopens
 * the ask first and commits the branch after; the mock commits first so the
 * dialog opens over history that already reads as rewound.
 */
function* reanswerScript(name, sessionId, session, entryId, record) {
  const call = record.call;
  const questions = call.arguments.questions;
  const rewound = session.messages.slice(0, askCallIndex(session, call) + 1);
  yield { type: "branch_changed", transcript: transcriptOf({ ...session, messages: rewound }) };
  const id = `ask-reanswer-${entryId}`;
  const wait = openAsk(name, sessionId, questions);
  yield {
    type: "tool_execution_start",
    id,
    toolName: "ask",
    arguments: { questions },
    intent: "Re-answer an earlier question",
  };
  const answered = yield { sentinel: ASK_WAIT, wait };
  const settled = askSummary(answered);
  yield { type: "tool_execution_end", id, toolName: "ask", isError: false, summary: settled };
  // The branch is a commit, not a preview: the old result is overwritten and
  // everything after it is gone, so a second re-answer starts from what this
  // one decided rather than from the seed.
  call.ghostAsk.settled = settledFrom(answered);
  const reply = `**${settled}** — and everything that came after the question went with the branch.`;
  yield { type: "text_start", contentIndex: 0 };
  for (const chunk of reply.match(/\s*\S+/gu) ?? []) {
    yield { type: "text_delta", contentIndex: 0, delta: chunk };
  }
  yield { type: "text_end", contentIndex: 0, content: reply };
  session.messages = [...rewound, entry({ role: "assistant", content: reply, timestamp: Date.now() })];
  session.updatedAt = new Date().toISOString();
  const usage = {
    input: 640,
    output: reply.length >> 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 640 + (reply.length >> 2),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  yield { type: "done", reason: "stop", usage };
}

async function streamReanswer(req, res, name, sessionId, session, entryId, record) {
  const stream = openStream(req, res, name, sessionId);
  const key = turnKey(name, sessionId);
  answering.add(key);
  try {
    await pump(res, reanswerScript(name, sessionId, session, entryId, record), stream, {
      steering: [],
      consumedOwners: [],
    });
  } finally {
    answering.delete(key);
  }
  res.end();
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
  ["smol_model", "smol", "Fast"],
  ["slow_model", "slow", "Thinking"],
  ["vision_model", "vision", "Vision"],
  ["plan_model", "plan", "Architect"],
  ["designer_model", "designer", "Designer"],
  ["commit_model", "commit", "Commit"],
  ["tiny_model", "tiny", "Tiny"],
  ["task_model", "task", "Subtask"],
  ["advisor_model", "advisor", "Advisor"],
  ["general_purpose_model", "general", "General purpose"],
  ["research_model", "research", "Research"],
];
const AUTO_ROUTE_ROLES = new Set([
  "chat_model", "smol_model", "slow_model", "designer_model",
  "tiny_model", "task_model", "advisor_model",
]);
const COMPAT_ROUTE_ROLES = new Set(["general_purpose_model", "research_model"]);

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
  const limitValue = params.get("limit");
  const offsetValue = params.get("offset");
  const limit = limitValue === null ? 100
    : Math.max(1, Math.min(500, Math.floor(Number(limitValue))));
  const requestedOffset = offsetValue === null ? 0 : Number(offsetValue);
  const cur = resolveCurrent(name).current;

  let rows = CATALOG.filter((m) => (scope === "available" ? credentialed.has(m.provider) : true));
  if (provider) rows = rows.filter((m) => m.provider === provider);
  if (q) rows = rows.filter((m) => (m.id + " " + m.name).toLowerCase().includes(q));
  const total = rows.length;
  const offset = Math.min(total,
    requestedOffset < 0 ? 0 : Math.floor(requestedOffset));
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
  const automatic = resolveCurrent(name).current;
  return {
    roles: ROUTE_ROLES.filter(([role]) => !COMPAT_ROUTE_ROLES.has(role) || state[role])
      .map(([role, ompRole, label]) => {
      const configured = state[role] || {};
      const primary = role === "chat_model"
        ? (configured.primary || roles.get(name)) : configured.primary;
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
        effective: view(primary || (AUTO_ROUTE_ROLES.has(role) ? automatic : null)),
        source: primary ? "explicit" : (AUTO_ROUTE_ROLES.has(role) && automatic
          ? "auto" : "unavailable"),
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


  if (parts.length === 4 && parts[3] === "context" && req.method === "GET") {
    return json(res, 200, contextSnapshot(name));
  }
  if (parts.length === 4 && parts[3] === "context" && req.method === "DELETE") {
    const body = await readBody(req).catch(() => ({}));
    const section = body?.section;
    const path = typeof body?.path === "string" ? body.path : "";
    if ((section !== "docs" && section !== "memory") || path === ""
        || body?.confirm !== path) {
      return json(res, 400, {
        error: {
          message: "Context deletion requires an exact path confirmation",
          code: "confirmation_required",
        },
      });
    }
    const catalog = section === "docs" ? MOCK_DOCS : MOCK_MEMORY;
    if (!catalog.some((item) => item.path === path) || contextDeletedFor(name).has(path)) {
      return json(res, 404, {
        error: { message: "No such context file", code: "not_found" },
      });
    }
    const trash = join(GHOSTS_ROOT, ".mock-trash", name, path.replace(/\//gu, "--"));
    if (OWNS_GHOSTS_ROOT) {
      mkdirSync(join(GHOSTS_ROOT, ".mock-trash", name), { recursive: true });
      renameSync(join(ghost.dir, path), trash);
    }
    contextDeletedFor(name).add(path);
    return json(res, 200, { ok: true, path, trash });
  }
  // Banishing a ghost. The real daemon moves the home to the XDG trash so it is
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
    deletedContext.delete(name);
    mcpStore.delete(name);
    liveStates.delete(name);
    collabStates.delete(name);
    roles.delete(name);
    routing.delete(name);
    return json(res, 200, { ok: true, trash: join(TRASH_ROOT, name) });
  }

  // Renaming a ghost moves its home directory; conversation ids survive it
  // untouched, so the mock re-keys the ghost's state under the new name rather
  // than rebuilding any of it. A pending ask is keyed by ghost name too, but
  // one only exists mid-turn and `ghost_busy` already refuses that.
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
    for (const store of [sessionStore, deletedContext, mcpStore, liveStates, collabStates, roles, routing]) {
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
    ghostMcp(name).set(serverName, structuredClone(body.config));
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
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "live"
      && req.method === "GET") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code has no live voice" } });
    }
    return json(res, 200, ghostLive(name, conversation.id));
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "live"
      && req.method === "POST") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code has no live voice" } });
    }
    const body = await readBody(req).catch(() => ({}));
    const action = body?.action;
    const current = ghostLive(name, conversation.id);
    if (!["start", "mute", "unmute", "stop"].includes(action)) {
      return json(res, 400, {
        error: { message: "Unknown live-voice action", code: "invalid_request" },
      });
    }
    if (action === "start") {
      return json(res, 200, setGhostLive(name, conversation.id, {
        phase: "listening",
        muted: false,
        inputLevel: 0.42,
        transcript: [
          { role: "you", text: "Can you hear me?" },
          { role: "ghost", text: "Clearly." },
        ],
        provider: "openai-codex",
        remote: true,
      }));
    }
    if (action === "stop") {
      return json(res, 200, setGhostLive(name, conversation.id, {
        ...current,
        phase: "stopped",
        muted: false,
        inputLevel: 0,
      }));
    }
    return json(res, 200, setGhostLive(name, conversation.id, {
      ...current,
      phase: action === "mute" ? "muted" : "listening",
      muted: action === "mute",
      inputLevel: action === "mute" ? 0 : 0.36,
    }));
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "collab") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code has no collaboration host" } });
    }
    // One seeded ghost demonstrates a daemon that deliberately defers the
    // feature. The UI should render this as product status, not a red HTTP dump.
    if (name === "moaning-myrtle") {
      return json(res, 501, {
        error: {
          message: "Remote collaboration is deferred in this daemon build.",
          code: "not_supported",
        },
      });
    }
    if (req.method === "GET") return json(res, 200, ghostCollab(name, conversation.id));
    if (req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      if (body?.action === "stop") {
        return json(res, 200, setGhostCollab(name, conversation.id,
          { active: false, phase: "stopped" }));
      }
      if (body?.action !== "start" || body.confirmed !== true
          || (body.writable !== true && body.writable !== false)) {
        return json(res, 400, {
          error: { message: "Unknown collaboration action", code: "invalid_request" },
        });
      }
      const token = ++collabSeq;
      const relay = typeof body.relayUrl === "string" && body.relayUrl.trim() !== ""
        ? body.relayUrl.replace(/\/$/u, "") : "https://relay.example.test";
      return json(res, 200, setGhostCollab(name, conversation.id, {
        active: true,
        phase: "connected",
        writable: body.writable,
        relayUrl: relay,
        readOnlyUrl: `${relay}/read/demo-${token}`,
        ...(body.writable ? { writableUrl: `${relay}/write/demo-${token}` } : {}),
      }));
    }
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
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const deleted = ghostSessions(name).delete(conversation.id);
    if (deleted) publishConversationUpdated(name, conversation.runtime, conversation.conversationId);
    return deleted
      ? json(res, 200, { ok: true })
      : json(res, 404, { error: { message: "no such session", code: "not_found" } });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "read" && req.method === "PUT") {
    await readBody(req).catch(() => ({}));
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    const s = ghostSessions(name).get(conversation.id);
    if (!s) return json(res, 404, { error: { message: "no such session", code: "not_found" } });
    s.readAt = new Date().toISOString();
    publishConversationUpdated(name, s.runtime, s.conversationId, s.updatedAt);
    return json(res, 200, { ok: true, readAt: s.readAt });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "commands" && req.method === "GET") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code has no OMP commands" } });
    }
    return json(res, 200, { commands: MOCK_COMMANDS });
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
    const s = ghostSessions(name).get(conversation.id);
    // A Claude Code conversation's transcript lives in that runtime's storage,
    // so there is nothing here to read even though the row is in the listing.
    if (!s || s.runtime === "claude-code") {
      return json(res, s ? 409 : 404, {
        error: {
          message: s ? "Claude Code owns this transcript" : "no such session",
          code: s ? "not_supported" : "session_not_found",
        },
      });
    }
    return json(res, 200, transcriptOf(s, url.searchParams));
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "queue") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code has no OMP queue" } });
    }
    const turn = activeTurns.get(turnKey(name, conversation.conversationId));
    const snapshot = () => ({
      streaming: turn?.streaming === true,
      count: (turn?.steering.length ?? 0) + (turn?.followUp.length ?? 0),
      steering: turn?.steering ?? [],
      followUp: turn?.followUp ?? [],
    });
    if (req.method === "GET") return json(res, 200, snapshot());
    if (req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (body?.mode !== "steer" && body?.mode !== "followUp") {
        return json(res, 400, {
          error: { message: 'mode must be "steer" or "followUp"', code: "invalid_request" },
        });
      }
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
      const queue = body.mode === "steer" ? turn.steering : turn.followUp;
      queue.push(text);
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
    const s = ghostSessions(name).get(conversation.id);
    if (!s) return json(res, 404, { error: { message: "no such session", code: "not_found" } });
    if (s.runtime === "claude-code") {
      return json(res, 409, { error: { message: "Claude Code owns this conversation's title", code: "not_supported" } });
    }
    s.title = title;
    publishConversationUpdated(name, s.runtime, s.conversationId, s.updatedAt);
    return json(res, 200, { ok: true, title: s.title });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "branch" && req.method === "POST") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code cannot branch here" } });
    }
    const s = ghostSessions(name).get(conversation.id);
    if (!s) return json(res, 404, { error: { message: "no such session", code: "not_found" } });
    if (answering.has(turnKey(name, conversation.conversationId))) {
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

  // ---- The ask a paused turn is waiting on ---------------------------------
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "ask" && req.method === "GET") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code has no OMP ask" } });
    }
    const pending = pendingAsks.get(askKey(name, conversation.conversationId));
    return json(res, 200, { ask: pending ? pending.view : null });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "ask" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code has no OMP ask" } });
    }
    const pending = pendingAsks.get(askKey(name, conversation.conversationId));
    // Settled or superseded reads the same from here: the question this client
    // is holding is not the one being waited on.
    if (!pending || pending.view.id !== body?.askId) {
      return json(res, 409, {
        error: { message: "this conversation is not waiting for that answer", code: "ask_not_pending" },
      });
    }
    if (body?.kind !== "submit" && body?.kind !== "chat" && body?.kind !== "cancel") {
      return json(res, 400, { error: { message: 'kind must be "submit", "chat", or "cancel"', code: "invalid_request" } });
    }
    // The daemon validates every result against the question that was asked;
    // the mock takes the shape on trust — the dialog is what is under test here.
    pending.settle({ kind: body.kind, results: Array.isArray(body.results) ? body.results : [] });
    return json(res, 200, { ok: true });
  }
  if (parts[3] === "sessions" && parts.length === 6 && parts[5] === "reanswer" && req.method === "POST") {
    const conversation = routeConversation(parts);
    if (!conversation) return json(res, 400, { error: { code: "invalid_conversation_id" } });
    if (conversation.runtime !== "pi") {
      return json(res, 409, { error: { code: "not_supported", message: "Claude Code has no OMP ask" } });
    }
    const s = ghostSessions(name).get(conversation.id);
    if (!s) return json(res, 404, { error: { message: "no such session", code: "not_found" } });
    if (answering.has(turnKey(name, conversation.conversationId))) {
      return json(res, 409, {
        error: { message: `${name} is still answering — stop the turn first`, code: "session_busy" },
      });
    }
    const body = await readBody(req).catch(() => ({}));
    const entryId = typeof body?.entryId === "string" ? body.entryId : "";
    const record = s.askResults?.get(entryId);
    // An ask an earlier branch discarded is no longer re-answerable: the
    // message that carried it went with everything after that branch point.
    if (!record || askCallIndex(s, record.call) < 0) {
      return json(res, 400, {
        error: { message: "no ask result with that entryId", code: "ask_not_reanswerable" },
      });
    }
    return streamReanswer(req, res, name, conversation.conversationId, s, entryId, record);
  }

  // ---- Model indicator + switcher ------------------------------------------
  if (parts[3] === "model" && parts.length === 4 && req.method === "GET") {
    return json(res, 200, resolveCurrent(name));
  }
  if (parts[3] === "models" && parts.length === 4 && req.method === "GET") {
    for (const field of ["limit", "offset"]) {
      const value = url.searchParams.get(field);
      if (value !== null && !Number.isFinite(Number(value))) {
        return json(res, 400, {
          error: { message: `"${field}" must be a number.`, code: "invalid_request" },
        });
      }
    }
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
    } else if (body.target === "clear_primary") {
      route.primary = null;
      if (body.role === "chat_model") roles.delete(name);
    } else if (body.target === "replace_fallbacks") {
      if (!Array.isArray(body.fallbacks))
        return json(res, 400, { error: { message: "fallbacks must be an array", code: "invalid_request" } });
      const replacement = [];
      for (const candidate of body.fallbacks) {
        const model = CATALOG.find((m) => m.provider === candidate?.provider && m.id === candidate?.id);
        if (!model)
          return json(res, 400, { error: { message: "unknown model", code: "unknown_model" } });
        replacement.push({ provider: model.provider, id: model.id });
      }
      route.fallbacks = replacement;
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
