import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { trashPath } from "../trash.js";
import { ArgsError, flagBoolean, type ParsedCliArgs } from "./args.js";
import { resolveTarget } from "./common.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";
import type { SharedResult } from "../results.js";

export async function resultsCommand(parsed: ParsedCliArgs, ctx: CliContext): Promise<number> {
  const [action = "list", input, destination] = parsed.positionals;
  if (parsed.positionals.length > 3 || (action === "list" && input) || (["add", "remove"].includes(action) && (!input || destination))
    || (action === "get" && (!input || !destination)) || !["list", "add", "get", "remove"].includes(action)) {
    throw new ArgsError("ghost results takes list, add <path>, get <id> <destination>, or remove <id>");
  }
  const { path } = await resolveTarget(ctx.client, ctx, parsed), root = `${path}/results`;
  if (action === "list") {
    const body = (await ctx.client.request<{ results: Array<SharedResult & { downloadUrl: string }> }>("GET", root)).body;
    emit(ctx, body, () => body.results.length ? `${body.results.map(result => `${result.id} ${result.name} (${result.bytes} bytes)`).join("\n")}\n` : "No shared results.\n");
  } else if (action === "add") {
    const body = (await ctx.client.request<SharedResult>("POST", root, { path: resolve(input as string) }, 120000)).body;
    emit(ctx, body, () => `Shared ${body.name}: ${body.id}\n`);
  } else if (action === "remove") {
    const body = (await ctx.client.request("DELETE", `${root}/${encodeURIComponent(input as string)}`)).body;
    emit(ctx, body, () => "Result moved to Trash; its download is revoked.\n");
  } else {
    const bytes = await ctx.client.download(`${root}/${encodeURIComponent(input as string)}`);
    // --replace writes beside the destination, then trashes the old file (recoverable) before the rename.
    const replace = flagBoolean(parsed, "replace"), target = destination as string;
    // Only an existing regular file may be replaced; a directory or anything else is refused untouched.
    const existing = replace ? await stat(target).catch(() => null) : null;
    if (existing && !existing.isFile()) throw new ArgsError(`${target} is not a file; give the file path to save to.`);
    const written = replace ? join(dirname(target), `.${basename(target)}.${randomUUID()}.part`) : target;
    const file = await open(written, "wx", 0o600);
    try { await file.writeFile(bytes); }
    catch (error) { await file.close(); await rm(written, { force: true }); throw error; }
    await file.close();
    if (replace) {
      try {
        if (existing) await trashPath(target, ctx.runtime.env);
        await rename(written, target);
      } catch (error) { await rm(written, { force: true }); throw error; }
    }
    emit(ctx, { path: resolve(destination as string) }, () => `Saved ${destination}\n`);
  }
  return 0;
}
