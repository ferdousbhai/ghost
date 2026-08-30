import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Inspect leading transcript identity metadata without allocating the append-only remainder. */
export async function visitLeadingEntries(
  sessionFile: string,
  visit: (entry: unknown) => boolean,
): Promise<void> {
  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!visit(entry)) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
