import type { Filters, MarketplaceRepository, PageOptions, Transaction } from './marketplace.types';

// Isolated unit-test dependency. Never imported by the app module or a server.
export class TestRepository implements MarketplaceRepository {
  private rows = new Map<string, object>();
  private queue: Promise<unknown> = Promise.resolve();
  writes = 0;
  async get<T>(table: string, id: string): Promise<T | null> { return structuredClone(this.rows.get(`${table}/${id}`) ?? null) as T | null; }
  async getMany<T>(table: string, ids: string[]) {
    const result = new Map<string, T>();
    for (const id of new Set(ids)) {
      const value = await this.get<T>(table, id);
      if (value !== null) result.set(id, value);
    }
    return result;
  }
  async list<T>(table: string, filters: Filters = []): Promise<T[]> {
    return [...this.rows].filter(([key, value]) => key.startsWith(`${table}/`) && filters.every(([field, expected]) => String((value as Record<string, unknown>)[field]) === expected)).map(([, value]) => structuredClone(value) as T);
  }
  async page<T>(table: string, filters: Filters, after: string, limit: number, options: PageOptions = {}) {
    const matching = [...this.rows].filter(([key, value]) => {
      const record = value as Record<string, unknown>;
      return key.startsWith(`${table}/`) &&
        filters.every(([field, expected]) => String(record[field]) === expected);
    }).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (!options.order) return leftKey.localeCompare(rightKey);
      const field = options.order.field;
      const left = (leftValue as Record<string, unknown>)[field] as string | number;
      const right = (rightValue as Record<string, unknown>)[field] as string | number;
      const compared = left < right ? -1 : left > right ? 1 : 0;
      const byId = options.order.direction === 'desc' ? rightKey.localeCompare(leftKey) : leftKey.localeCompare(rightKey);
      return (options.order.direction === 'desc' ? -compared : compared) || byId;
    });
    const cursor = after && options.order
      ? JSON.parse(Buffer.from(after.slice(3), 'base64url').toString('utf8')) as [string, 'asc' | 'desc', string | number, string]
      : null;
    const start = after ? matching.findIndex(([key, value]) => {
      if (!options.order) return key.slice(table.length + 1) > after;
      if (!cursor || cursor[0] !== options.order.field || cursor[1] !== options.order.direction) return false;
      const fieldValue = (value as Record<string, unknown>)[options.order.field] as string | number;
      const primary = fieldValue < cursor[2] ? -1 : fieldValue > cursor[2] ? 1 : 0;
      const ordered = options.order.direction === 'desc' ? -primary : primary;
      const byId = options.order.direction === 'desc'
        ? cursor[3].localeCompare(key.slice(table.length + 1))
        : key.slice(table.length + 1).localeCompare(cursor[3]);
      return (ordered || byId) > 0;
    }) : 0;
    const available = after && start < 0 ? [] : matching.slice(after ? start : 0);
    const docs = available.slice(0, limit + 1);
    return {
      items: docs.slice(0, limit).map(([, value]) => structuredClone(value) as T),
      nextCursor: docs.length <= limit ? null : options.order
        ? `c1.${Buffer.from(JSON.stringify([options.order.field, options.order.direction, (docs[limit - 1][1] as Record<string, unknown>)[options.order.field], docs[limit - 1][0].slice(table.length + 1)])).toString('base64url')}`
        : docs[limit - 1][0].slice(table.length + 1),
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
