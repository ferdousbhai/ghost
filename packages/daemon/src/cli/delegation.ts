import { isAbsolute } from "node:path";
import { ClaudeAgentDiscovery } from "../claude-agent-discovery.js";
import { ClaudeCodeProbe } from "../claude-code.js";
import { renderDelegationStatus } from "../delegation-status.js";
import { HarnessCatalog } from "../harness-catalog.js";
import type { ParsedCliArgs } from "./args.js";
import { emit } from "./output.js";
import type { CliContext, DelegationStatusLoader } from "./types.js";

const loadNativeDelegationStatus: DelegationStatusLoader = async ({
  cwd,
  env,
  ownerHome,
}) => {
  if (!isAbsolute(cwd)) throw new TypeError("Delegation cwd must be absolute.");
  const probe = new ClaudeCodeProbe({ env });
  const harnesses = new HarnessCatalog({
    ownerHome,
    env,
    claudeCodeProbe: probe,
  });
  const claudeAgents = new ClaudeAgentDiscovery({ env, probe });
  const [catalog, agents] = await Promise.all([
    harnesses.list(),
    claudeAgents.list(cwd),
  ]);
  return { ...catalog, claudeAgents: agents };
};

export async function delegationCommand(
  _parsed: ParsedCliArgs,
  ctx: CliContext,
): Promise<number> {
  const load = ctx.runtime.loadDelegationStatus ?? loadNativeDelegationStatus;
  const status = await load({
    cwd: ctx.runtime.cwd,
    env: ctx.runtime.env,
    ownerHome: ctx.runtime.home,
  });
  emit(ctx, { cwd: ctx.runtime.cwd, ...status }, () => `${renderDelegationStatus(status)}\n`);
  return 0;
}
