import type { GhostHookEvent } from "./hooks.js";

const MAX_FEEDBACK_RECORDS = 64;

/**
 * Bounded, in-process, consume-once next-turn context keyed by ghost and
 * conversation. A daemon restart forgets it, which only skips one nudge.
 */
export class FeedbackRecords<T> {
  private readonly records = new Map<string, T>();

  private key(event: GhostHookEvent): string {
    return `${event.ghost_name}\u0000${event.conversation_id}`;
  }

  set(event: GhostHookEvent, value: T): void {
    const key = this.key(event);
    this.records.delete(key);
    this.records.set(key, value);
    if (this.records.size > MAX_FEEDBACK_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
  }

  clear(event: GhostHookEvent): void {
    this.records.delete(this.key(event));
  }

  /** Consume the record: each reviewed reply produces at most one nudge. */
  take(event: GhostHookEvent): T | undefined {
    const key = this.key(event);
    const value = this.records.get(key);
    this.records.delete(key);
    return value;
  }
}
