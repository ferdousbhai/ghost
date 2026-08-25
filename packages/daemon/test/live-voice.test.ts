import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { describe, expect, it, vi } from "vitest";
import { LiveVoiceManager } from "../src/live-voice.js";

function session(): AgentSession {
  return {
    settings: { get: () => "verse" },
  } as unknown as AgentSession;
}

function fixture(startGate?: Promise<void>) {
  let options: LiveSessionControllerOptions | undefined;
  let muted = false;
  const start = vi.fn(async () => {
    if (startGate) await startGate;
    options?.callbacks.onPhase("listening");
  });
  const stop = vi.fn(async () => {
    options?.callbacks.onTerminal();
  });
  const controller = {
    get phase() { return muted ? "muted" as const : "listening" as const; },
    get muted() { return muted; },
    start,
    stop,
    toggleMute: vi.fn(() => { muted = !muted; }),
  };
  const manager = new LiveVoiceManager({
    createController: (input) => {
      options = input;
      return controller;
    },
  });
  return { manager, controller, callbacks: () => options!.callbacks };
}

describe("LiveVoiceManager", () => {
  it("starts OMP live voice and reports levels and transcripts", async () => {
    const { manager, callbacks } = fixture();
    await expect(manager.start("ghost/session", session())).resolves.toMatchObject({
      active: true,
      phase: "listening",
      muted: false,
    });

    callbacks().onLevels(0.25, 0.5);
    callbacks().onTranscript({ role: "user", text: "hel", turn: 1, final: false });
    callbacks().onTranscript({ role: "user", text: "hello", turn: 1, final: true });
    callbacks().onTranscript({ role: "assistant", text: "Hi", turn: 1, final: true });

    expect(manager.status("ghost/session")).toMatchObject({
      inputLevel: 0.25,
      outputLevel: 0.5,
      transcript: [
        { role: "user", text: "hello", turn: 1, final: true },
        { role: "assistant", text: "Hi", turn: 1, final: true },
      ],
    });
  });

  it("makes mute and unmute idempotent", async () => {
    const { manager, controller } = fixture();
    await manager.start("ghost/session", session());

    expect(manager.setMuted("ghost/session", true).muted).toBe(true);
    expect(manager.setMuted("ghost/session", true).muted).toBe(true);
    expect(manager.setMuted("ghost/session", false).muted).toBe(false);
    expect(controller.toggleMute).toHaveBeenCalledTimes(2);
  });

  it("stops the controller and retains the visible transcript", async () => {
    const { manager, callbacks, controller } = fixture();
    await manager.start("ghost/session", session());
    callbacks().onTranscript({ role: "user", text: "bye", turn: 1, final: true });

    await expect(manager.stop("ghost/session")).resolves.toMatchObject({
      active: false,
      phase: "stopped",
      transcript: [{ text: "bye" }],
    });
    expect(controller.stop).toHaveBeenCalledOnce();
  });

  it("does not let a delayed startup reactivate a stopped controller", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { manager } = fixture(startGate);

    const starting = manager.start("ghost/session", session());
    const stopping = manager.stop("ghost/session");
    releaseStart();
    await Promise.all([starting, stopping]);

    expect(manager.status("ghost/session")).toMatchObject({
      active: false,
      phase: "stopped",
    });
  });

  it("reports a terminal microphone or transport failure", async () => {
    const { manager, callbacks } = fixture();
    await manager.start("ghost/session", session());

    callbacks().onTerminal(new Error("microphone disappeared"));

    expect(manager.status("ghost/session")).toMatchObject({
      active: false,
      phase: "error",
      error: "microphone disappeared",
    });
  });
});
