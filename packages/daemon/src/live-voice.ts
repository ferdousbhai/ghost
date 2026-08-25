import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  LiveSessionController,
  type LiveSessionControllerOptions,
  type LiveTranscript,
} from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LivePhase } from "@oh-my-pi/pi-coding-agent/live/visualizer";
import { GhostError } from "./ghosts.js";

export interface LiveTranscriptRow extends LiveTranscript {}

export interface LiveVoiceStatus {
  supported: true;
  active: boolean;
  phase: LivePhase | "idle" | "stopped";
  muted: boolean;
  inputLevel: number;
  outputLevel: number;
  transcript: LiveTranscriptRow[];
  error?: string;
}

interface LiveController {
  readonly phase: LivePhase;
  readonly muted: boolean;
  start(): Promise<void>;
  toggleMute(): void;
  stop(): Promise<void>;
}

type LiveControllerFactory = (options: LiveSessionControllerOptions) => LiveController;

interface LiveVoiceRecord {
  controller?: LiveController;
  status: LiveVoiceStatus;
}

export interface LiveVoiceManagerOptions {
  createController?: LiveControllerFactory;
}

function emptyStatus(): LiveVoiceStatus {
  return {
    supported: true,
    active: false,
    phase: "idle",
    muted: false,
    inputLevel: 0,
    outputLevel: 0,
    transcript: [],
  };
}

function cloneStatus(status: LiveVoiceStatus): LiveVoiceStatus {
  return { ...status, transcript: status.transcript.map((row) => ({ ...row })) };
}

function assistantText(message: AssistantMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Conversation-scoped lifecycle for OMP's realtime microphone controller. */
export class LiveVoiceManager {
  private readonly records = new Map<string, LiveVoiceRecord>();
  private readonly createController: LiveControllerFactory;
  private onInactive?: (sessionKey: string) => void | Promise<void>;

  constructor(options: LiveVoiceManagerOptions = {}) {
    this.createController = options.createController
      ?? ((controllerOptions) => new LiveSessionController(controllerOptions));
  }

  status(sessionKey: string): LiveVoiceStatus {
    return cloneStatus(this.records.get(sessionKey)?.status ?? emptyStatus());
  }

  /** Notify the session owner when an active controller terminates on its own. */
  setOnInactive(listener: ((sessionKey: string) => void | Promise<void>) | undefined): void {
    this.onInactive = listener;
  }

  private notifyInactive(sessionKey: string): void {
    try {
      const pending = this.onInactive?.(sessionKey);
      if (pending) void pending.catch(() => {});
    } catch {
      // Lifecycle listeners are advisory; controller state must still settle.
    }
  }

  async start(sessionKey: string, session: AgentSession): Promise<LiveVoiceStatus> {
    const existing = this.records.get(sessionKey);
    if (existing?.controller) return cloneStatus(existing.status);

    const status = emptyStatus();
    status.active = true;
    status.phase = "connecting";
    const record: LiveVoiceRecord = { status };
    this.records.set(sessionKey, record);

    let controller: LiveController;
    const callbacks: LiveSessionControllerOptions["callbacks"] = {
      onPhase: (phase) => {
        if (record.controller !== controller) return;
        status.phase = phase;
        status.active = phase !== "error";
        status.muted = phase === "muted" || controller?.muted === true;
      },
      onLevels: (input, output) => {
        if (record.controller !== controller) return;
        status.inputLevel = input;
        status.outputLevel = output;
      },
      onTranscript: (transcript) => {
        if (record.controller !== controller || !transcript) return;
        const index = status.transcript.findIndex(
          (row) => row.role === transcript.role && row.turn === transcript.turn,
        );
        if (index >= 0) status.transcript[index] = { ...transcript };
        else status.transcript.push({ ...transcript });
        if (status.transcript.length > 100) {
          status.transcript.splice(0, status.transcript.length - 100);
        }
      },
      onTerminal: (error) => {
        if (record.controller !== controller) return;
        record.controller = undefined;
        status.active = false;
        status.phase = error ? "error" : "stopped";
        status.inputLevel = 0;
        status.outputLevel = 0;
        if (error) status.error = error.message;
        this.notifyInactive(sessionKey);
      },
    };
    controller = this.createController({
      session,
      callbacks,
      extractAssistantText: assistantText,
      voice: session.settings.get("live.voice"),
    });
    record.controller = controller;
    try {
      await controller.start();
      if (record.controller !== controller || !status.active) return cloneStatus(status);
      status.phase = controller.phase;
      status.muted = controller.muted;
      return cloneStatus(status);
    } catch (error) {
      record.controller = undefined;
      await controller.stop().catch(() => {});
      status.active = false;
      status.phase = "error";
      status.error = error instanceof Error ? error.message : String(error);
      this.notifyInactive(sessionKey);
      throw new GhostError("live_start_failed", status.error, 502);
    }
  }

  setMuted(sessionKey: string, muted: boolean): LiveVoiceStatus {
    const record = this.records.get(sessionKey);
    if (!record?.controller || !record.status.active) {
      throw new GhostError("live_not_active", "Live voice is not active for this conversation.", 409);
    }
    if (record.controller.muted !== muted) record.controller.toggleMute();
    record.status.muted = record.controller.muted;
    if (record.status.muted) record.status.phase = "muted";
    return cloneStatus(record.status);
  }

  async stop(sessionKey: string): Promise<LiveVoiceStatus> {
    const record = this.records.get(sessionKey);
    if (!record) return { ...emptyStatus(), phase: "stopped" };
    const controller = record.controller;
    record.controller = undefined;
    try {
      if (controller) await controller.stop();
    } finally {
      record.status.active = false;
      record.status.phase = "stopped";
      record.status.inputLevel = 0;
      record.status.outputLevel = 0;
      this.notifyInactive(sessionKey);
    }
    return cloneStatus(record.status);
  }

  async disposeAll(): Promise<void> {
    const keys = [...this.records.keys()];
    await Promise.allSettled(keys.map((key) => this.stop(key)));
    this.records.clear();
  }
}
