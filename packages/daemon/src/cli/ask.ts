import type { PendingAsk } from "../ask-broker.js";
import { ArgsError, type ParsedCliArgs } from "./args.js";
import { resolveTarget } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";

export async function askCommand(
  parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const [candidate, input] = parsed.positionals;
  const action = candidate === "answer" || candidate === "chat" || candidate === "skip"
    ? candidate
    : undefined;
  if ((candidate && !action) || (action === "answer" ? !input : parsed.positionals.length > 1)) {
    throw new ArgsError("ask expects `answer <value>`, `chat`, or `skip`");
  }
  const { path } = await resolveTarget(ctx.client, ctx, parsed);
  const askPath = `${path}/ask`;
  const current = (await ctx.client.request<{ ask: PendingAsk | null }>("GET", askPath)).body.ask;

  if (!action) {
    emit(ctx, { ask: current }, () => {
      if (!current) return "No pending question.\n";
      const lines: string[] = [];
      for (const question of current.questions) {
        lines.push(question.question);
        question.options.forEach((option, index) => {
          const recommended = question.recommended === index ? " (recommended)" : "";
          const description = option.description ? ` — ${option.description}` : "";
          lines.push(`  ${index + 1}. ${option.label}${recommended}${description}`);
        });
      }
      if (current.timeoutAt) lines.push(`timeout ${current.timeoutAt}`);
      return `${lines.join("\n")}\n`;
    });
    return 0;
  }
  if (!current) throw new ArgsError("This conversation has no pending question.");
  let answer: Record<string, unknown>;
  if (action === "chat") answer = { askId: current.id, kind: "chat" };
  else if (action === "skip") answer = { askId: current.id, kind: "cancel" };
  else {
    if (current.questions.length !== 1) {
      throw new ArgsError("ask answer supports one question at a time");
    }
    const question = current.questions[0] as PendingAsk["questions"][number];
    const answerInput = input as string;
    const numeric = /^\d+$/.test(answerInput) ? Number(answerInput) - 1 : -1;
    const selected = numeric >= 0
      ? question.options[numeric]
      : question.options.find((option) => option.label === answerInput);
    answer = {
      askId: current.id,
      kind: "submit",
      results: [{
        id: question.id,
        selectedOptions: selected ? [selected.label] : [],
        ...(!selected ? { customInput: answerInput } : {}),
      }],
    };
  }
  const response = await ctx.client.request("POST", askPath, answer);
  emit(ctx, response.body, () => "accepted\n");
  return 0;
}
