import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { GhostError } from "./ghosts.js";

export type LivePhase = "connecting" | "listening" | "thinking" | "speaking" | "muted" | "error";

export interface LiveTranscriptRow {
  role: "user" | "assistant";
  text: string;
  turn: number;
  final: boolean;
}

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

export interface LiveSessionCallbacks {
  onPhase(phase: LivePhase): void;
  onLevels(input: number, output: number): void;
  onTranscript(transcript: LiveTranscriptRow | undefined): void;
  onTerminal(error?: Error): void;
}

/** What a realtime voice controller is built from. */
export interface LiveSessionControllerOptions {
  session: AgentSession;
  callbacks: LiveSessionCallbacks;
  extractAssistantText: (message: AssistantMessage) => string;
  voice: string | undefined;
}

export interface LiveController {
  readonly phase: LivePhase;
  readonly muted: boolean;
  start(): Promise<void>;
  toggleMute(): void;
  stop(): Promise<void>;
}

export type LiveControllerFactory = (options: LiveSessionControllerOptions) => LiveController;
export type SendCustomMessage = AgentSession["sendCustomMessage"];

interface LiveVoiceRecord {
  controller?: LiveController;
  status: LiveVoiceStatus;
}

export interface LiveVoiceManagerOptions {
  createController?: LiveControllerFactory;
  /** The voice the realtime provider speaks with, from the ghost's settings. */
  voice?: (session: AgentSession) => string | undefined;
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
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * The realtime voice controller is being ported from Oh My Pi to Ghost; until
 * it lands, starting live voice reports that honestly.
 */
const unavailableController: LiveControllerFactory = () => {
  throw new GhostError(
    "not_supported",
    "Live voice is not available in this build of Ghost yet.",
    501,
  );
};

export class LiveVoiceManager {
  private readonly records = new Map<string, LiveVoiceRecord>();
  private readonly createController: LiveControllerFactory;
  private readonly voiceFor: (session: AgentSession) => string | undefined;
  private onInactive?: (sessionKey: string) => void | Promise<void>;

  constructor(options: LiveVoiceManagerOptions = {}) {
    this.createController = options.createController ?? unavailableController;
    this.voiceFor = options.voice ?? (() => undefined);
  }

  status(sessionKey: string): LiveVoiceStatus {
    return cloneStatus(this.records.get(sessionKey)?.status ?? emptyStatus());
  }

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

  async start(
    sessionKey: string,
    session: AgentSession,
    sendCustomMessage?: SendCustomMessage,
  ): Promise<LiveVoiceStatus> {
    const existing = this.records.get(sessionKey);
    if (existing?.controller) return cloneStatus(existing.status);

    const status = emptyStatus();
    status.active = true;
    status.phase = "connecting";
    const record: LiveVoiceRecord = { status };
    this.records.set(sessionKey, record);

    let controller: LiveController | undefined;
    const callbacks: LiveSessionCallbacks = {
      onPhase: (phase) => {
        if (!controller || record.controller !== controller) return;
        status.phase = phase;
        status.active = phase !== "error";
        status.muted = phase === "muted" || controller.muted === true;
      },
      onLevels: (input, output) => {
        if (!controller || record.controller !== controller) return;
        status.inputLevel = input;
        status.outputLevel = output;
      },
      onTranscript: (transcript) => {
        if (!controller || record.controller !== controller || !transcript) return;
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
        if (!controller || record.controller !== controller) return;
        record.controller = undefined;
        status.active = false;
        status.phase = error ? "error" : "stopped";
        status.inputLevel = 0;
        status.outputLevel = 0;
        if (error) status.error = error.message;
        this.notifyInactive(sessionKey);
      },
    };
    const controllerSession = sendCustomMessage
      ? new Proxy(session, {
          get(target, property) {
            if (property === "sendCustomMessage") return sendCustomMessage;
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : session;
    try {
      controller = this.createController({
        session: controllerSession,
        callbacks,
        extractAssistantText: assistantText,
        voice: this.voiceFor(session),
      });
    } catch (error) {
      this.records.delete(sessionKey);
      throw error;
    }
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
