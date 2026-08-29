import { describe, expect, it } from "vitest";
import { createLogger, silentLogger } from "../src/log.js";

describe("logger children", () => {
  it("merges bound fields below call-site fields", () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line))
      .child({ ghost: "casper", conversation: "first", inherited: true });

    logger.info("opened", { conversation: "second", local: true });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ info {2}ghostd: opened /);
    expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")))).toEqual({
      ghost: "casper",
      conversation: "second",
      inherited: true,
      local: true,
    });
  });

  it("keeps silent children silent and returns the singleton", () => {
    expect(silentLogger.child({ ghost: "casper" })).toBe(silentLogger);
  });
});
