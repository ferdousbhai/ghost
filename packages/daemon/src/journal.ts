import { dlopen, FFIType, ptr } from "bun:ffi";
import { formatLogMessage, stderrSink, type LogLevel, type LogRecord, type LogSink } from "./log.js";

const JOURNAL_PRIORITY: Record<LogLevel, number> = {
  debug: 7,
  info: 6,
  warn: 4,
  error: 3,
};
const IOVEC_BYTES = 16;

export interface JournalIovec {
  buffer: Buffer;
  values: Buffer[];
}

export interface JournalSender {
  send(fields: readonly string[]): number;
}

/** Encode one daemon record as the exact fields handed to sd_journal_sendv. */
export function encodeJournalRecord(
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): string[] {
  const encoded = [
    `MESSAGE=${formatLogMessage(message, fields)}`,
    `PRIORITY=${JOURNAL_PRIORITY[level]}`,
    "SYSLOG_IDENTIFIER=ghostd",
  ];
  if (fields?.ghost !== undefined) encoded.push(`GHOST=${String(fields.ghost)}`);
  const conversation = fields?.conversation ?? fields?.conversationId;
  if (conversation !== undefined) encoded.push(`CONVERSATION=${String(conversation)}`);
  return encoded;
}

/** Build the x86-64 `struct iovec[]`; values stay referenced beside it. */
export function buildJournalIovec(fields: readonly string[]): JournalIovec {
  const values = fields.map((field) => Buffer.from(field, "utf8"));
  const buffer = Buffer.alloc(values.length * IOVEC_BYTES);
  for (const [index, value] of values.entries()) {
    const offset = index * IOVEC_BYTES;
    buffer.writeBigUInt64LE(BigInt(ptr(value)), offset);
    buffer.writeBigUInt64LE(BigInt(value.byteLength), offset + 8);
  }
  return { buffer, values };
}

function fallbackWarning(fallback: LogSink): void {
  const record: LogRecord = {
    level: "warn",
    message: "systemd journal emission failed; falling back to stderr",
  };
  fallback(
    `${new Date().toISOString()} warn  ${formatLogMessage(record.message)}`,
    record,
  );
}

/** Wrap a sender so its first failure permanently and visibly selects stderr. */
export function journalLogSink(sender: JournalSender, fallback: LogSink = stderrSink): LogSink {
  let enabled = true;
  return (line, record) => {
    if (!enabled) {
      fallback(line, record);
      return;
    }
    try {
      const result = sender.send(encodeJournalRecord(record.level, record.message, record.fields));
      if (result !== 0) throw new Error("sd_journal_sendv failed");
    } catch {
      enabled = false;
      fallbackWarning(fallback);
      fallback(line, record);
    }
  };
}

function underSystemd(env: NodeJS.ProcessEnv): boolean {
  return env.JOURNAL_STREAM !== undefined || env.INVOCATION_ID !== undefined;
}

/** Load libsystemd only for a systemd-owned daemon; null selects stderr. */
export function createJournalSink(
  env: NodeJS.ProcessEnv = process.env,
  fallback: LogSink = stderrSink,
): LogSink | null {
  if (!underSystemd(env)) return null;
  try {
    const library = dlopen("libsystemd.so.0", {
      sd_journal_sendv: {
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    return journalLogSink({
      send(fields) {
        const iovec = buildJournalIovec(fields);
        const result = library.symbols.sd_journal_sendv(ptr(iovec.buffer), fields.length);
        void iovec.values;
        return result;
      },
    }, fallback);
  } catch {
    fallbackWarning(fallback);
    return null;
  }
}
