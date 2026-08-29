import {
  createLogger,
  type Logger,
  type LogLevel,
  type LogRecord,
} from "../../src/log.js";

export interface RecordingLogger extends Logger {
  readonly records: LogRecord[];
}

export function recordingLogger(level: LogLevel = "debug"): RecordingLogger {
  const records: LogRecord[] = [];
  return Object.assign(createLogger(level, (record) => records.push(record)), { records });
}
