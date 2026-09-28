export { FIRST_MEETING_SECTION } from "@ghost/runtime/persona";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { GhostModelRoleBinding } from "./models.js";
import { buildGreetingContext, cleanGreeting, GREETING_TIMEOUT_MS, GREETING_CACHE_TTL_MS, type GreetingContextInput } from "@ghost/runtime/greeting";
export { buildGreetingContext, cleanGreeting, localTimeString, wholeDaysSince, GREETING_CHARACTER_BUDGET_CHARS, MAX_GREETING_CHARS, MAX_GREETING_SENTENCE_ENDERS, GREETING_LEAK_MARKERS, GREETING_TIMEOUT_MS, GREETING_CACHE_TTL_MS, GREETING_DATA_OPEN, GREETING_DATA_CLOSE } from "@ghost/runtime/greeting";
export type { GreetingContextInput } from "@ghost/runtime/greeting";
import {
  SMOL_MODEL_ROLE,
  type SmolRuntime,
  assistantText,
  resolveSmolModel,
  smolCatalogFromRuntime,
} from "./smol.js";

export interface GenerateGreetingInput {
  readonly runtime: SmolRuntime;
  readonly context: GreetingContextInput;
  readonly ref?: GhostModelRoleBinding | null;
  /** The chat model's provider; an unset smol role follows it. */
  readonly chatProvider?: string | null;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Resolve the smol model, run one completion, and return a clean greeting.
 *
 * Never throws. Every failure path — no usable model, a provider error, a
 * timeout, output that did not survive `cleanGreeting` — is `null`, because the
 * only caller is an HTTP route whose contract says a greeting may be absent.
 */
export async function generateGreeting(
  input: GenerateGreetingInput,
): Promise<string | null> {
  try {
    const resolved = resolveSmolModel(smolCatalogFromRuntime(input.runtime), input.ref, SMOL_MODEL_ROLE, {
      chatProvider: input.chatProvider ?? null,
    });
    const timeout = AbortSignal.timeout(input.timeoutMs ?? GREETING_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const model = input.runtime.getModel(resolved.model.provider, resolved.model.id);
    if (!model) return null;
    const response: AssistantMessage = await input.runtime.complete(
      model as Model<never>,
      buildGreetingContext(input.context),
      { signal },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") return null;
    return cleanGreeting(assistantText(response));
  } catch {
    return null;
  }
}


export interface GreetingResult {
  readonly greeting: string | null;
  readonly onboarding: boolean;
}

interface GreetingCacheEntry {
  readonly result: GreetingResult;
  readonly fingerprint: string;
  readonly generatedAt: number;
}

export interface GreetingCacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * One greeting per ghost, with single-flight.
 *
 * Opening the shell can fire several requests at once (a reconnect, a second
 * window); they share one completion rather than each paying for their own. An
 * entry expires on the TTL *or* when the character fingerprint changes, which
 * is what makes "the owner just wrote their ghost's character" show up as a new
 * greeting immediately instead of ten minutes later.
 *
 * A fingerprint change that lands while a generation is in flight does not
 * cancel it: that request still gets the older greeting, and the next one
 * regenerates. A greeting is a nicety; racing to invalidate it is not worth the
 * machinery.
 */
export class GreetingCache {
  private readonly entries = new Map<string, GreetingCacheEntry>();
  private readonly inflight = new Map<string, Promise<GreetingResult>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: GreetingCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? GREETING_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * The cached greeting for `key`, or one produced now. `fingerprint` is any
   * stable digest of the inputs that must invalidate the entry — the daemon
   * passes the character file's contents.
   */
  get(
    key: string,
    fingerprint: string,
    produce: () => Promise<GreetingResult>,
  ): Promise<GreetingResult> {
    const cached = this.entries.get(key);
    if (
      cached
      && cached.fingerprint === fingerprint
      && this.now() - cached.generatedAt < this.ttlMs
    ) {
      return Promise.resolve(cached.result);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = produce()
      .then((result) => {
        // clear(key) can invalidate this producer while it is still running
        // (a ghost rename/delete does exactly that). Only the producer that is
        // still registered for the key may repopulate the old-name cache.
        if (this.inflight.get(key) === promise) {
          this.entries.set(key, { result, fingerprint, generatedAt: this.now() });
        }
        return result;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  clear(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      this.inflight.clear();
    } else {
      this.entries.delete(key);
      this.inflight.delete(key);
    }
  }
}
