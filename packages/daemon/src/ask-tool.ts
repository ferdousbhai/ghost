/**
 * The `ask` tool: the model asks the owner one or more multiple-choice
 * questions and the turn pauses until the shell answers through the daemon's
 * ask route, the deadline passes, or the turn is cancelled. It is a
 * human-input bridge, never a tool-approval surface.
 *
 * The argument shape, result details, and answer text follow Oh My Pi's
 * `ask` tool (MIT, can1357/oh-my-pi `src/tools/ask.ts`) so existing
 * transcripts and the shell's ask cards keep their meaning.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { AskBroker, AskOpenOptions, AskQuestion, AskResultItem } from "./ask-broker.js";

const RESERVED_OPTION_LABELS = new Set(["Other (type your own)", "Chat about this", "Next →"]);

const optionSchema = Type.Object({
  label: Type.String({ description: "display label" }),
  description: Type.Optional(Type.String({ description: "optional explanatory text displayed below the label" })),
  preview: Type.Optional(Type.String({ description: "optional rich preview content for interactive ask dialogs" })),
});

const questionSchema = Type.Object({
  id: Type.String({ description: "question id" }),
  question: Type.String({ description: "question text" }),
  header: Type.Optional(Type.String({ description: "optional short header shown above the question" })),
  options: Type.Array(optionSchema, { minItems: 1, description: "choices to offer" }),
  multi: Type.Optional(Type.Boolean({ description: "allow selecting several options" })),
  recommended: Type.Optional(Type.Integer({ minimum: 0, description: "recommended option index" })),
});

export const askToolSchema = Type.Object({
  questions: Type.Array(questionSchema, { minItems: 1, description: "questions to ask" }),
});

export type AskToolInput = Static<typeof askToolSchema>;

/** What an ask tool call left in the transcript; the shell rebuilds its card from this. */
export interface AskToolDetails {
  question?: string;
  options?: string[];
  multi?: boolean;
  selectedOptions?: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
  results?: AskResultItem[];
  chatRedirect?: boolean;
  questions?: string[];
}

export class AskCancelledError extends Error {
  constructor(message = "Ask was cancelled by the owner") {
    super(message);
    this.name = "AskCancelledError";
  }
}

export const ASK_TOOL_NAME = "ask";

export const ASK_TOOL_DESCRIPTION = [
  "Ask the owner one or more clarifying multiple-choice questions and wait for the answer.",
  "Use it when a decision is genuinely theirs to make and the options are clear; do not use it",
  "for routine judgment calls or as a way to confirm before acting. Each question needs a stable",
  "id, the question text, and at least one option; mark the option you would pick as",
  "`recommended` so a timed-out question can settle on it. The owner may also type their own",
  "answer or choose to chat about the question instead of answering.",
].join(" ");

/** Questions as the shell renders them, with whitespace-only decoration dropped. */
function normalizeAskQuestions(questions: AskToolInput["questions"]): AskQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    ...(question.header?.trim() ? { header: question.header } : {}),
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      ...(option.preview?.trim() ? { preview: option.preview } : {}),
    })),
    ...(question.multi !== undefined ? { multi: question.multi } : {}),
    ...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
  }));
}

function indented(label: string, value: string): string {
  return value.includes("\n")
    ? `${label}:\n${value.split("\n").map((line) => `  ${line}`).join("\n")}`
    : `${label}: ${value}`;
}

function formatSingleQuestionResponse(result: AskResultItem): string {
  const parts: string[] = [];
  if (result.selectedOptions.length > 0) {
    const selected = `User selected: ${result.multi ? result.selectedOptions.join(", ") : result.selectedOptions[0]}`;
    parts.push(result.timedOut ? `${selected} (auto-selected after timeout)` : selected);
  }
  if (result.customInput !== undefined) parts.push(indented("User provided custom input", result.customInput));
  if (result.note) parts.push(indented("User added note", result.note));
  if (parts.length > 0) return parts.join("\n");
  return result.timedOut ? "User did not select any options" : "User cancelled the selection";
}

function formatQuestionResult(result: AskResultItem): string {
  const noteSuffix = result.note ? ` (note: ${result.note})` : "";
  if (result.customInput !== undefined) return `${result.id}: "${result.customInput}"${noteSuffix}`;
  if (result.selectedOptions.length > 0) {
    const suffix = `${result.timedOut ? " (auto-selected after timeout)" : ""}${noteSuffix}`;
    return result.multi
      ? `${result.id}: [${result.selectedOptions.join(", ")}]${suffix}`
      : `${result.id}: ${result.selectedOptions[0]}${suffix}`;
  }
  return result.multi ? `${result.id}: []${noteSuffix}` : `${result.id}: (cancelled)${noteSuffix}`;
}

function assertAskable(questions: AskToolInput["questions"]): void {
  for (const question of questions) {
    const reserved = question.options.find((option) => RESERVED_OPTION_LABELS.has(option.label));
    if (reserved) throw new Error(`Option label ${JSON.stringify(reserved.label)} is reserved by the ask dialog.`);
    if (question.recommended !== undefined && question.recommended >= question.options.length) {
      throw new Error(`Question ${JSON.stringify(question.id)} recommends an option it does not offer.`);
    }
  }
}

export interface AskToolOptions {
  broker: AskBroker;
  /**
   * Milliseconds until an unanswered ask settles on its recommendations, read
   * per ask because plan mode may suspend it; 0 waits forever.
   */
  timeoutMs: () => number;
}

/**
 * Ask the owner one question. Resolves with their answer, `undefined` when
 * they chose to chat instead, and throws `AskCancelledError` on cancel or an
 * unanswered single choice.
 */
export async function askOwner(
  broker: AskBroker,
  question: AskQuestion,
  options: AskOpenOptions,
): Promise<AskResultItem | undefined> {
  const answer = await broker.open([question], options);
  if (!answer) throw new AskCancelledError();
  if (answer.kind === "chat") return undefined;
  const result = answer.results[0];
  const unanswered = result
    && !result.timedOut
    && !result.multi
    && result.selectedOptions.length === 0
    && result.customInput === undefined;
  if (!result || unanswered) throw new AskCancelledError();
  return result;
}

export function createAskTool(options: AskToolOptions): ToolDefinition<typeof askToolSchema, AskToolDetails> {
  return {
    name: ASK_TOOL_NAME,
    label: "Ask",
    description: ASK_TOOL_DESCRIPTION,
    parameters: askToolSchema,
    async execute(_toolCallId, params, signal) {
      assertAskable(params.questions);
      const questions = normalizeAskQuestions(params.questions);
      const answer = await options.broker.open(questions, {
        ...(signal ? { signal } : {}),
        timeout: options.timeoutMs(),
      });
      if (!answer) throw new AskCancelledError();
      if (answer.kind === "chat") {
        const asked = questions.map((question) => question.question);
        return {
          content: [{
            type: "text",
            text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${asked.join("\n")}`,
          }],
          details: { chatRedirect: true, questions: asked },
        };
      }
      const results = answer.results;
      if (questions.length === 1) {
        const result = results[0];
        // An empty multi-select submission is a valid "select none"; only a
        // truly empty single-select result counts as cancellation.
        const unanswered = result
          && !result.timedOut
          && !result.multi
          && result.selectedOptions.length === 0
          && result.customInput === undefined;
        if (!result || unanswered) throw new AskCancelledError();
        const { id: _id, ...details } = result;
        return { content: [{ type: "text", text: formatSingleQuestionResponse(result) }], details };
      }
      return {
        content: [{ type: "text", text: `User answers:\n${results.map(formatQuestionResult).join("\n")}` }],
        details: { results },
      };
    },
  };
}
