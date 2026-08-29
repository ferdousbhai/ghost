import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/log.js";
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
