/** Disposable lookup results; oldest reads are evicted without a background timer. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly limit = 256) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Cache limit must be a positive integer.");
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }
}
