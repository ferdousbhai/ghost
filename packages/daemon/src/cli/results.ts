import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ArgsError, type ParsedCliArgs } from "./args.js";
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
    const file = await open(destination as string, "wx", 0o600);
    try { await file.writeFile(bytes); }
    catch (error) { await rm(destination as string, { force: true }); throw error; }
    finally { await file.close(); }
    emit(ctx, { path: resolve(destination as string) }, () => `Saved ${destination}\n`);
  }
  return 0;
}
