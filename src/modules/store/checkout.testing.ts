import assert from 'node:assert/strict';
import { CheckoutService } from './checkout.service';
import { StoreJobsService } from './store-jobs.service';
import { PaystackService, PaystackTransaction } from './paystack.service';
import type { StoreOrder } from './payment.model';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import type { ProductsService } from '../products/products.service';
import type { ProductDocument } from '../products/products.types';

export const input = () => ({ currency: 'ZAR', termsAccepted: true, items: [{ productId: 'shirt', quantity: 2 }], delivery: { firstName: 'Ada', lastName: 'Example', email: 'ada@example.com', phone: '+27 60 123 4567', addressLine1: '1 Example Street', addressLine2: '', city: 'Pretoria', province: 'Gauteng', postalCode: '0123', country: 'ZA', notes: '' } });
export const product = (overrides: Partial<ProductDocument> = {}) => ({ id: 'shirt', name: 'Shirt', sku: 'SHIRT', currency: 'ZAR', status: 'ACTIVE', priceMinor: 25_000, inventoryQuantity: 100, variants: [], stockTracking: true, ...overrides }) as ProductDocument;
type RecordData = Record<string, unknown>;

// Isolated adapter enforces read-before-write and all-or-nothing commits. Shared
// instances exercise distributed claims without sharing in-memory service locks.
export function database() {
  const records = new Map<string, RecordData>();
  const ref = (path: string) => ({ path, id: path.split('/').at(-1)!,
    get: async () => snapshot(path),
    update: async (data: RecordData) => { assert.ok(records.has(path)); records.set(path, { ...records.get(path), ...structuredClone(data) }); },
    set: async (data: RecordData) => { records.set(path, structuredClone(data)); },
  });
  const snapshot = (path: string) => ({ id: path.split('/').at(-1)!, ref: ref(path), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  function query(name: string, filters: [string, string, unknown][] = [], sort?: [string, string], max = 1000, cursor = '') {
    return {
      doc: (id: string) => ref(`${name}/${id}`),
      where: (field: string, op: string, value: unknown) => query(name, [...filters, [field, op, value]], sort, max, cursor),
      orderBy: (field: unknown, direction = 'asc') => query(name, filters, [typeof field === 'string' ? field : '__name__', direction], max, cursor),
      limit: (value: number) => query(name, filters, sort, value, cursor),
      startAfter: (value: string) => query(name, filters, sort, max, value),
      get: async () => {
        let values = [...records.entries()].filter(([path, data]) => path.startsWith(`${name}/`) && path.split('/').at(-1)! > cursor && filters.every(([field, op, value]) => op === 'in' ? (value as unknown[]).includes(data[field]) : op === '<=' ? Number(data[field]) <= Number(value) : data[field] === value));
        if (sort) values.sort(([a, ad], [b, bd]) => { const av = sort[0] === '__name__' ? a : ad[sort[0]]; const bv = sort[0] === '__name__' ? b : bd[sort[0]]; return (av! < bv! ? -1 : av! > bv! ? 1 : 0) * (sort[1] === 'desc' ? -1 : 1); });
        const docs = values.slice(0, max).map(([path]) => snapshot(path));
        return { docs, size: docs.length, empty: !docs.length };
      },
    };
  }
  let queue = Promise.resolve();
  const db = { collection: (name: string) => query(name),
    runTransaction: async <T>(callback: (transaction: unknown) => Promise<T>) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      const writes: (() => void)[] = [];
      const read = (path: string) => { assert.equal(writes.length, 0, 'Firestore reads must precede writes'); return snapshot(path); };
      try {
        const result = await callback({
          get: async (value: { path: string }) => read(value.path),
          getAll: async (...refs: { path: string }[]) => refs.map(value => read(value.path)),
          create: (value: { path: string }, data: RecordData) => { assert.equal(records.has(value.path), false, `Document exists: ${value.path}`); writes.push(() => { records.set(value.path, structuredClone(data)); }); },
          set: (value: { path: string }, data: RecordData) => { writes.push(() => { records.set(value.path, structuredClone(data)); }); },
          update: (value: { path: string }, data: RecordData) => { assert.ok(records.has(value.path)); writes.push(() => { records.set(value.path, { ...records.get(value.path), ...structuredClone(data) }); }); },
        });
        writes.forEach(write => write());
        return result;
      } finally { release(); }
    },
  };
  return { db, records };
}
export function setup() {
  const { db, records } = database();
  records.set('products/shirt', product());
  const calls = { initialize: 0, verify: 0 };
  const payments = new Map<string, PaystackTransaction>();
  const gateway = {
    assertConfigured: () => {},
    initialize: async (order: StoreOrder) => {
      calls.initialize++;
      payments.set(order.reference, { id: String(calls.initialize), domain: 'test', reference: order.reference, status: 'pending', amount: order.amountMinor, currency: 'ZAR', customer: { email: order.delivery.email }, metadata: { orderId: order.reference, paymentAttemptId: order.reference } });
      return 'test_access_code';
    },
    verify: async (reference: string) => { calls.verify++; return structuredClone(payments.get(reference)!); },
  };
  const firebase = { db: () => db } as unknown as FirebaseAdminService;
  const jobs = new StoreJobsService(firebase);
  const service = () => new CheckoutService(firebase, gateway as unknown as PaystackService, { invalidateProductsCache() {} } as ProductsService, new StoreJobsService(firebase));
  const due = () => { for (const [path, value] of records) { if (path.startsWith('storeJobs/') && value.state !== 'completed') value.availableAt = 0; if (path.startsWith('storePayments/')) value.nextVerificationAt = 0; } };
  const count = (collection: string) => [...records.keys()].filter(path => path.startsWith(`${collection}/`)).length;
  return { service: service(), newService: service, jobs, firebase, records, calls, gateway, payments, due, count };
}
