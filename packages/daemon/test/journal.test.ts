import { ptr, read } from "bun:ffi";
import { describe, expect, it, vi } from "vitest";
import { buildJournalIovec, encodeJournalRecord, journalLogSink } from "../src/journal.js";
import { createLogger } from "../src/log.js";

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
      ghost: "dous",
      conversationId: "chat-1",
      tools: 9,
    })).toEqual([
      'MESSAGE=ghostd: opened {"ghost":"dous","conversationId":"chat-1","tools":9}',
      "PRIORITY=6",
      "SYSLOG_IDENTIFIER=ghostd",
      "GHOST=dous",
      "CONVERSATION=chat-1",
    ]);
  });

  it("prefers conversation over the conversationId alias", () => {
    expect(encodeJournalRecord("warn", "busy", {
      ghost: "dous",
      conversation: "canonical",
      conversationId: "alias",
    })).toContain("CONVERSATION=canonical");
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
    const lines: string[] = [];
    const logger = createLogger("info", journalLogSink({ send }, (line) => lines.push(line)));

    logger.info("first", { ghost: "dous" });
    logger.info("second", { ghost: "dous" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("systemd journal emission failed; falling back to stderr");
    expect(lines[1]).toContain('ghostd: first {"ghost":"dous"}');
    expect(lines[2]).toContain('ghostd: second {"ghost":"dous"}');
  });
});
