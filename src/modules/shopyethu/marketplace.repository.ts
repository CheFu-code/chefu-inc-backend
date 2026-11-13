import { BadRequestException, Injectable } from '@nestjs/common';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import type { Filters, MarketplaceRepository, Transaction } from './marketplace.types';

const collection = (table: string) => `shopyethu_${table}`;
function documentId(id: string) {
  if (!id || id.length > 150 || /[/\\]/.test(id) || ['.', '..'].includes(id)) throw new BadRequestException('Invalid reference.');
  return id;
}
@Injectable()
export class FirestoreMarketplaceRepository implements MarketplaceRepository {
  constructor(private readonly firebase: FirebaseAdminService) {}
  async get<T>(table: string, id: string): Promise<T | null> {
    const doc = await this.firebase.db().collection(collection(table)).doc(documentId(id)).get();
    return doc.exists ? doc.data() as T : null;
  }
  async list<T>(table: string, filters: Filters = []): Promise<T[]> {
    let query: FirebaseFirestore.Query = this.firebase.db().collection(collection(table));
    for (const [field, value] of filters) query = query.where(field, '==', value === 'true' ? true : value);
    const result = await query.limit(100).get();
    return result.docs.map(doc => doc.data() as T);
  }
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const db = this.firebase.db();
    return db.runTransaction(native => work({
      get: async <V>(table: string, id: string) => {
        const doc = await native.get(db.collection(collection(table)).doc(documentId(id)));
        return doc.exists ? doc.data() as V : null;
      },
      set: (table, id, data) => { native.set(db.collection(collection(table)).doc(documentId(id)), data); },
    }));
  }
}
