/**
 * Shared question barrier for a Pi tool batch that contains `ask`.
 *
 * Pi 0.86.1's public continuation cannot restore an unfinished tool batch.
 * A batch containing ask therefore runs sequentially: earlier calls finish
 * and are recorded before the question is acknowledged, and later calls do
 * not start until the question settles. This is a shared policy module. Both
 * hosts adopt its ordering through Pi's native tool execution mode.
 */

export const QUESTION_BARRIER_VERSION = 1;
/** Public Pi tool flag. Any batch containing ask then runs one call at a time. */
export const ASK_EXECUTION_MODE = "sequential" as const;

export type BarrierCallState = "pending" | "completed" | "uncertain" | "suspended";

export interface BarrierCall {
  id: string;
  name: string;
  arguments: unknown;
  /** Position in the assistant message's tool-call list. */
  index: number;
  state: BarrierCallState;
}

export interface QuestionBarrier {
  version: typeof QUESTION_BARRIER_VERSION;
  execution: typeof ASK_EXECUTION_MODE;
  askCallId: string;
  calls: BarrierCall[];
}

export interface ResumeStep {
  action: "reuse" | "project-question" | "execute";
  call: BarrierCall;
}

export type ResumePlan = { ok: true; steps: ResumeStep[] } | { ok: false; reason: string };

/** Suspend `askCallId`, or the first ask when the caller has not identified one yet. */
export function questionBarrier(calls: Array<Omit<BarrierCall, "state">>, askCallId?: string): QuestionBarrier | null {
  if (calls.some((call, index) => call.index !== index || !call.id || !call.name)) {
    throw new Error("A tool batch must keep its original call order and identities.");
  }
  if (new Set(calls.map((call) => call.id)).size !== calls.length) throw new Error("Tool call identities must be unique.");
  const askIndex = askCallId === undefined ? calls.findIndex((call) => call.name === "ask") : calls.findIndex((call) => call.id === askCallId);
  const ask = askIndex < 0 ? undefined : calls[askIndex];
  if (!ask) return null;
  if (ask.name !== "ask") throw new Error("The suspended call is not a question.");
  return {
    version: QUESTION_BARRIER_VERSION,
    execution: ASK_EXECUTION_MODE,
    askCallId: ask.id,
    calls: calls.map((call) => ({ ...call, arguments: call.arguments, state: call.index === askIndex ? "suspended" : "pending" })),
  };
}

/** Record the barrier only after earlier calls have a durable result. */
export function publishedBarrier(barrier: QuestionBarrier): QuestionBarrier {
  const askIndex = barrier.calls.findIndex((call) => call.id === barrier.askCallId);
  if (askIndex < 0) throw new Error("The question barrier does not identify its ask call.");
  return {
    ...barrier,
    calls: barrier.calls.map((call) => ({
      ...call,
      state: call.index < askIndex ? "completed" : call.id === barrier.askCallId ? "suspended" : "pending",
    })),
  };
}

export function callsBeforeQuestion(barrier: QuestionBarrier): BarrierCall[] {
  const askIndex = barrier.calls.findIndex((call) => call.id === barrier.askCallId);
  return barrier.calls.filter((call) => call.index < askIndex);
}

/**
 * Resume without repeating a saved result, replaying an uncertain effect, or
 * starting work that follows the question before the question itself is applied.
 */
export function resumePlan(barrier: { version: number; execution: string; askCallId: string; calls: BarrierCall[] }, observed: { completed: ReadonlySet<string>; uncertain: ReadonlySet<string> }): ResumePlan {
  if (barrier.version !== QUESTION_BARRIER_VERSION || barrier.execution !== ASK_EXECUTION_MODE) {
    return { ok: false, reason: "This suspended tool batch is from an unsupported version." };
  }
  if (barrier.calls.some((call, index) => call.index !== index) || new Set(barrier.calls.map((call) => call.id)).size !== barrier.calls.length) {
    return { ok: false, reason: "The suspended tool batch lost its original call order or identities." };
  }
  const askIndex = barrier.calls.findIndex((call) => call.id === barrier.askCallId);
  if (askIndex < 0 || barrier.calls[askIndex]?.name !== "ask") return { ok: false, reason: "The suspended question does not match its tool batch." };
  const steps: ResumeStep[] = [];
  for (const call of barrier.calls) {
    if (observed.uncertain.has(call.id) || call.state === "uncertain") {
      return { ok: false, reason: `The ${call.name} action has an uncertain outcome and will not be repeated.` };
    }
    if (observed.completed.has(call.id)) {
      steps.push({ action: "reuse", call });
      continue;
    }
    if (call.index < askIndex) return { ok: false, reason: `The earlier ${call.name} action has no saved result and will not be repeated.` };
    steps.push({ action: call.id === barrier.askCallId ? "project-question" : "execute", call });
  }
  const question = steps.find((step) => step.call.id === barrier.askCallId);
  const earlyExecute = steps.find((step) => step.action === "execute" && step.call.index < (question?.call.index ?? askIndex));
  if (!question || earlyExecute) return { ok: false, reason: "The question would not be applied before later actions." };
  return { ok: true, steps };
}

export function deadlineFor(now: number, timeoutMs: number): number | null {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return now + timeoutMs;
}
