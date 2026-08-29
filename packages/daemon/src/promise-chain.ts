/**
 * Run `task` after every task previously queued under `key`, in order, and
 * forget the key once its queue drains. A rejected predecessor does not stop
 * the next task; each caller sees only its own result.
 */
export function serializeByKey<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  chains.set(key, tail);
  return next;
}
