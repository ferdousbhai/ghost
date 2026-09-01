import { ClaudeAgentSdkLoader } from "../claude-agent-sdk-loader.js";
import type { NativeHarnessStatus } from "../native-harness-catalog.js";
import {
  captureNativeHarnessEnvironments,
  createNativeHarnessCatalog,
} from "../native-harness-runtime.js";
import type { ParsedCliArgs } from "./args.js";
import { emit, table } from "./output.js";
import type { CliContext } from "./types.js";

function publicStatuses(
  statuses: readonly NativeHarnessStatus[],
): NativeHarnessStatus[] {
  return statuses.map(({ id, availability, authentication }) => ({
    id,
    availability,
    authentication,
  }));
}

/** Read local native-worker availability without opening ghostd or ghost data. */
export async function delegationCommand(
  _parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const catalogue = ctx.runtime.nativeHarnesses
    ?? createNativeHarnessCatalog(
      new ClaudeAgentSdkLoader({
        ownerHome: ctx.runtime.home,
        ...(ctx.runtime.env.XDG_DATA_HOME === undefined
          ? {}
          : { xdgDataHome: ctx.runtime.env.XDG_DATA_HOME }),
      }),
      captureNativeHarnessEnvironments(ctx.runtime.env),
    );
  const harnesses = publicStatuses(await catalogue.list());
  emit(ctx, { harnesses }, () => ({
    human: `${table(
      harnesses.map(({ id, availability, authentication }) => [
        id,
        availability,
        authentication,
      ]),
      ["harness", "availability", "authentication"],
    )}\n`,
    quiet: `${harnesses.filter(({ availability }) => availability === "available").length}`
      + `/${harnesses.length} available\n`,
  }));
  return 0;
}
