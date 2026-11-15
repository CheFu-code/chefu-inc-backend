import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Actor, Fulfilment, MarketplaceRepository, Product, Storefront } from './marketplace.types';
import { exists, integer, photos, seller, text } from './marketplace.validation';

export class CatalogService {
  constructor(private readonly repo: MarketplaceRepository) {}
  async page(query = '', category = '', storeId = '', after = '') {
    const filters: [string, string][] = [['published', 'true']];
    if (category) filters.push(['category', category]);
    if (storeId) filters.push(['storeId', storeId]);
    const page = this.repo.page ? await this.repo.page<Product>('products', filters, after, 24)
      : { items: await this.repo.list<Product>('products', filters), nextCursor: null };
    // Read only stores referenced by this page, without caching permissions/visibility.
    const stores = new Map((await Promise.all([...new Set(page.items.map(item => item.storeId))]
      .map(async id => [id, await this.repo.get<Storefront>('stores', id)] as const))));
    return { products: page.items.filter(product => product.published && stores.get(product.storeId)?.status === 'active' &&
      `${product.name} ${product.description}`.toLowerCase().includes(query.toLowerCase()))
      .map(product => ({ ...product, storeName: stores.get(product.storeId)!.name })), nextCursor: page.nextCursor };
  }
  async browse(query = '', category = '', storeId = '') {
    const filters: [string, string][] = [['published', 'true']];
    if (storeId) filters.push(['storeId', storeId]);
    if (category) filters.push(['category', category]);
    const products = await this.repo.list<Product>('products', filters);
    const stores = new Map(await Promise.all([...new Set(products.map(item => item.storeId))]
      .map(async id => [id, await this.repo.get<Storefront>('stores', id)] as const)));
    return products.filter(product => product.published && stores.get(product.storeId)?.status === 'active' &&
      `${product.name} ${product.description}`.toLowerCase().includes(query.toLowerCase()))
      .map(product => ({ ...product, storeName: stores.get(product.storeId)!.name }));
  }
  async product(productId: string) {
    const product = exists(await this.repo.get<Product>('products', productId), 'Product');
    const store = exists(await this.repo.get<Storefront>('stores', product.storeId), 'Store');
    if (!product.published || store.status !== 'active') throw new BadRequestException('This listing is no longer available.');
    return { product, store };
  }
  async storefront(storeId: string, paginated = false) {
    const store = exists(await this.repo.get<Storefront>('stores', storeId), 'Store');
    if (store.status !== 'active') throw new BadRequestException('This store is currently unavailable.');
    return paginated ? { store, ...await this.page('', '', storeId) } : { store, products: await this.browse('', '', storeId) };
  }
  async mine(actor: Actor) {
    const store = await seller(this.repo, actor);
    return { store, products: await this.repo.list<Product>('products', [['ownerUid', actor.uid]]) };
  }
  async ownProduct(actor: Actor, productId: string) {
    const store = await seller(this.repo, actor);
    const product = exists(await this.repo.get<Product>('products', productId), 'Product');
    if (product.ownerUid !== actor.uid || product.storeId !== store.id) throw new ForbiddenException('You can only edit your own products.');
    return { store, product };
  }
  async saveStore(actor: Actor, body: Record<string, unknown>) {
    return this.repo.transaction(async tx => {
      const current = await seller(tx, actor);
      const updated = { ...current, name: text(body.name, 'Store name', 2, 100), description: text(body.description, 'Store description', 10, 2000), area: text(body.area, 'Operating area', 2, 120), updatedAt: new Date().toISOString() };
      tx.set('stores', actor.uid, updated); return updated;
    });
  }
  async saveProduct(actor: Actor, body: Record<string, unknown>, productId?: string, rawKey?: unknown) {
    const updating = !!productId;
    const targetId = productId || randomUUID();
    const key = rawKey === undefined ? null : text(rawKey, 'Save attempt key', 16, 120);
    const reservation = key ? createHash('sha256').update(`product:${actor.uid}:${key}`).digest('hex') : null;
    if (typeof body.published !== 'boolean') throw new BadRequestException('Choose draft or published.');
    const fulfilment = body.fulfilment;
    if (!Array.isArray(fulfilment) || fulfilment.length === 0 || fulfilment.some(value => !['collection', 'local-delivery'].includes(value))) throw new BadRequestException('Choose at least one valid fulfilment option.');
    const fields = {
      name: text(body.name, 'Product name', 2, 120), description: text(body.description, 'Description', 10, 4000),
      category: text(body.category, 'Category', 2, 60), priceCents: integer(body.priceCents, 'Price in cents', 100, 100000000),
      stock: integer(body.stock, 'Stock', 0, 100000), photos: photos(body.photos), fulfilment: [...new Set(fulfilment)] as Fulfilment[], published: body.published,
    };
    if (fields.published && !fields.photos.length) throw new BadRequestException('Add a product photo before publishing.');
    const signature = createHash('sha256').update(JSON.stringify({ fields, productId: productId || null, expectedUpdatedAt: body.expectedUpdatedAt ?? null, expectedStock: body.expectedStock ?? null })).digest('hex');
    return this.repo.transaction(async tx => {
      await seller(tx, actor);
      const previous = reservation ? await tx.get<{ signature: string; productId: string }>('idempotency', reservation) : null;
      if (previous) {
        if (previous.signature !== signature) throw new ConflictException('This save attempt was already used for different product details.');
        const saved = exists(await tx.get<Product>('products', previous.productId), 'Product');
        if (saved.ownerUid !== actor.uid) throw new ForbiddenException('You can only edit your own products.');
        return saved;
      }
      const current = await tx.get<Product>('products', targetId);
      if (current && current.ownerUid !== actor.uid) throw new ForbiddenException('You can only edit your own products.');
      if (updating) exists(current, 'Product');
      // Legacy clients can still save; new editors provide their starting version and stock.
      if (current && (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== current.updatedAt ||
        body.expectedStock !== undefined && body.expectedStock !== current.stock)) {
        throw new ConflictException('This product or its stock changed. Reload the latest details before saving.');
      }
      const product: Product = { ...fields, id: targetId, ownerUid: actor.uid, storeId: actor.uid, updatedAt: new Date().toISOString() };
      tx.set('products', targetId, product);
      if (reservation) tx.set('idempotency', reservation, { productId: targetId, signature });
      return product;
    });
  }
}
