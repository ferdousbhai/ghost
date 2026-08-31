import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ptr, read } from "bun:ffi";
import { describe, expect, it, vi } from "vitest";
import {
  buildJournalIovec,
  createJournalSink,
  encodeJournalRecord,
  journalLogSink,
} from "../src/journal.js";
import { createLogger, type LogRecord } from "../src/log.js";

function userJournalAvailable(): boolean {
  if (!existsSync("/run/systemd/journal/socket")) return false;
  const result = spawnSync("journalctl", ["--user", "--no-pager", "-n", "0"], {
    encoding: "utf8",
  });
  return result.status === 0;
}

const hasUserJournal = userJournalAvailable();

describe("journal records", () => {
  it.each([
    ["debug", "7"],
    ["info", "6"],
    ["warn", "4"],
    ["error", "3"],
  ] as const)("maps %s to priority %s", (level, priority) => {
    expect(encodeJournalRecord(level, "ready")).toEqual([
      "MESSAGE=ghostd: ready",
      `PRIORITY=${priority}`,
      "SYSLOG_IDENTIFIER=ghostd",
    ]);
  });

  it("extracts identity while retaining every field in MESSAGE", () => {
    expect(encodeJournalRecord("info", "opened", {
      ghost: "test-ghost",
      conversationId: "chat-1",
      tools: 9,
    })).toEqual([
      'MESSAGE=ghostd: opened {"ghost":"test-ghost","conversationId":"chat-1","tools":9}',
      "PRIORITY=6",
      "SYSLOG_IDENTIFIER=ghostd",
      "GHOST=test-ghost",
      "CONVERSATION=chat-1",
    ]);
  });

  it("prefers conversation over the conversationId alias", () => {
    expect(encodeJournalRecord("warn", "busy", {
      ghost: "test-ghost",
      conversation: "canonical",
      conversationId: "alias",
    })).toContain("CONVERSATION=canonical");
  });

  it("does not promote non-string identity fields", () => {
    const encoded = encodeJournalRecord("info", "opened", {
      ghost: null,
      conversation: { id: "object" },
      conversationId: "shadowed-alias",
    });

    expect(encoded).not.toContain(expect.stringMatching(/^(?:GHOST|CONVERSATION)=/u));
  });

  it("lays out one pointer and byte length per encoded field", () => {
    const fields = ["MESSAGE=ghostd: ready", "PRIORITY=6", "GHOST=døus"];
    const iovec = buildJournalIovec(fields);

    expect(iovec.buffer.byteLength).toBe(fields.length * 16);
    for (const [index, value] of iovec.values.entries()) {
      expect(read.u64(ptr(iovec.buffer), index * 16)).toBe(BigInt(ptr(value)));
      expect(read.u64(ptr(iovec.buffer), index * 16 + 8)).toBe(BigInt(value.byteLength));
    }
  });

  it("falls back once and permanently skips a failed sender", () => {
    const send = vi.fn(() => {
      throw new Error("unavailable");
    });
    const records: LogRecord[] = [];
    const logger = createLogger("info", journalLogSink({ send }, (record) => records.push(record)));

    logger.info("first", { ghost: "test-ghost" });
    logger.info("second", { ghost: "test-ghost" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      { level: "warn", message: "systemd journal unavailable; logging to stderr" },
      { level: "info", message: "first", fields: { ghost: "test-ghost" } },
      { level: "info", message: "second", fields: { ghost: "test-ghost" } },
    ]);
  });

  it("ignores inherited systemd identity that does not describe stderr", () => {
    const fallback = vi.fn();

    expect(createJournalSink(
      { JOURNAL_STREAM: "1:2", INVOCATION_ID: "inherited" },
      fallback,
      { stream: "1:3" },
    )).toBeNull();
    expect(createJournalSink(
      { INVOCATION_ID: "inherited" },
      fallback,
      { stream: "1:2" },
    )).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it.skipIf(!hasUserJournal)("round-trips identity through the user journal", async () => {
    const stream = "1:2";
    const fallback = vi.fn();
    const sink = createJournalSink(
      { ...process.env, JOURNAL_STREAM: stream },
      fallback,
      { stream },
    );
    expect(sink).not.toBeNull();

    const ghost = randomUUID();
    createLogger("info", sink!).info("journal integration probe", { ghost });

    let record: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20 && !record; attempt += 1) {
      const result = spawnSync(
        "journalctl",
        ["--user", "--no-pager", "-o", "json", "-n", "1", `GHOST=${ghost}`],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const line = result.stdout.trim().split("\n").find(Boolean);
      if (line) record = JSON.parse(line) as Record<string, unknown>;
      if (!record) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(fallback).not.toHaveBeenCalled();
    expect(record).toMatchObject({
      GHOST: ghost,
      SYSLOG_IDENTIFIER: "ghostd",
      MESSAGE: expect.stringContaining("journal integration probe"),
    });
  }, 5_000);
});
