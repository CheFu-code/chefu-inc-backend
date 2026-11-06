// Share only simultaneous reads. Settled results and failures are never cached.
// Each service owns an instance so separate dependencies cannot share data.
export class InFlightReads {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly maxEntries = 128) {}

  run<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    if (this.pending.size >= this.maxEntries) return Promise.resolve().then(load);
    const request = Promise.resolve().then(load);
    this.pending.set(key, request);
    const clear = () => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    };
    void request.then(clear, clear);
    return request;
  }
}
