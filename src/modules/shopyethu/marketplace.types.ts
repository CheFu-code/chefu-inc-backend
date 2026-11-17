export type Actor = { uid: string; email: string; roles: string[] };
export type ApplicationStatus = 'pending' | 'more-info' | 'approved' | 'rejected';
export type ApplicationEvent = { status: ApplicationStatus; at: string; reason?: string; response?: string };
export type SellerApplication = {
  id: string; ownerUid: string; businessName: string; contactName: string; email: string;
  phone: string; area: string; areaPlaceId?: string; plans: string; response: string; status: ApplicationStatus;
  reason: string; updatedAt: string;
  businessType?: 'individual' | 'registered-business'; categories?: string[];
  cipcCertificateId?: string; cipcCertificateFormat?: 'pdf' | 'jpg' | 'png' | 'webp';
  phoneConfirmed?: boolean; contactConfirmedAt?: string;
  collectionOffered?: boolean; collectionArea?: string; pickupHours?: string;
  createdAt?: string; history?: ApplicationEvent[];
};
export type Storefront = {
  id: string; ownerUid: string; name: string; description: string; area: string; areaPlaceId?: string;
  nameEditable?: boolean;
  status: 'active' | 'suspended'; reason: string; updatedAt: string;
};
export type Fulfilment = 'collection' | 'local-delivery';
export type Product = {
  id: string; storeId: string; ownerUid: string; name: string; description: string;
  category: string; priceCents: number; stock: number; photos: string[]; published: boolean;
  fulfilment: Fulfilment[]; updatedAt: string;
};
export type OrderStatus = 'placed' | 'accepted' | 'preparing' | 'ready' | 'dispatched' | 'completed' | 'collected' | 'cancelled';
export type OrderItem = { productId: string; name: string; quantity: number; priceCents: number; photo: string };
export type Order = {
  id: string; reference: string; buyerUid: string; storeId: string; sellerUid: string;
  items: OrderItem[]; subtotalCents: number; deliveryCents: number; totalCents: number;
  fulfilment: Fulfilment; address: string; contact: string; status: OrderStatus;
  paymentStatus: 'not-collected' | 'paid-on-collection'; paymentNote: string;
  paymentReceivedAt?: string; paymentReceivedBy?: string;
  createdAt: string; updatedAt: string;
  history: { status: OrderStatus; at: string }[];
};
export type Report = { id: string; reporterUid: string; productId?: string; orderId?: string; message: string; status: 'open'; createdAt: string };
export type Filters = [string, string][];
export interface Reader { get<T>(table: string, id: string): Promise<T | null> }
export interface BatchReader extends Reader { getMany?<T>(table: string, ids: string[]): Promise<Map<string, T>> }
export interface Transaction extends Reader { set(table: string, id: string, data: object): void; delete(table: string, id: string): void }
export interface MarketplaceRepository extends BatchReader {
  list<T>(table: string, filters?: Filters): Promise<T[]>;
  page?<T>(table: string, filters: Filters, after: string, limit: number): Promise<{ items: T[]; nextCursor: string | null }>;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
