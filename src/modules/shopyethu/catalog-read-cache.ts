// Cache only public product snapshots. Store visibility and every write remain uncached.
// A short TTL also bounds staleness between separate API instances without Redis.
export class CatalogReadCache {
  private readonly values = new Map<string, { value: unknown; expires: number; size: number }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private generation = 0;
  constructor(private readonly now = Date.now, private readonly ttl = 10_000) {}
  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const saved = this.values.get(key);
    if (saved && saved.expires > this.now()) {
      this.values.delete(key); this.values.set(key, saved);
      return structuredClone(saved.value) as T;
    }
    const existing = this.pending.get(key);
    if (existing) return structuredClone(await existing) as T;
    if (this.pending.size >= 64) return load();
    const generation = this.generation;
    const work = Promise.resolve().then(load);
    this.pending.set(key, work);
    try {
      const value = await work, size = Buffer.byteLength(JSON.stringify(value));
      if (generation === this.generation && size <= 256_000) {
        this.values.delete(key); this.values.set(key, { value: structuredClone(value), expires: this.now() + this.ttl, size });
        let bytes = [...this.values.values()].reduce((sum, entry) => sum + entry.size, 0);
        for (const [id, entry] of this.values) {
          if (this.values.size <= 64 && bytes <= 2_000_000) break;
          this.values.delete(id); bytes -= entry.size;
        }
      }
      return structuredClone(value);
    } finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }
  invalidate() { this.generation++; this.values.clear(); this.pending.clear(); }
}
