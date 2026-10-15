/** Explicit, optional ranking through Recall. No model or index ownership here. */
import { execFile } from "node:child_process";

export interface RecallRecord { id: string; title: string; text: string }

export function rankRecords(collection: string, query: string, records: RecallRecord[]): Promise<string[] | null> {
  if (!records.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    const child = execFile("recall", ["rank", collection, query], { timeout: 6000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try {
        const reply = JSON.parse(stdout);
        if (reply.api !== 1 || reply.meaning !== true || reply.error || !Array.isArray(reply.hits)) { resolve(null); return; }
        const allowed = new Set(records.map((r) => r.id));
        const ids: string[] = [];
        for (const hit of reply.hits) {
          if (!allowed.has(hit.id) || typeof hit.score !== "number" || !Number.isFinite(hit.score)) { resolve(null); return; }
          if (!ids.includes(hit.id)) ids.push(hit.id);
        }
        resolve(ids);
      } catch { resolve(null); }
    });
    // A missing executable or a closed pipe is an ordinary fallback.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(records));
  });
}
