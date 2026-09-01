/**
 * The owner-question bridge shared by Pi's `ask` tool and Claude Code's native
 * `AskUserQuestion`. The model-facing shape follows Claude's SDK contract; the
 * broker shape remains the small, stable HTTP/HUD protocol.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AskUserQuestionOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { AskBroker, AskOpenOptions, AskQuestion, AskResultItem } from "./ask-broker.js";

const RESERVED_OPTION_LABELS = new Set([
  "Other",
  "Other (type your own)",
  "Chat about this",
  "Next →",
]);

const optionSchema = Type.Object({
  label: Type.String({ description: "The concise display text for this choice (1-5 words)." }),
  description: Type.String({ description: "What this choice means or what will happen if selected." }),
  preview: Type.Optional(Type.String({ description: "Optional Markdown preview shown while this choice is focused." })),
});

const questionSchema = Type.Object({
  question: Type.String({ description: "A clear, specific question that ends with a question mark." }),
  header: Type.String({ maxLength: 12, description: "A very short label displayed above the question (max 12 characters)." }),
  options: Type.Array(optionSchema, {
    minItems: 2,
    maxItems: 4,
    description: "Two to four distinct choices. Do not add an Other option; the UI supplies it.",
  }),
  multiSelect: Type.Boolean({ description: "Whether the owner may select more than one choice." }),
});

const annotationSchema = Type.Object({
  preview: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

export const askToolSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "Questions to ask the owner (1-4 questions).",
  }),
  answers: Type.Optional(Type.Record(Type.String(), Type.String())),
  annotations: Type.Optional(Type.Record(Type.String(), annotationSchema)),
  metadata: Type.Optional(Type.Object({ source: Type.Optional(Type.String()) })),
});

export type AskToolInput = Static<typeof askToolSchema>;

export function isAskToolInput(input: unknown): input is AskToolInput {
  return Check(askToolSchema, input);
}

/** Claude 2.1.251 adds this field ahead of the pinned SDK's generated type. */
export type AskToolOutput = AskUserQuestionOutput & { autoAnsweredAfterMs?: number };

/** What an ask tool call left in the transcript; legacy fields keep re-answering stable. */
export interface AskToolDetails {
  output?: AskToolOutput;
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

export interface AskResolution {
  kind: "submit" | "chat";
  output: AskToolOutput;
  results: AskResultItem[];
}

export class AskCancelledError extends Error {
  constructor(message = "Ask was cancelled by the owner") {
    super(message);
    this.name = "AskCancelledError";
  }
}

export const ASK_TOOL_NAME = "ask";

export const ASK_TOOL_DESCRIPTION = [
  "Ask the owner one to four multiple-choice questions and wait for the answers.",
  "Use this only for genuine decisions that require owner input, not routine judgment or approval.",
  "Each question needs a short header and two to four distinct described options; the UI adds an",
  "Other choice automatically. Put your recommended option first and suffix its label with",
  "`(Recommended)`. Use `multiSelect` when choices are not mutually exclusive.",
].join(" ");

/** Questions as the shell renders them, with model-only fields removed. */
function brokerQuestions(questions: AskToolInput["questions"]): AskQuestion[] {
  return questions.map((question, index) => ({
    id: `question-${index + 1}`,
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
      ...(option.preview?.trim() ? { preview: option.preview } : {}),
    })),
    multi: question.multiSelect,
  }));
}

function assertAskable(questions: AskToolInput["questions"]): void {
  for (const question of questions) {
    const reserved = question.options.find((option) => RESERVED_OPTION_LABELS.has(option.label));
    if (reserved) throw new Error(`Option label ${JSON.stringify(reserved.label)} is reserved by the ask dialog.`);
    const labels = new Set(question.options.map((option) => option.label));
    if (labels.size !== question.options.length) {
      throw new Error(`Question ${JSON.stringify(question.question)} has duplicate option labels.`);
    }
  }
}

function questionOutput(input: AskToolInput["questions"]): AskUserQuestionOutput["questions"] {
  // TypeBox expresses the SDK's 2-4 option tuple as a bounded array. The
  // runtime checks that bound before execution, so this is the same value.
  return input.map((question) => ({
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({ ...option })),
    multiSelect: question.multiSelect,
  })) as AskUserQuestionOutput["questions"];
}

function outputFor(
  input: AskToolInput,
  results: AskResultItem[],
  timeoutMs: number,
): AskToolOutput {
  const answers: Record<string, string> = {};
  const annotations: NonNullable<AskUserQuestionOutput["annotations"]> = {};
  results.forEach((result, index) => {
    if (result.customInput !== undefined) answers[result.question] = result.customInput;
    else if (result.selectedOptions.length > 0) {
      answers[result.question] = result.selectedOptions.join(", ");
    }
    const selected = result.selectedOptions.length === 1
      ? input.questions[index]?.options.find((option) => option.label === result.selectedOptions[0])
      : undefined;
    if (selected?.preview || result.note) {
      annotations[result.question] = {
        ...(selected?.preview ? { preview: selected.preview } : {}),
        ...(result.note ? { notes: result.note } : {}),
      };
    }
  });
  const timedOut = results.some((result) => result.timedOut === true);
  return {
    questions: questionOutput(input.questions),
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    ...(timedOut && timeoutMs > 0 ? { autoAnsweredAfterMs: timeoutMs } : {}),
  };
}

/**
 * Run the common owner interaction and return Claude's native output shape.
 * A chat redirect is a successful empty answer with an explanatory response;
 * cancelling the dialog aborts the tool call.
 */
export async function resolveAskUserQuestion(
  broker: AskBroker,
  input: AskToolInput,
  options: AskOpenOptions,
): Promise<AskResolution> {
  assertAskable(input.questions);
  const questions = brokerQuestions(input.questions);
  const answer = await broker.open(questions, options);
  if (!answer) throw new AskCancelledError();
  if (answer.kind === "chat") {
    return {
      kind: "chat",
      results: [],
      output: {
        questions: questionOutput(input.questions),
        answers: {},
        response: "The owner chose to discuss these questions instead of answering them.",
      },
    };
  }
  return {
    kind: "submit",
    results: answer.results,
    output: outputFor(input, answer.results, options.timeout ?? 0),
  };
}

/**
 * Ask the owner one broker-native question. Used by non-model product flows;
 * resolves `undefined` when they choose to chat instead.
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

export interface AskToolOptions {
  broker: AskBroker;
  /** Milliseconds until an unanswered ask settles; 0 waits forever. */
  timeoutMs: () => number;
}

export function createAskTool(options: AskToolOptions): ToolDefinition<typeof askToolSchema, AskToolDetails> {
  return {
    name: ASK_TOOL_NAME,
    label: "Ask",
    description: ASK_TOOL_DESCRIPTION,
    parameters: askToolSchema,
    async execute(_toolCallId, params, signal) {
      const timeout = options.timeoutMs();
      const resolution = await resolveAskUserQuestion(options.broker, params, {
        ...(signal ? { signal } : {}),
        timeout,
      });
      if (resolution.kind === "chat") {
        return {
          content: [{ type: "text", text: JSON.stringify(resolution.output) }],
          details: {
            output: resolution.output,
            chatRedirect: true,
            questions: params.questions.map((question) => question.question),
          },
        };
      }
      const results = resolution.results;
      if (results.length === 1) {
        const { id: _id, ...details } = results[0]!;
        return {
          content: [{ type: "text", text: JSON.stringify(resolution.output) }],
          details: { output: resolution.output, ...details },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(resolution.output) }],
        details: { output: resolution.output, results },
      };
    },
  };
}
