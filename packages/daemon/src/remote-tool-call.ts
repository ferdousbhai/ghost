/**
 * The remote viewer's line for a running tool call, in pi's convention as the
 * HUD's activity line shows it (packages/shell ToolTrace.js): the call itself,
 * never what came back. `$ git status`, `read ~/notes/plan.md:10-40`,
 * `edit src/app.ts`, `grep /retry/ in src (*.ts)`, `find *.md in docs`, any
 * other tool as its name and arguments; Ghost's desktop tools, which carry no
 * command or path, keep a plain phrase. Embedded in the page by source
 * (`toolCall.toString()`), so it must stay self-contained: no imports, no
 * closures over module scope.
 */
export function toolCall(toolName: string, args: unknown, cwd: string): string {
  const limit = 1200;
  const compact = (value: string, max: number) => {
    const line = value.replace(/\s+/gu, " ").trim();
    return line.length > max ? line.slice(0, max - 1) + "…" : line;
  };
  const fields: Record<string, unknown> = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  const text = (key: string) => typeof fields[key] === "string" ? (fields[key] as string).trim() : "";
  const short = (value: string, fallback: string) => {
    let path = value;
    if (path === "") return fallback;
    if (cwd && path.startsWith(cwd + "/")) path = path.slice(cwd.length + 1);
    return path.replace(/^\/home\/[^/]+(?=\/|$)/u, "~");
  };
  const filePath = () => text("path") || text("file_path");
  const name = toolName.toLowerCase().replace(/^(?:mcp__ghost__|ghost\.)/u, "");

  if (["bash", "shell", "exec_command", "local_shell", "run_terminal_cmd"].includes(name)) {
    let command = fields.command !== undefined ? fields.command : fields.cmd;
    // Codex sends ["bash", "-lc", "<script>"]: the script is the command.
    if (Array.isArray(command)) {
      const wrapped = command.length === 3 && /(^|\/)(ba|z)?sh$/u.test(String(command[0]))
        && /^-l?c$/u.test(String(command[1]));
      command = wrapped ? command[2] : command.join(" ");
    }
    const line = typeof command === "string" ? command.trim() : "";
    return "$ " + (line !== "" ? compact(line, limit) : "…");
  }
  if (["read", "view", "read_file"].includes(name)) {
    const offset = fields.offset, count = fields.limit;
    let range = "";
    if (typeof offset === "number" || typeof count === "number") {
      const start = typeof offset === "number" && offset > 0 ? offset : 1;
      range = ":" + start + (typeof count === "number" && count > 0 ? "-" + (start + count - 1) : "");
    }
    return compact("read " + short(filePath(), "…") + range, limit);
  }
  if (["write", "write_file", "create"].includes(name)) return compact("write " + short(filePath(), "…"), limit);
  if (["edit", "multiedit", "str_replace", "apply_patch", "patch"].includes(name)) {
    // A Codex patch names its file in its first file header.
    const header = /\*\*\* (?:Update|Add|Delete) File: (.+)/u.exec(text("input") || text("patch"));
    return compact("edit " + short(filePath() || (header?.[1] ?? "").trim(), "…"), limit);
  }
  switch (name) {
    case "ls":
    case "list":
    case "list_dir":
      return compact("ls " + short(text("path"), "."), limit);
    case "grep":
    case "search": {
      const glob = text("glob") || text("include");
      return compact("grep /" + text("pattern") + "/ in " + short(text("path"), ".") + (glob ? " (" + glob + ")" : ""), limit);
    }
    case "find":
    case "glob":
      return compact("find " + text("pattern") + " in " + short(text("path"), "."), limit);
    case "desktop_look":
      if (fields.image === true || fields.region || fields.monitor) return "Checking what’s on screen";
      return fields.ui === true ? "Looking through a window" : "Checking the desktop";
    case "desktop_act": {
      const steps = fields.steps;
      const only = Array.isArray(steps) && steps.length === 1 ? String(steps[0]?.do ?? "") : "";
      return only === "type" ? "Typing on the desktop" : "Working on the desktop";
    }
    default: {
      const parts = Object.entries(fields).map(([key, value]) =>
        key + ": " + (typeof value === "string" ? value : JSON.stringify(value)));
      return compact(parts.length ? toolName + " " + parts.join(", ") : toolName || "tool", 100);
    }
  }
}
