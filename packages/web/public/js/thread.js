/**
 * One machine's conversation as a messaging thread, worked out apart from the
 * page so it can be checked on its own (check.html): the route, the bubbles a
 * transcript makes, the last of them while the ghost's question is open, a
 * running turn folded into the same shape, the pages of a long transcript, and
 * the time on a machine's row.
 */
import { toolCall } from "./tool-call.js";

/** The machine a hash names, `#/<host>`; null for the machine list. */
export function routeHost(hash) {
  const first = String(hash || "").replace(/^#\/?/, "").split("/")[0];
  try { return decodeURIComponent(first) || null; } catch { return null; }
}
export const link = (host) => "#/" + (host ? encodeURIComponent(host) : "");

/** An attachment line, `![image](attachments/<file>)`, gives its path; any other line gives null. */
export function attachmentOf(line) {
  const t = line.trim(), at = t.indexOf("](attachments/");
  return t.startsWith("![") && t.endsWith(")") && at > 0 && !t.slice(at + 2, -1).includes(" ") ? t.slice(at + 2, -1) : null;
}

const words = (parts) => parts.filter((p) => p.type === "text" && p.text?.trim()).map((p) => p.text).join("\n\n");

/** What the ghost did that is not what it said: a part of its working, or null for words. */
function stepOf(part) {
  if (part.type === "thinking" || part.type === "handoff") return part.text?.trim() ? { type: part.type, text: part.text.trim() } : null;
  if (part.type !== "toolCall") return null;
  const step = { type: "call", asks: part.name === "ask", line: toolCall(part.name, part.arguments), output: (part.output || "").trimEnd() };
  if (part.failed) step.failed = true;
  if (part.running) step.running = true;
  return step;
}

/**
 * Transcript messages as the bubbles a messaging thread shows, oldest first:
 *
 *   { kind: "owner", key, text, pics }     the owner's words and the photos sent with them
 *   { kind: "ghost", key, steps, text }    what the ghost said, under the working that led to it
 *                                          (`error` on a failed turn)
 *   { kind: "hook", key, text }            what a stop hook told the ghost to go on with
 *
 * A ghost bubble closes at its words: working after them opens the next, so
 * each reply sits under exactly the reasoning and commands that came before it.
 */
export function thread(messages) {
  const items = [];
  for (const m of messages) {
    const parts = m.content || [];
    if (m.role === "user") {
      const lines = words(parts).split("\n");
      const text = lines.filter((line) => !attachmentOf(line)).join("\n").trim(), pics = lines.map(attachmentOf).filter(Boolean);
      if (text || pics.length) items.push({ kind: "owner", key: m.entryId, text, pics });
    } else if (m.role === "hook") {
      if (words(parts).trim()) items.push({ kind: "hook", key: m.entryId + ".hook", text: words(parts).trim() });
    } else if (m.role === "assistant") {
      let bubble = null, n = 0;
      const open = () => {
        bubble = { kind: "ghost", key: m.entryId + "." + n++, steps: [], text: "" };
        items.push(bubble);
      };
      for (const part of parts) {
        const step = stepOf(part);
        if (step) {
          if (!bubble || bubble.text) open();
          bubble.steps.push(step);
        } else if (part.type === "text" && part.text?.trim()) {
          if (!bubble) open();
          bubble.text += (bubble.text ? "\n\n" : "") + part.text;
        }
      }
      if (m.errorMessage) {
        if (!bubble) open();
        bubble.error = m.errorMessage;
      }
    }
  }
  return items;
}

/** What the ghost said without its question's numbered answers under it: only that exact ending is taken off. */
export function withoutAnswers(said, offered) {
  const numbered = offered.map((answer, index) => `${index + 1}. ${answer}`).join("\n"), text = said.trimEnd();
  return numbered && text.endsWith(numbered) ? text.slice(0, -numbered.length).trimEnd() : said;
}

/**
 * The thread while `question` is open: its answers are buttons, so the last bubble does not list them too.
 * An answered question keeps its list: that is the record.
 */
export function asking(items, question) {
  const last = items.at(-1);
  if (!question?.options?.length || last?.kind !== "ghost") return items;
  return items.slice(0, -1).concat({ ...last, text: withoutAnswers(last.text, question.options) });
}

/** The folded line over a bubble's working: "Thought, ran 3 commands, 1 failed". */
export function worked(steps) {
  const calls = steps.filter((s) => s.type === "call" && !s.asks), failed = calls.filter((s) => s.failed).length;
  const did = [];
  if (steps.some((s) => s.type === "handoff")) did.push("wrote a handoff note");
  if (steps.some((s) => s.type === "thinking")) did.push("thought");
  if (calls.length) did.push(calls.length === 1 ? "ran 1 command" : `ran ${calls.length} commands`);
  if (failed) did.push(`${failed} failed`);
  if (steps.some((s) => s.asks)) did.push("asked you");
  const line = did.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * Folds one turn-wire event into `messages`, in the shape the transcript will
 * give the turn once it is logged, so a running turn and a finished one draw
 * alike. Returns the daemon's notice when the event is one ("Loading the local
 * model…"): that is not reasoning, and is not kept.
 */
export function fold(messages, ev) {
  const add = (role, content) => messages.push({ role, entryId: "live" + messages.length, content });
  const said = () => {
    if (messages.at(-1)?.role !== "assistant") add("assistant", []);
    return messages.at(-1).content;
  };
  const call = () => messages.flatMap((m) => m.content).find((p) => p.type === "toolCall" && p.id === ev.id);
  if (ev.type === "pass") {
    if (messages.at(-1)?.role === "assistant" && messages.at(-1).content.length) add("assistant", []);
  } else if (ev.type === "owner_message") {
    add("user", [{ type: "text", text: ev.text }]);
  } else if (ev.type === "thinking") {
    const parts = said(), last = parts.at(-1);
    if (last?.type === "thinking") last.text += ev.delta;
    else if (ev.delta.trimStart().startsWith("Loading the local model")) return ev.delta.trim();
    else parts.push({ type: "thinking", text: ev.delta.trimStart() });
  } else if (ev.type === "text_start") {
    said().push({ type: "text", text: "" });
  } else if (ev.type === "text_delta") {
    const parts = said();
    if (parts.at(-1)?.type !== "text") parts.push({ type: "text", text: "" });
    parts.at(-1).text += ev.delta;
  } else if (ev.type === "tool_execution_start") {
    said().push({ type: "toolCall", id: ev.id, name: ev.toolName, arguments: ev.arguments, running: true });
  } else if (ev.type === "tool_execution_update" || ev.type === "tool_execution_end") {
    // What it has printed lately while it runs, then all of it.
    const part = call(), ended = ev.type === "tool_execution_end";
    if (!part) return null;
    part.output = (ended ? ev.output ?? ev.summary : ev.summary) || "";
    if (ended) {
      delete part.running;
      if (ev.isError) part.failed = true;
    }
  } else if (ev.type === "error" && ev.reason !== "aborted") {
    said();
    messages.at(-1).errorMessage = ev.errorMessage || ev.reason;
  }
  return null;
}

/** How many messages the thread reads at a time. */
export const PAGE = 30;
/** Where the newest page of `total` messages starts, counted from the oldest. */
export const newestOffset = (total, size = PAGE) => Math.max(0, total - size);
/** The page before the one starting at `offset`, `{ offset, limit }`; null at the oldest message. */
export const olderPage = (offset, size = PAGE) => (offset > 0 ? { offset: Math.max(0, offset - size), limit: Math.min(size, offset) } : null);

/** A time as a chat list shows it: the hour today, then "Yesterday", the weekday, the date. Empty for none. */
export function when(time, now = Date.now(), locale) {
  const then = new Date(time || NaN);
  if (Number.isNaN(then.getTime())) return "";
  const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(then)) / 86400000);
  if (days <= 0) return then.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString(locale, { weekday: "long" });
  return then.toLocaleDateString(locale, { dateStyle: "short" });
}

/**
 * A turn's events, each once and in order, from the one response that carries
 * the turn. Its last is `done` or `error`; a response that ends without one broke.
 */
export async function* turnEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6));
    }
  }
}
