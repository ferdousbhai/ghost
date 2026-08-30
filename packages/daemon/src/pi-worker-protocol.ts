/** Private bounded JSON-lines protocol between ghostd and its bundled Pi worker child. */
export const PI_WORKER_PROTOCOL_VERSION = 1;
export const PI_WORKER_MAX_LINE_BYTES = 1024 * 1024;
export const PI_WORKER_MAX_EVENT_TEXT = 128_000;
export const PI_WORKER_MAX_RESULT_TEXT = 160_000;
export const PI_WORKER_MAX_ERROR_TEXT = 8_000;

export interface PiWorkerStartCommand {
  protocol: typeof PI_WORKER_PROTOCOL_VERSION;
  type: "start";
  ghostHome: string;
  taskId: string;
  root: string;
  cwd: string;
  task: string;
  offline: boolean;
}

export interface PiWorkerMessageCommand {
  protocol: typeof PI_WORKER_PROTOCOL_VERSION;
  type: "message";
  requestId: string;
  text: string;
}

export interface PiWorkerCancelCommand {
  protocol: typeof PI_WORKER_PROTOCOL_VERSION;
  type: "cancel";
  requestId: string;
}

export type PiWorkerCommand = PiWorkerStartCommand | PiWorkerMessageCommand | PiWorkerCancelCommand;

export type PiWorkerEvent =
  | {
      protocol: typeof PI_WORKER_PROTOCOL_VERSION;
      type: "started";
      sessionId: string;
    }
  | {
      protocol: typeof PI_WORKER_PROTOCOL_VERSION;
      type: "output" | "notice";
      text: string;
    }
  | {
      protocol: typeof PI_WORKER_PROTOCOL_VERSION;
      type: "ack";
      requestId: string;
    }
  | {
      protocol: typeof PI_WORKER_PROTOCOL_VERSION;
      type: "result";
      sessionId: string;
      text: string;
    }
  | {
      protocol: typeof PI_WORKER_PROTOCOL_VERSION;
      type: "cancelled";
      requestId: string;
    }
  | {
      protocol: typeof PI_WORKER_PROTOCOL_VERSION;
      type: "error";
      message: string;
      requestId?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximum = PI_WORKER_MAX_EVENT_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function parsePiWorkerCommand(value: unknown): PiWorkerCommand | null {
  if (!isRecord(value) || value.protocol !== PI_WORKER_PROTOCOL_VERSION) return null;
  switch (value.type) {
    case "start":
      if (!hasOnly(value, ["protocol", "type", "ghostHome", "taskId", "root", "cwd", "task", "offline"])
        || !boundedString(value.ghostHome, 16_384)
        || !boundedString(value.taskId, 200)
        || !boundedString(value.root, 16_384)
        || !boundedString(value.cwd, 16_384)
        || !boundedString(value.task, 64_000)
        || typeof value.offline !== "boolean") return null;
      return value as unknown as PiWorkerStartCommand;
    case "message":
      if (!hasOnly(value, ["protocol", "type", "requestId", "text"])
        || !boundedString(value.requestId, 200)
        || !boundedString(value.text, 64_000)) return null;
      return value as unknown as PiWorkerMessageCommand;
    case "cancel":
      if (!hasOnly(value, ["protocol", "type", "requestId"])
        || !boundedString(value.requestId, 200)) return null;
      return value as unknown as PiWorkerCancelCommand;
    default:
      return null;
  }
}

export function parsePiWorkerEvent(value: unknown): PiWorkerEvent | null {
  if (!isRecord(value) || value.protocol !== PI_WORKER_PROTOCOL_VERSION) return null;
  switch (value.type) {
    case "started":
      return hasOnly(value, ["protocol", "type", "sessionId"])
          && boundedString(value.sessionId, 2_000)
        ? value as unknown as PiWorkerEvent
        : null;
    case "output":
    case "notice":
      return hasOnly(value, ["protocol", "type", "text"])
          && boundedString(value.text)
        ? value as unknown as PiWorkerEvent
        : null;
    case "ack":
    case "cancelled":
      return hasOnly(value, ["protocol", "type", "requestId"])
          && boundedString(value.requestId, 200)
        ? value as unknown as PiWorkerEvent
        : null;
    case "result":
      return hasOnly(value, ["protocol", "type", "sessionId", "text"])
          && boundedString(value.sessionId, 2_000)
          && typeof value.text === "string"
          && value.text.length <= PI_WORKER_MAX_RESULT_TEXT
        ? value as unknown as PiWorkerEvent
        : null;
    case "error":
      return hasOnly(value, ["protocol", "type", "message", "requestId"])
          && boundedString(value.message, PI_WORKER_MAX_ERROR_TEXT)
          && (value.requestId === undefined || boundedString(value.requestId, 200))
        ? value as unknown as PiWorkerEvent
        : null;
    default:
      return null;
  }
}

export function encodePiWorkerLine(value: PiWorkerCommand | PiWorkerEvent): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > PI_WORKER_MAX_LINE_BYTES) {
    throw new Error(`Pi worker protocol line exceeds ${PI_WORKER_MAX_LINE_BYTES} bytes.`);
  }
  return line;
}

export function parsePiWorkerLine(line: string): unknown {
  if (Buffer.byteLength(line) > PI_WORKER_MAX_LINE_BYTES) {
    throw new Error(`Pi worker protocol line exceeds ${PI_WORKER_MAX_LINE_BYTES} bytes.`);
  }
  return JSON.parse(line) as unknown;
}
