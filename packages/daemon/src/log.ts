/**
 * The daemon's logging surface: small, injectable, and never a place where a
 * message body or a credential can land. Callers log categorical facts —
 * ghost names, event counts, error classes — not message text.
 */
import { fstatSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LogRecord {
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

const JOURNAL_PRIORITY: Record<LogLevel, number> = { debug: 7, info: 6, warn: 4, error: 3 };

/** True when stderr is the journal stream systemd handed this process, not one a child inherited. */
export function stderrIsJournal(env: NodeJS.ProcessEnv = process.env): boolean {
  const match = /^(\d+):(\d+)$/u.exec(env.JOURNAL_STREAM ?? "");
  if (!match) return false;
  try {
    const stderr = fstatSync(2, { bigint: true });
    return stderr.dev === BigInt(match[1] as string) && stderr.ino === BigInt(match[2] as string);
  } catch {
    return false;
  }
}

/**
 * One line per record on stderr. Under systemd a `<N>` prefix sets the
 * journal priority, and journald adds the time and the unit's identifier.
 */
export function stderrLogSink(journal = stderrIsJournal()): LogSink {
  return (record) => {
    const message = formatLogMessage(record.message, record.fields);
    process.stderr.write(journal
      ? `<${JOURNAL_PRIORITY[record.level]}>${message}\n`
      : `${new Date().toISOString()} ${record.level.padEnd(5)} ${message}\n`);
  };
}

export const stderrSink: LogSink = stderrLogSink(false);

export function formatLogMessage(
  message: string,
  fields?: Record<string, unknown>,
): string {
  const suffix = fields && Object.keys(fields).length > 0
    ? ` ${JSON.stringify(fields)}`
    : "";
  return `ghostd: ${message}${suffix}`;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(
  minLevel: LogLevel = "info",
  sink: LogSink = stderrSink,
  boundFields: Record<string, unknown> = {},
): Logger {
  const threshold = LEVEL_ORDER[minLevel];
  const hasBoundFields = Object.keys(boundFields).length > 0;
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const mergedFields = hasBoundFields ? { ...boundFields, ...fields } : fields;
    const recordFields = mergedFields && Object.keys(mergedFields).length > 0
      ? mergedFields
      : undefined;
    sink({ level, message, ...(recordFields ? { fields: recordFields } : {}) });
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(minLevel, sink, { ...boundFields, ...fields }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
