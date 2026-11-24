/**
 * A scripted answerer. Tests never load a model: this stands where the local
 * model does, emitting each turn's scripted events and recording what the
 * pass was given (prompt, cwd, conversation env, persona), so assertions are
 * made against what a pass actually receives.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PassEvent } from "../../src/local-turn.js";
import type { Answerer } from "../../src/session-host.js";

/** One turn of the fake, in the order turns are run. */
export interface FakeTurn {
  readonly events?: readonly PassEvent[];
  /** Fail the pass after its events, with this message. */
  readonly fail?: string;
  /** Hold the turn until this file exists (see `gate`), or the turn is stopped. */
  readonly gate?: string;
}

export interface FakeCall {
  readonly n: number;
  readonly prompt: string;
  /** The prompt without the conversation so far that every pass is handed. */
  readonly message: string;
  readonly cwd: string;
  readonly ghost: string | null;
  readonly session: string | null;
  readonly persona: string;
  readonly codingAgent: string | null;
}

export interface FakeAnswerer {
  readonly answerer: Answerer;
  calls(): FakeCall[];
  /** Replace the script; turn n still runs entry n of it, or its last. */
  setTurns(turns: readonly FakeTurn[]): void;
  /** A gate path for a turn to wait on, and the call that opens it. */
  gate(name: string): { path: string; release(): void };
  cleanup(): void;
}

/** Text events for the common case: each string is one reply. */
export function replies(...texts: string[]): FakeTurn[] {
  return texts.map((text) => ({ events: [{ type: "text", block: "reply", delta: text }] }));
}

export function fakeAnswerer(turns: readonly FakeTurn[]): FakeAnswerer {
  const dir = mkdtempSync(join(tmpdir(), "ghost-fake-answerer-"));
  let script = turns;
  const calls: FakeCall[] = [];
  const next = (): FakeTurn => script[Math.min(calls.length - 1, script.length - 1)] ?? {};
  const held = async (turn: FakeTurn, signal: AbortSignal): Promise<void> => {
    while (turn.gate && !existsSync(turn.gate)) {
      if (signal.aborted) throw new Error("stopped");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    answerer: {
      async turn(input) {
        calls.push({
          n: calls.length, prompt: input.prompt, message: input.prompt.replace(/^<conversation-so-far>\n[\s\S]*\n<\/conversation-so-far>\n\n/u, ""), cwd: input.cwd, persona: input.persona, codingAgent: input.codingAgent,
          ghost: input.env.GHOST ?? null, session: input.env.GHOST_SESSION ?? null,
        });
        const turn = next();
        await held(turn, input.signal);
        for (const event of turn.events ?? []) input.onEvent(event);
        if (turn.fail !== undefined) throw new Error(turn.fail);
      },
      async complete(prompt, signal) {
        calls.push({ n: calls.length, prompt, message: prompt, cwd: "", persona: "", codingAgent: null, ghost: null, session: null });
        const turn = next();
        await held(turn, signal);
        if (turn.fail !== undefined) throw new Error(turn.fail);
        return (turn.events ?? []).flatMap((event) => event.type === "text" ? [event.delta] : []).join("");
      },
    },
    calls: () => [...calls],
    setTurns: (replacement) => { script = replacement; },
    gate: (name) => {
      const path = join(dir, `gate-${name}`);
      return { path, release: () => writeFileSync(path, "") };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** SessionHost options that make `harness` what answers. */
export function answeredBy(harness: FakeAnswerer): { answerer: Answerer; codingAgent: () => Promise<string | null> } {
  return { answerer: harness.answerer, codingAgent: async () => null };
}
