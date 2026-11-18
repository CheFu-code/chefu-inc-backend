import { BadRequestException, Injectable } from '@nestjs/common';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import type { Filters, MarketplaceRepository, PageOptions, Transaction } from './marketplace.types';
import { FieldPath } from 'firebase-admin/firestore';
import { CatalogReadCache } from './catalog-read-cache';

const collection = (table: string) => table === 'accountProfiles' ? 'users' : `shopyethu_${table}`;
function documentId(id: string) {
  if (!id || id.length > 150 || /[/\\]/.test(id) || ['.', '..'].includes(id)) throw new BadRequestException('Invalid reference.');
  return id;
}
function encodeCursor(value: unknown, id: string, order: NonNullable<PageOptions['order']>) {
  return `c1.${Buffer.from(JSON.stringify([order.field, order.direction, value, id])).toString('base64url')}`;
}
function decodeCursor(cursor: string, order: NonNullable<PageOptions['order']>) {
  try {
    if (!cursor.startsWith('c1.')) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== order.field ||
      parsed[1] !== order.direction || typeof parsed[3] !== 'string' ||
      !(typeof parsed[2] === 'string' || typeof parsed[2] === 'number')) throw new Error();
    if (order.field === 'priceCents' && !Number.isInteger(parsed[2])) throw new Error();
    if (order.field !== 'priceCents' && (typeof parsed[2] !== 'string' || parsed[2].length > 100)) throw new Error();
    return [parsed[2], documentId(parsed[3])] as const;
  } catch {
    throw new BadRequestException('Invalid page cursor.');
  }
}
@Injectable()
export class FirestoreMarketplaceRepository implements MarketplaceRepository {
  private readonly publicProducts = new CatalogReadCache();
  constructor(private readonly firebase: FirebaseAdminService) {}
  async get<T>(table: string, id: string): Promise<T | null> {
    const doc = await this.firebase.db().collection(collection(table)).doc(documentId(id)).get();
    return doc.exists ? doc.data() as T : null;
  }
  async getMany<T>(table: string, ids: string[]): Promise<Map<string, T>> {
    const uniqueIds = [...new Set(ids.map(documentId))];
    if (!uniqueIds.length) return new Map();
    const db = this.firebase.db();
    const refs = uniqueIds.map(id => db.collection(collection(table)).doc(id));
    const snapshots = await db.getAll(...refs);
    const result = new Map<string, T>();
    snapshots.forEach((snapshot, index) => {
      if (snapshot.exists) result.set(uniqueIds[index], snapshot.data() as T);
    });
    return result;
  }
  async list<T>(table: string, filters: Filters = []): Promise<T[]> {
    const read = () => this.readList<T>(table, filters);
    return table === 'products' && filters.some(([field, value]) => field === 'published' && value === 'true')
      ? this.publicProducts.read(`list:${JSON.stringify(filters)}`, read) : read();
  }
  private async readList<T>(table: string, filters: Filters): Promise<T[]> {
    let query: FirebaseFirestore.Query = this.firebase.db().collection(collection(table));
    for (const [field, value] of filters) query = query.where(field, '==', value === 'true' ? true : value);
    const result = await query.limit(100).get();
    return result.docs.map(doc => doc.data() as T);
  }
  async page<T>(table: string, filters: Filters, after: string, limit: number, options: PageOptions = {}) {
    if (after.length > 512) throw new BadRequestException('Invalid page cursor.');
    if (after && !options.order) documentId(after);
    const size = Math.min(50, Math.max(1, Math.floor(limit)));
    const read = async () => {
      let query: FirebaseFirestore.Query = this.firebase.db().collection(collection(table));
      for (const [field, value] of filters) query = query.where(field, '==', value === 'true' ? true : value);
      if (options.order) {
        query = query.orderBy(options.order.field, options.order.direction).orderBy(FieldPath.documentId(), options.order.direction);
        if (after) query = query.startAfter(...decodeCursor(after, options.order));
      } else {
        query = query.orderBy(FieldPath.documentId());
        if (after) query = query.startAfter(after);
      }
      const result = await query.limit(size + 1).get();
      const docs = result.docs.slice(0, size);
      const nextCursor = result.size <= size ? null : options.order
        ? encodeCursor(docs[size - 1].get(options.order.field), docs[size - 1].id, options.order)
        : docs[size - 1].id;
      return { items: docs.map(doc => doc.data() as T), nextCursor };
    };
    return table === 'products' && filters.some(([field, value]) => field === 'published' && value === 'true')
      ? this.publicProducts.read(`page:${JSON.stringify([filters, after, size, options])}`, read) : read();
  }
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const db = this.firebase.db();
    const changed = new Set<string>();
    const result = await db.runTransaction(native => work({
      get: async <V>(table: string, id: string) => {
        const doc = await native.get(db.collection(collection(table)).doc(documentId(id)));
        return doc.exists ? doc.data() as V : null;
      },
      set: (table, id, data) => { changed.add(table); native.set(db.collection(collection(table)).doc(documentId(id)), data); },
      delete: (table, id) => { changed.add(table); native.delete(db.collection(collection(table)).doc(documentId(id))); },
    }));
    if (changed.has('products') || changed.has('stores')) this.publicProducts.invalidate();
    return result;
  }
}
