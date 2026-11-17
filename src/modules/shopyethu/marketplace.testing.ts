import type { Filters, MarketplaceRepository, Transaction } from './marketplace.types';

// Isolated unit-test dependency. Never imported by the app module or a server.
export class TestRepository implements MarketplaceRepository {
  private rows = new Map<string, object>();
  private queue: Promise<unknown> = Promise.resolve();
  writes = 0;
  async get<T>(table: string, id: string): Promise<T | null> { return structuredClone(this.rows.get(`${table}/${id}`) ?? null) as T | null; }
  async list<T>(table: string, filters: Filters = []): Promise<T[]> {
    return [...this.rows].filter(([key, value]) => key.startsWith(`${table}/`) && filters.every(([field, expected]) => String((value as Record<string, unknown>)[field]) === expected)).map(([, value]) => structuredClone(value) as T);
  }
  async page<T>(table: string, filters: Filters, after: string, limit: number) {
    const matching = [...this.rows]
      .filter(([key, value]) => key.startsWith(`${table}/`) &&
        key.slice(table.length + 1) > after &&
        filters.every(([field, expected]) => String((value as Record<string, unknown>)[field]) === expected))
      .sort(([left], [right]) => left.localeCompare(right));
    const docs = matching.slice(0, limit + 1);
    return {
      items: docs.slice(0, limit).map(([, value]) => structuredClone(value) as T),
      nextCursor: docs.length > limit ? docs[limit - 1][0].slice(table.length + 1) : null,
    };
  }
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(async () => {
      const snapshot = new Map(this.rows);
      const pending: [string, object | null][] = [];
      const tx: Transaction = {
        get: async <V>(table: string, id: string) => {
          if (pending.length) throw new Error('Firestore transactions must read before writing.');
          return structuredClone(snapshot.get(`${table}/${id}`) ?? null) as V | null;
        },
        set: (table, id, value) => { pending.push([`${table}/${id}`, structuredClone(value)]); },
        delete: (table, id) => { pending.push([`${table}/${id}`, null]); },
      };
      const result = await work(tx);
      pending.forEach(([key, value]) => { if (value === null) snapshot.delete(key); else snapshot.set(key, value); });
      this.rows = snapshot;
      this.writes += pending.length;
      return result;
    });
    this.queue = run; return run;
  }
}
