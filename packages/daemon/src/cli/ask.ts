import { ArgsError, flagBoolean, flagString, parseArgs, requirePositionals } from "./args.js";
import type { DaemonClient } from "./client.js";
import { resolveGhost, resolveSession, sessionPath } from "./common.js";
import { writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

interface AskOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  id: string;
  question: string;
  options: AskOption[];
  multi?: boolean;
  recommended?: number;
}

interface PendingAsk {
  id: string;
  createdAt: string;
  timeoutAt?: string;
  questions: AskQuestion[];
}

export async function askCommand(
  argv: readonly string[],
  client: DaemonClient,
  runtime: CliRuntime,
): Promise<number> {
  const action = argv[0] === "answer" || argv[0] === "chat" || argv[0] === "skip" ? argv[0] : undefined;
  const rest = action ? argv.slice(1) : argv;
  const parsed = parseArgs(rest, { value: ["ghost", "session"] });
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("ask"));
    return 0;
  }
  requirePositionals(parsed, action === "answer" ? 1 : 0, action === "answer" ? 1 : 0, "ghost ask [answer <value>|chat|skip] [-s <id>]");
  const { name } = await resolveGhost(client, runtime, flagString(parsed, "ghost"));
  const { session } = await resolveSession(client, name, flagString(parsed, "session"));
  const path = sessionPath(name, session.id, "/ask");
  const current = (await client.request<{ ask: PendingAsk | null }>("GET", path)).body.ask;

  if (!action) {
    if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, { ask: current });
    else if (!current) runtime.stdout.write("No pending question.\n");
    else {
      for (const question of current.questions) {
        runtime.stdout.write(`${question.question}\n`);
        question.options.forEach((option, index) => {
          const recommended = question.recommended === index ? " (recommended)" : "";
          const description = option.description ? ` — ${option.description}` : "";
          runtime.stdout.write(`  ${index + 1}. ${option.label}${recommended}${description}\n`);
        });
      }
      if (current.timeoutAt) runtime.stdout.write(`timeout ${current.timeoutAt}\n`);
    }
    return 0;
  }
  if (!current) throw new ArgsError("This conversation has no pending question.");
  let answer: Record<string, unknown>;
  if (action === "chat") answer = { askId: current.id, kind: "chat" };
  else if (action === "skip") answer = { askId: current.id, kind: "cancel" };
  else {
    const input = parsed.positionals[0] as string;
    const numeric = /^\d+$/.test(input) ? Number(input) - 1 : -1;
    const results = current.questions.map((question) => {
      const selected = numeric >= 0 ? question.options[numeric] : question.options.find((option) => option.label === input);
      return {
        id: question.id,
        selectedOptions: selected ? [selected.label] : [],
        ...(!selected ? { customInput: input } : {}),
      };
    });
    answer = { askId: current.id, kind: "submit", results };
  }
  const response = await client.request("POST", path, answer);
  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, response.body);
  else if (!flagBoolean(parsed, "quiet")) runtime.stdout.write("accepted\n");
  return 0;
}
