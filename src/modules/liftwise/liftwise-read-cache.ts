// Bounded per-process cache. Never cache identity/SSO checks or failed reads.
export class LiftWiseReadCache {
  private readonly entries = new Map<
    string,
    { until: number; value: Promise<unknown> }
  >();
  async get<T>(key: string, load: () => Promise<T>, ttl = 30_000): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.until > Date.now()) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.value as Promise<T>;
    }
    const entry = {
      until: Infinity,
      value: Promise.resolve().then(load) as Promise<unknown>,
    };
    this.entries.set(key, entry);
    while (this.entries.size > 512)
      this.entries.delete(this.entries.keys().next().value!);
    try {
      const value = (await entry.value) as T;
      entry.until = Date.now() + ttl;
      return value;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }
  invalidateUser(uid: string, resources?: string[]) {
    const prefix = `${JSON.stringify([uid]).slice(0, -1)},`;
    for (const key of this.entries.keys())
      if (
        key.startsWith(prefix) &&
        (!resources || resources.includes(JSON.parse(key)[1]))
      )
        this.entries.delete(key);
  }
}
