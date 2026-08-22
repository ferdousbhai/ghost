/**
 * The code that runs *inside* the page.
 *
 * These are strings, not functions, on purpose. This package compiles with
 * `lib: ["ES2023"]` and `types: ["node"]` — there is no DOM in scope, and adding
 * it would put `document`, `fetch`, and friends into every module in the package
 * just so three snippets can typecheck. Playwright's `evaluate()` accepts a
 * string expression that evaluates to a function, so the snippets stay here,
 * quarantined and named, instead of being smeared through the session module.
 *
 * The trade-off is real and worth stating: nothing in this file is typechecked
 * or unit-testable without a browser. Keep each snippet small enough to read in
 * one go, and keep the contract with `browser-session.ts` written down in the
 * result interfaces below.
 */

/** The attribute `find` stamps onto matched elements to mint a stable ref. */
export const REF_ATTRIBUTE = "data-ghost-ref";

/**
 * Wrap a snippet into an expression that actually *runs*.
 *
 * Playwright's string form of `evaluate()` evaluates an expression; it does not
 * call it. Hand it `(arg) => {...}` and the page dutifully creates a function,
 * fails to serialize it, and returns `undefined` — which looks exactly like a
 * page that had nothing to say. The `arg` parameter is inlined as a JSON literal
 * for the same reason: the second argument to `evaluate()` is only wired up for
 * the *function* form, so a string snippet never receives it.
 */
export function callScript(script: string, arg?: unknown): string {
  return `(${script})(${arg === undefined ? "" : JSON.stringify(arg)})`;
}

/**
 * Readable text for the current page, untruncated — the session layer owns the
 * budget, because the relay backend has to apply the same one.
 *
 * `innerText` rather than `textContent`: it is layout-aware, so it already skips
 * `script`, `style`, and anything hidden, and it keeps the line breaks that make
 * the result legible. The container preference (`article` → `main` → `[role=main]`
 * → `body`) is the cheap 90% of what Readability does, without the dependency.
 */
export const READ_PAGE_SCRIPT = `() => {
  const pick = document.querySelector("article")
    || document.querySelector("main")
    || document.querySelector("[role=main]")
    || document.body;
  const raw = pick ? (pick.innerText || pick.textContent || "") : "";
  const text = raw
    .replace(/[ \\t\\u00a0]+/g, " ")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
  return { title: document.title || "", url: location.href, text };
}`;

/**
 * Find elements by CSS selector, or — when the query is not a selector that
 * matches anything — by their visible text and accessible attributes.
 *
 * Every match is stamped with a `data-ghost-ref` attribute, which is what makes
 * a ref usable later: the ref *is* a selector, so acting on `e3` needs no
 * handle held open across tool calls and no assumption that the DOM stayed
 * still. Each call clears the previous stamps, so `e1` always means "the first
 * result of the most recent find".
 */
export const FIND_ELEMENTS_SCRIPT = `({ query, limit, attribute }) => {
  for (const stale of document.querySelectorAll("[" + attribute + "]")) {
    stale.removeAttribute(attribute);
  }

  const results = [];
  const seen = new Set();
  const describe = (el) => {
    if (!el || seen.has(el) || results.length >= limit) return;
    seen.add(el);
    const ref = "e" + (results.length + 1);
    el.setAttribute(attribute, ref);
    let visible = false;
    try {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      visible = rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    } catch {}
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const attr = (name) => el.getAttribute(name) || undefined;
    results.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: attr("role"),
      name: attr("aria-label") || attr("placeholder") || attr("name") || attr("title"),
      href: attr("href"),
      value: typeof el.value === "string" ? el.value.slice(0, 120) : undefined,
      text: text.slice(0, 160),
      visible,
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
    });
  };

  let selectorHit = false;
  try {
    const nodes = document.querySelectorAll(query);
    if (nodes.length > 0) {
      selectorHit = true;
      for (const node of nodes) describe(node);
    }
  } catch {}

  if (!selectorHit) {
    const needle = query.toLowerCase();
    const interactive = (el) =>
      /^(a|button|input|textarea|select|summary|label|option)$/.test(el.tagName.toLowerCase())
      || el.hasAttribute("role") || el.hasAttribute("onclick");
    const hits = [];

    // Deepest text match only: an ancestor whose text matches because a child's
    // does is noise, not a target.
    for (const el of document.querySelectorAll("body *")) {
      const own = el.innerText || el.textContent || "";
      if (!own.toLowerCase().includes(needle)) continue;
      let deeper = false;
      for (const child of el.children) {
        const childText = child.innerText || child.textContent || "";
        if (childText.toLowerCase().includes(needle)) { deeper = true; break; }
      }
      if (!deeper) hits.push(el);
    }

    const fields = "[aria-label],[placeholder],[title],[name],input,textarea,select,button";
    for (const el of document.querySelectorAll(fields)) {
      const haystack = [
        el.getAttribute("aria-label"), el.getAttribute("placeholder"),
        el.getAttribute("title"), el.getAttribute("name"),
        typeof el.value === "string" ? el.value : null,
      ].filter(Boolean).join(" ").toLowerCase();
      if (haystack.includes(needle)) hits.push(el);
    }

    hits.sort((left, right) => Number(interactive(right)) - Number(interactive(left)));
    for (const el of hits) describe(el);
  }

  return results;
}`;
