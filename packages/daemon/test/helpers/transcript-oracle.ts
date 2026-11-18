import { entryMessages, messageCount, type LogEntry, type TranscriptMessage } from "../../src/conversation-log.js";

/**
 * The transcript page `readTranscriptPage` should serve, computed straight
 * from the entries with no file or index: the oracle its indexed reads are
 * checked against. Harness and title records are not messages.
 */
export function transcriptPage(entries: readonly LogEntry[], offset = 0, limit = Infinity): { messages: TranscriptMessage[]; total: number } {
  const messages: TranscriptMessage[] = [];
  let total = 0;
  entries.forEach((entry, index) => {
    const count = messageCount(entry);
    const first = total;
    total += count;
    if (count === 0 || first >= offset + limit || total <= offset) return;
    messages.push(...entryMessages(entry, `e${index}`, Math.max(0, offset - first), offset + limit - Math.max(offset, first)));
  });
  return { messages, total };
}
