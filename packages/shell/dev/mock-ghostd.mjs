#!/usr/bin/env node
/**
 * mock-ghostd — just enough of the CONTRACTS.md daemon API to build and demo
 * the Quickshell surfaces without pi, models, or a real ghost home.
 *
 * Implements:
 *   GET  /api/ghosts                  → [{ name, dir, createdAt }]
 *   POST /api/ghosts { name }         → 201 + the new ghost
 *   POST /api/ghosts/:name/messages   → pi-messages SSE (canned reply)
 *   GET  /api/ghosts/:name/sessions   → session listing
 *
 * Nothing touches the filesystem: ghosts live in memory and vanish on exit.
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
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-ghost-turn-id": req.headers["x-ghost-turn-id"] ?? crypto.randomUUID(),
  });
  const events = script(name, prompt);
  let closed = false;
  res.on("close", () => (closed = true));
  for (const event of events) {
    if (closed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    await new Promise((r) => setTimeout(r, event.type === "text_delta" ? DELTA_MS : 220));
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
  if (parts[3] === "sessions" && req.method === "GET") {
    return json(res, 200, [
      { id: "sess-mock-1", title: "first contact", updatedAt: new Date().toISOString(), messageCount: 4 },
    ]);
  }
  return json(res, 404, { error: "not found" });
}).listen(PORT, HOST, () => {
  console.error(`mock-ghostd on http://${HOST}:${PORT} — ghosts: ${ghosts.map((g) => g.name).join(", ")}`);
});
