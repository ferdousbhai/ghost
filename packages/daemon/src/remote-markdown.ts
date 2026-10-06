/**
 * The remote viewer's markdown: block and inline syntax a reply actually
 * uses, built as DOM nodes so model text never reaches `innerHTML`. Embedded
 * in the page by source (`renderMarkdown.toString()`), so it must stay
 * self-contained: no imports, no closures over module scope.
 */
export interface MarkdownNode {
  append(...kids: (MarkdownNode | string)[]): void;
  setAttribute(name: string, value: string): void;
}
export interface MarkdownDocument {
  createElement(tag: string): MarkdownNode;
  createDocumentFragment(): MarkdownNode;
}

export function renderMarkdown(source: string, doc: MarkdownDocument): MarkdownNode {
  const out = doc.createDocumentFragment();
  const el = (tag: string, ...kids: (MarkdownNode | string)[]) => {
    const node = doc.createElement(tag);
    node.append(...kids);
    return node;
  };
  const inline = (text: string): (MarkdownNode | string)[] => {
    const parts: (MarkdownNode | string)[] = [];
    const token =
      /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])|(?<!\w)_(?!\s)([^_]+?)_(?!\w)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;
    let last = 0;
    for (let m = token.exec(text); m; m = token.exec(text)) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) parts.push(el("code", (m[2] ?? "").trim()));
      else if (m[3]) parts.push(el("strong", ...inline(m[3])));
      else if (m[4] !== undefined || m[8]) {
        const href = m[5] ?? m[8] ?? "";
        if (!/^(https?:|mailto:)/i.test(href)) {
          parts.push(m[0]);
          continue;
        }
        const a = el("a", ...(m[8] ? [m[8]] : inline(m[4] ?? "")));
        a.setAttribute("href", href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        parts.push(a);
      } else parts.push(el("em", ...inline(m[6] ?? m[7] ?? "")));
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const at = (n: number): string => lines[n] ?? "";
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    // A fence closes only on one at least as long, as in CommonMark.
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !at(i).trimStart().startsWith(fence[1] ?? ""); i++) body.push(at(i));
      i++;
      out.append(el("pre", el("code", body.join("\n"))));
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.append(el(`h${heading[1]?.length}`, ...inline(heading[2] ?? "")));
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.append(el("hr"));
      i++;
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(at(i + 1))) {
      const table = el("table", el("thead", el("tr", ...cells(line).map((c) => el("th", ...inline(c))))));
      const body = el("tbody");
      for (i += 2; i < lines.length && at(i).includes("|") && at(i).trim(); i++) {
        body.append(el("tr", ...cells(at(i)).map((c) => el("td", ...inline(c)))));
      }
      table.append(body);
      out.append(table);
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+/;
    if (item.test(line)) {
      const list = el(/^\s*\d/.test(line) ? "ol" : "ul");
      const start = /^\s*(\d+)/.exec(line);
      if (start?.[1] && start[1] !== "1") list.setAttribute("start", start[1]);
      while (i < lines.length && item.test(at(i))) {
        const text = [at(i).replace(item, "")];
        for (i++; i < lines.length && /^\s+\S/.test(at(i)) && !item.test(at(i)); i++) text.push(at(i).trim());
        list.append(el("li", ...inline(text.join("\n"))));
      }
      out.append(list);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(at(i)); i++) quote.push(at(i).replace(/^\s*>\s?/, ""));
      out.append(el("blockquote", renderMarkdown(quote.join("\n"), doc)));
      continue;
    }
    const para = [line];
    for (i++; i < lines.length && at(i).trim() && !/^(\s*(```|~~~|>)|#{1,6}\s)/.test(at(i)) && !item.test(at(i)); i++) {
      para.push(at(i));
    }
    out.append(el("p", ...inline(para.join("\n"))));
  }
  return out;
}
