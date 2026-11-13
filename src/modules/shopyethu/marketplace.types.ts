export type Actor = { uid: string; email: string; roles: string[] };
export type ApplicationStatus = 'pending' | 'more-info' | 'approved' | 'rejected';
export type SellerApplication = {
  id: string; ownerUid: string; businessName: string; contactName: string; email: string;
  phone: string; area: string; plans: string; response: string; status: ApplicationStatus;
  reason: string; updatedAt: string;
};
export type Storefront = {
  id: string; ownerUid: string; name: string; description: string; area: string;
  status: 'active' | 'suspended'; reason: string; updatedAt: string;
};
export type Fulfilment = 'collection' | 'local-delivery';
export type Product = {
  id: string; storeId: string; ownerUid: string; name: string; description: string;
  category: string; priceCents: number; stock: number; photos: string[]; published: boolean;
  fulfilment: Fulfilment[]; updatedAt: string;
};
export type OrderStatus = 'placed' | 'accepted' | 'preparing' | 'ready' | 'dispatched' | 'completed' | 'cancelled';
export type OrderItem = { productId: string; name: string; quantity: number; priceCents: number; photo: string };
export type Order = {
  id: string; reference: string; buyerUid: string; storeId: string; sellerUid: string;
  items: OrderItem[]; subtotalCents: number; deliveryCents: number; totalCents: number;
  fulfilment: Fulfilment; address: string; contact: string; status: OrderStatus;
  paymentStatus: 'not-collected'; paymentNote: string; createdAt: string; updatedAt: string;
  history: { status: OrderStatus; at: string }[];
};
export type Report = { id: string; reporterUid: string; productId?: string; orderId?: string; message: string; status: 'open'; createdAt: string };
export type Filters = [string, string][];
export interface Reader { get<T>(table: string, id: string): Promise<T | null> }
export interface Transaction extends Reader { set(table: string, id: string, data: object): void }
export interface MarketplaceRepository extends Reader {
  list<T>(table: string, filters?: Filters): Promise<T[]>;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
export type MarketplaceConfig = { collectionEnabled: boolean };
