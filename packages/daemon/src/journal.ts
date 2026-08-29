import { fstatSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createLogger, formatLogMessage, stderrSink, type LogLevel, type LogSink } from "./log.js";

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

export interface JournalSinkOptions {
  /** Test seam for the stderr `dev:ino` value. */
  stream?: string;
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
  if (typeof fields?.ghost === "string") encoded.push(`GHOST=${fields.ghost}`);
  const conversation = fields?.conversation ?? fields?.conversationId;
  if (typeof conversation === "string") encoded.push(`CONVERSATION=${conversation}`);
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
  createLogger("warn", fallback).warn("systemd journal unavailable; logging to stderr");
}

/** Wrap a sender so its first failure permanently and visibly selects stderr. */
export function journalLogSink(sender: JournalSender, fallback: LogSink = stderrSink): LogSink {
  let enabled = true;
  return (record) => {
    if (!enabled) {
      fallback(record);
      return;
    }
    try {
      const result = sender.send(encodeJournalRecord(record.level, record.message, record.fields));
      if (result !== 0) throw new Error("sd_journal_sendv failed");
    } catch {
      enabled = false;
      fallbackWarning(fallback);
      fallback(record);
    }
  };
}

function parseJournalStream(value: string | undefined): { dev: bigint; ino: bigint } | null {
  const match = /^(\d+):(\d+)$/u.exec(value ?? "");
  const dev = match?.[1];
  const ino = match?.[2];
  return dev !== undefined && ino !== undefined
    ? { dev: BigInt(dev), ino: BigInt(ino) }
    : null;
}

function underSystemd(env: NodeJS.ProcessEnv, options: JournalSinkOptions): boolean {
  const inherited = parseJournalStream(env.JOURNAL_STREAM);
  if (!inherited) return false;
  try {
    const stderr = options.stream === undefined
      ? fstatSync(2, { bigint: true })
      : parseJournalStream(options.stream);
    return stderr !== null && inherited.dev === stderr.dev && inherited.ino === stderr.ino;
  } catch {
    return false;
  }
}

/** Load libsystemd only for a systemd-owned daemon; null selects stderr. */
export function createJournalSink(
  env: NodeJS.ProcessEnv = process.env,
  fallback: LogSink = stderrSink,
  options: JournalSinkOptions = {},
): LogSink | null {
  if (!underSystemd(env, options)) return null;
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
        // Reading the retained array here keeps every value buffer alive until sendv returns.
        if (iovec.values.length !== fields.length) throw new Error("journal iovec field mismatch");
        return result;
      },
    }, fallback);
  } catch {
    fallbackWarning(fallback);
    return null;
  }
}
