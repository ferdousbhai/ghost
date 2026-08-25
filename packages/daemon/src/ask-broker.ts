import { randomUUID } from "node:crypto";
import type {
  ExtensionAskDialogQuestion,
  ExtensionAskDialogResult,
  ExtensionAskDialogResultItem,
  ExtensionUIDialogOptions,
  ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export interface PendingAsk {
  id: string;
  createdAt: string;
  timeoutAt?: string;
  questions: ExtensionAskDialogQuestion[];
}

export class AskBrokerError extends Error {
  constructor(
    readonly code: "ask_not_pending" | "ask_stale" | "invalid_ask_answer",
    message: string,
  ) {
    super(message);
    this.name = "AskBrokerError";
  }
}

interface ActiveAsk extends PendingAsk {
  resolve: (result: ExtensionAskDialogResult | undefined) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface RawAnswerItem {
  id?: unknown;
  selectedOptions?: unknown;
  customInput?: unknown;
  note?: unknown;
}

function cloneQuestions(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogQuestion[] {
  return questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option })),
  }));
}

function stringField(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AskBrokerError("invalid_ask_answer", `${field} must be a string.`);
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

/**
 * Turns OMP's synchronous ExtensionUIContext.askDialog contract into a small,
 * pollable HTTP interaction. The provider turn remains paused in the harness;
 * the shell may reconnect to the same daemon and the first valid response wins.
 */
export class AskBroker {
  #active: ActiveAsk | null = null;

  /**
   * Milliseconds a question waits when its asker names no deadline of its own.
   * Ghost's setting, not OMP's: the tool may still pass a shorter or longer
   * `timeout` for a question it knows the shape of, and that always wins.
   * `0` waits forever, which is what shipped before this had a default.
   */
  readonly #defaultTimeout: number;

  constructor(defaultTimeoutSeconds = 0) {
    this.#defaultTimeout = Number.isFinite(defaultTimeoutSeconds) && defaultTimeoutSeconds > 0
      ? defaultTimeoutSeconds * 1000
      : 0;
  }

  readonly uiContext = {
    timeoutStartsOnPresentation: true,
    askDialog: (
      questions: ExtensionAskDialogQuestion[],
      options?: ExtensionUIDialogOptions,
    ) => this.#open(questions, options),
  } as unknown as ExtensionUIContext;

  get pending(): PendingAsk | null {
    const active = this.#active;
    if (!active) return null;
    return {
      id: active.id,
      createdAt: active.createdAt,
      ...(active.timeoutAt ? { timeoutAt: active.timeoutAt } : {}),
      questions: cloneQuestions(active.questions),
    };
  }

  answer(askId: string, input: unknown): void {
    const active = this.#active;
    if (!active) {
      throw new AskBrokerError("ask_not_pending", "This conversation is not waiting for an answer.");
    }
    if (active.id !== askId) {
      throw new AskBrokerError("ask_stale", "That question is no longer the active ask interaction.");
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new AskBrokerError("invalid_ask_answer", "Ask answer must be a JSON object.");
    }
    const body = input as Record<string, unknown>;
    if (body.kind === "chat") {
      this.#settle(active, { kind: "chat" });
      return;
    }
    if (body.kind === "cancel") {
      this.#settle(active, undefined);
      return;
    }
    if (body.kind !== "submit") {
      throw new AskBrokerError(
        "invalid_ask_answer",
        'Ask answer "kind" must be "submit", "chat", or "cancel".',
      );
    }
    if (!Array.isArray(body.results) || body.results.length !== active.questions.length) {
      throw new AskBrokerError(
        "invalid_ask_answer",
        "Ask answer must contain exactly one result for every question.",
      );
    }
    const rawResults = body.results;
    const results = active.questions.map((question, index) =>
      this.#validateResult(question, rawResults[index]));
    this.#settle(active, { kind: "submit", results });
  }

  close(): void {
    if (this.#active) this.#settle(this.#active, undefined);
  }

  #open(
    questions: ExtensionAskDialogQuestion[],
    options?: ExtensionUIDialogOptions,
  ): Promise<ExtensionAskDialogResult | undefined> {
    // Ask is exclusive in OMP, but fail closed if an integration error ever
    // manages to overlap two dialogs instead of orphaning the first promise.
    this.close();
    const now = Date.now();
    const asked = options?.timeout && options.timeout > 0 ? options.timeout : undefined;
    const timeout = asked ?? (this.#defaultTimeout > 0 ? this.#defaultTimeout : undefined);
    const { promise, resolve } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
    const active: ActiveAsk = {
      id: randomUUID(),
      createdAt: new Date(now).toISOString(),
      ...(timeout ? { timeoutAt: new Date(now + timeout).toISOString() } : {}),
      questions: cloneQuestions(questions),
      resolve,
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    this.#active = active;

    if (options?.signal) {
      const onAbort = () => this.#settle(active, undefined);
      active.onAbort = onAbort;
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeout && this.#active === active) {
      options?.onTimeoutStart?.();
      active.timer = setTimeout(() => {
        options?.onTimeout?.();
        this.#settle(active, {
          kind: "submit",
          results: active.questions.map((question) => this.#timedOutResult(question)),
        });
      }, timeout);
    }
    return promise;
  }

  #validateResult(
    question: ExtensionAskDialogQuestion,
    raw: unknown,
  ): ExtensionAskDialogResultItem {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AskBrokerError("invalid_ask_answer", `Answer for ${question.id} must be an object.`);
    }
    const answer = raw as RawAnswerItem;
    if (answer.id !== question.id) {
      throw new AskBrokerError(
        "invalid_ask_answer",
        `Expected answer id ${JSON.stringify(question.id)} in question order.`,
      );
    }
    if (!Array.isArray(answer.selectedOptions) || !answer.selectedOptions.every((value) => typeof value === "string")) {
      throw new AskBrokerError(
        "invalid_ask_answer",
        `selectedOptions for ${question.id} must be an array of strings.`,
      );
    }
    const selectedOptions = answer.selectedOptions as string[];
    if (new Set(selectedOptions).size !== selectedOptions.length) {
      throw new AskBrokerError("invalid_ask_answer", `Selections for ${question.id} must be unique.`);
    }
    const known = new Set(question.options.map((option) => option.label));
    if (selectedOptions.some((selection) => !known.has(selection))) {
      throw new AskBrokerError(
        "invalid_ask_answer",
        `Answer for ${question.id} contains an option that was not offered.`,
      );
    }
    const multi = question.multi ?? false;
    const customInput = stringField(answer.customInput, `customInput for ${question.id}`);
    const note = stringField(answer.note, `note for ${question.id}`);
    if (!multi && selectedOptions.length > 1) {
      throw new AskBrokerError("invalid_ask_answer", `${question.id} accepts only one option.`);
    }
    if (!multi && selectedOptions.length > 0 && customInput !== undefined) {
      throw new AskBrokerError(
        "invalid_ask_answer",
        `${question.id} cannot select an option and a custom answer together.`,
      );
    }
    if (!multi && selectedOptions.length === 0 && customInput === undefined) {
      throw new AskBrokerError("invalid_ask_answer", `${question.id} needs an answer.`);
    }
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi,
      selectedOptions,
      ...(customInput ? { customInput } : {}),
      ...(note ? { note } : {}),
    };
  }

  #timedOutResult(question: ExtensionAskDialogQuestion): ExtensionAskDialogResultItem {
    const recommended = typeof question.recommended === "number"
      ? question.options[question.recommended]
      : undefined;
    const selected = recommended ?? question.options[0];
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: question.multi ?? false,
      selectedOptions: selected ? [selected.label] : [],
      timedOut: true,
    };
  }

  #settle(active: ActiveAsk, result: ExtensionAskDialogResult | undefined): void {
    if (this.#active !== active) return;
    this.#active = null;
    if (active.timer) clearTimeout(active.timer);
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener("abort", active.onAbort);
    }
    active.resolve(result);
  }
}
