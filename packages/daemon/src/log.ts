/**
 * The daemon's logging surface: small, injectable, and never a place where a
 * message body or a credential can land. Callers log categorical facts —
 * ghost names, event counts, error classes — not visitor text.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(
  minLevel: LogLevel = "info",
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const threshold = LEVEL_ORDER[minLevel];
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const suffix = fields && Object.keys(fields).length > 0
      ? ` ${JSON.stringify(fields)}`
      : "";
    sink(`${new Date().toISOString()} ${level.padEnd(5)} ghostd: ${message}${suffix}`);
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
