/**
 * `ghost skill [install|remove]`: the `ghost` skill (skills/ghost/SKILL.md),
 * as Ghost's other products ship theirs. Ghost's own turns already get it
 * linked into each conversation; installing it serves the owner's other
 * agents. Install copies it to ~/.agents/skills/ghost/ and links it into
 * ~/.claude/skills/ when Claude Code is installed; remove takes away only
 * what install made.
 */
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledSkillsDir, resolveRunningSource } from "../running-source.js";
import { CliError, EXIT_CODE } from "./client.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";

/** The skill this `ghost` shipped with: the package's, or this checkout's. */
function shippedSkill(version: string): string {
  return join(bundledSkillsDir(resolveRunningSource(version, dirname(fileURLToPath(import.meta.url)))), "ghost", "SKILL.md");
}

function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

export async function skillCommand(ctx: CliContext): Promise<number> {
  const action = ctx.parsed.positionals[0];
  const source = shippedSkill(ctx.version);
  const agents = join(ctx.runtime.home, ".agents", "skills", "ghost");
  const claude = join(ctx.runtime.home, ".claude", "skills", "ghost");
  if (action === undefined) {
    let text: string;
    try {
      text = await readFile(source, "utf8");
    } catch {
      throw new CliError(EXIT_CODE.failure, `this ghost has no skill at ${source}`);
    }
    emit(ctx, { path: source, text }, (body) => body.text);
    return EXIT_CODE.success;
  }
  if (action === "install") {
    const text = await readFile(source, "utf8").catch(() => {
      throw new CliError(EXIT_CODE.failure, `this ghost has no skill at ${source}`);
    });
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "SKILL.md"), text);
    let linked: string | null = null;
    if (existsSync(join(ctx.runtime.home, ".claude"))) {
      if (!existsSync(claude) && !isLinkTo(claude, agents)) {
        await mkdir(dirname(claude), { recursive: true });
        await symlink(agents, claude);
      }
      linked = isLinkTo(claude, agents) ? claude : null;
    }
    emit(ctx, { installed: agents, linked }, (body) =>
      `Installed the ghost skill in ${body.installed}${body.linked ? `, linked from ${body.linked}` : ""}.\n`);
    return EXIT_CODE.success;
  }
  if (action === "remove") {
    const removed: string[] = [];
    if (isLinkTo(claude, agents)) {
      await rm(claude);
      removed.push(claude);
    }
    if (existsSync(join(agents, "SKILL.md"))) {
      await rm(join(agents, "SKILL.md"));
      await rmdir(agents).catch(() => {});
      removed.push(agents);
    }
    emit(ctx, { removed }, (body) => body.removed.length ? `Removed ${body.removed.join(" and ")}.\n` : "The ghost skill was not installed.\n");
    return EXIT_CODE.success;
  }
  throw new CliError(EXIT_CODE.usage, `skill: unknown action ${JSON.stringify(action)}; use install or remove`);
}
