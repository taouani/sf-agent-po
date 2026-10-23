/**
 * Runs operations one at a time per key, in the order they were requested.
 * Used for read-modify-write on a context file and for publishing an artifact,
 * since hosts may run tool calls in parallel or retry them.
 */
export class KeyedLock {
  private readonly queues = new Map<string, Promise<unknown>>();

  run<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(op, op);
    const settled = next.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }
}
