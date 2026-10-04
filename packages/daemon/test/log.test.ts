import { describe, expect, it, vi } from "vitest";
import { silentLogger, stderrIsJournal, stderrLogSink } from "../src/log.js";
import { recordingLogger } from "./helpers/recording-logger.js";

describe("logger children", () => {
  it("merges bound fields below call-site fields", () => {
    const root = recordingLogger();
    const logger = root
      .child({ ghost: "casper", conversation: "first", inherited: true });

    logger.info("opened", { conversation: "second", local: true });

    expect(root.records).toEqual([{
      level: "info",
      message: "opened",
      fields: {
        ghost: "casper",
        conversation: "second",
        inherited: true,
        local: true,
      },
    }]);
  });

  it("keeps silent children silent and returns the singleton", () => {
    expect(silentLogger.child({ ghost: "casper" })).toBe(silentLogger);
  });
});

describe("stderr sink", () => {
  function written(journal: boolean): string {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      stderrLogSink(journal)({ level: "warn", message: "stalled", fields: { ghost: "casper" } });
      return String(write.mock.calls[0]?.[0]);
    } finally {
      write.mockRestore();
    }
  }

  it("prefixes the journal priority under systemd and leaves the time to journald", () => {
    expect(written(true)).toBe('<4>ghostd: stalled {"ghost":"casper"}\n');
  });

  it("writes a timestamped line anywhere else", () => {
    expect(written(false)).toMatch(/^\d{4}-\d\d-\d\dT\S+ warn {2}ghostd: stalled /u);
  });

  it("treats an inherited JOURNAL_STREAM that is not this stderr as no journal", () => {
    expect(stderrIsJournal({ JOURNAL_STREAM: "1:1" })).toBe(false);
    expect(stderrIsJournal({})).toBe(false);
  });
});
