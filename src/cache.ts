interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  generation: number;
}

export class Cache {
  private store = new Map<string, CacheEntry<unknown>>();
  private defaultTtlMs: number;
  private maxEntries: number;
  private _generation = 0;

  /** Current generation counter. Incremented on invalidate to prevent stale writes. */
  get generation(): number { return this._generation; }

  constructor(defaultTtlSeconds = 300, maxEntries = 500) {
    this.defaultTtlMs = defaultTtlSeconds * 1000;
    this.maxEntries = maxEntries;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // LRU: move to end of Map insertion order
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlSeconds?: number): void {
    if (ttlSeconds === 0) return; // Zero TTL = don't cache
    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }
    const ttlMs = ttlSeconds !== undefined ? ttlSeconds * 1000 : this.defaultTtlMs;
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs, generation: this._generation });
  }

  /**
   * Write to cache only if the generation hasn't changed since the caller started.
   * Prevents stale writes from in-flight requests that span a connection switch.
   */
  setIfSameGeneration<T>(key: string, data: T, gen: number, ttlSeconds?: number): void {
    if (gen !== this._generation) return; // Connection switched — discard stale result
    this.set(key, data, ttlSeconds);
  }

  invalidate(pattern?: string): void {
    this._generation++;
    if (!pattern) {
      this.store.clear();
      return;
    }
    const toDelete = [...this.store.keys()].filter(k => k.startsWith(pattern));
    for (const key of toDelete) {
      this.store.delete(key);
    }
  }
}
