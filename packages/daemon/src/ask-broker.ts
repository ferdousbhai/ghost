import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { silentLogger, type Logger } from "./log.js";

/** One choice the model offers the owner. */
export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

/** One question of an ask interaction, as the shell renders it. */
export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multi?: boolean;
  /** Index into `options` of the model's own default; taken when the ask times out. */
  recommended?: number;
}

export interface AskResultItem {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
}

export type AskResult =
  | { kind: "submit"; results: AskResultItem[] }
  | { kind: "chat" };

export interface AskOpenOptions {
  signal?: AbortSignal;
  /** Milliseconds until the ask answers itself; absent or 0 means wait forever. */
  timeout?: number;
}

export interface PendingAsk {
  id: string;
  createdAt: string;
  timeoutAt?: string;
  questions: AskQuestion[];
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

export class HeadlessUIUnavailableError extends Error {
  constructor(operation: string) {
    super(`Ghost's headless daemon cannot ${operation}.`);
    this.name = "HeadlessUIUnavailableError";
  }
}

interface ActiveAsk extends PendingAsk {
  resolve: (result: AskResult | undefined) => void;
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

function cloneQuestions(questions: AskQuestion[]): AskQuestion[] {
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
 * Turns the model's `ask` into a small, pollable HTTP interaction. The
 * provider turn remains paused in the harness; the shell may reconnect to the
 * same daemon and the first valid response wins.
 *
 * The deadline is the caller's to decide. `open` is handed a `timeout` only
 * when one applies — the daemon's `askTimeoutSeconds`, unless the owner
 * disabled auto-answering or plan mode suspended it — and no timeout at all
 * otherwise. Those states arrive here as one `undefined`, so a default of the
 * broker's own could only override decisions it cannot see.
 */
export class AskBroker {
  #active: ActiveAsk | null = null;

  readonly uiContext: ExtensionUIContext;

  constructor(logger: Logger = silentLogger) {
    // OMP exposes one UI context to every tool. Ask needs that context and
    // `hasUI: true`, so the daemon must honestly implement the whole surface:
    // passive display state is a headless no-op, while anything that would
    // require an owner's interactive answer rejects explicitly.
    const unavailable = (operation: string): never => {
      throw new HeadlessUIUnavailableError(operation);
    };
    this.uiContext = {
      timeoutStartsOnPresentation: true,
      select: async () => unavailable("show a selection dialog"),
      confirm: async () => unavailable("show a confirmation dialog"),
      input: async () => unavailable("show a text input dialog"),
      askDialog: (questions, options) => this.open(questions, options),
      notify: (message, type = "info") => {
        const fields = { type, message };
        if (type === "error") logger.error("OMP UI notification", fields);
        else if (type === "warning") logger.warn("OMP UI notification", fields);
        else logger.info("OMP UI notification", fields);
      },
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async <T>(): Promise<T> => unavailable("show a custom interactive UI"),
      setEditorText: () => unavailable("set text in an interactive editor"),
      pasteToEditor: () => unavailable("paste text into an interactive editor"),
      getEditorText: () => unavailable("read text from an interactive editor"),
      editor: async () => unavailable("show a text editor"),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      get theme() {
        return unavailable("read an interactive UI theme");
      },
      getAllThemes: async () => [],
      getTheme: async () => undefined,
      setTheme: async () => ({ success: false, error: "UI not available in Ghost's daemon" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

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

  /**
   * Publish one ask and resolve with the owner's answer, `{ kind: "chat" }`
   * when they chose to talk instead, or `undefined` when it was cancelled.
   */
  open(questions: AskQuestion[], options?: AskOpenOptions): Promise<AskResult | undefined> {
    // Ask is exclusive, but fail closed if an integration error ever manages
    // to overlap two dialogs instead of orphaning the first promise.
    this.close();
    const now = Date.now();
    const timeout = options?.timeout && options.timeout > 0 ? options.timeout : undefined;
    const { promise, resolve } = Promise.withResolvers<AskResult | undefined>();
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
      active.timer = setTimeout(() => {
        this.#settle(active, {
          kind: "submit",
          results: active.questions.map((question) => this.#timedOutResult(question)),
        });
      }, timeout);
    }
    return promise;
  }

  #validateResult(question: AskQuestion, raw: unknown): AskResultItem {
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

  /**
   * What a question settles as when the deadline passes and nobody answered.
   *
   * `recommended` is the asking model's own pre-committed default, so
   * submitting it is submitting the model's answer, not the owner's. Without
   * one there is nothing to submit: an answer chosen by list position would
   * reach the model as a decision the owner never made, on a question whose
   * options it wrote in whatever order it happened to write them. An empty
   * selection says exactly what happened — the question expired unanswered —
   * and leaves the model free to take the careful branch or park the task.
   * (The timeout path bypasses #validateResult, which would otherwise insist a
   * single-select question carry an answer.)
   */
  #timedOutResult(question: AskQuestion): AskResultItem {
    const recommended = typeof question.recommended === "number"
      ? question.options[question.recommended]
      : undefined;
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: question.multi ?? false,
      selectedOptions: recommended ? [recommended.label] : [],
      timedOut: true,
    };
  }

  #settle(active: ActiveAsk, result: AskResult | undefined): void {
    if (this.#active !== active) return;
    this.#active = null;
    if (active.timer) clearTimeout(active.timer);
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener("abort", active.onAbort);
    }
    active.resolve(result);
  }
}
