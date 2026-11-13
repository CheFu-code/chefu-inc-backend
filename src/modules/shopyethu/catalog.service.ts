import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Actor, Fulfilment, MarketplaceRepository, Product, Storefront } from './marketplace.types';
import { exists, integer, photos, seller, text } from './marketplace.validation';

export class CatalogService {
  constructor(private readonly repo: MarketplaceRepository) {}
  async browse(query = '', category = '', storeId = '') {
    const stores = await this.repo.list<Storefront>('stores', [['status', 'active']]);
    const active = new Set(stores.map(store => store.id));
    const products = await this.repo.list<Product>('products', storeId ? [['storeId', storeId]] : [['published', 'true']]);
    return products.filter(product => product.published && active.has(product.storeId) &&
      (!category || product.category === category) && `${product.name} ${product.description}`.toLowerCase().includes(query.toLowerCase())).map(product => ({ ...product, storeName: stores.find(store => store.id === product.storeId)?.name || 'Local store' }));
  }
  async product(productId: string) {
    const product = exists(await this.repo.get<Product>('products', productId), 'Product');
    const store = exists(await this.repo.get<Storefront>('stores', product.storeId), 'Store');
    if (!product.published || store.status !== 'active') throw new BadRequestException('This listing is no longer available.');
    return { product, store };
  }
  async storefront(storeId: string) {
    const store = exists(await this.repo.get<Storefront>('stores', storeId), 'Store');
    if (store.status !== 'active') throw new BadRequestException('This store is currently unavailable.');
    return { store, products: await this.browse('', '', storeId) };
  }
  async mine(actor: Actor) {
    const store = await seller(this.repo, actor);
    return { store, products: await this.repo.list<Product>('products', [['ownerUid', actor.uid]]) };
  }
  async saveStore(actor: Actor, body: Record<string, unknown>) {
    return this.repo.transaction(async tx => {
      const current = await seller(tx, actor);
      const updated = { ...current, name: text(body.name, 'Store name', 2, 100), description: text(body.description, 'Store description', 10, 2000), area: text(body.area, 'Operating area', 2, 120), updatedAt: new Date().toISOString() };
      tx.set('stores', actor.uid, updated); return updated;
    });
  }
  async saveProduct(actor: Actor, body: Record<string, unknown>, productId: string = randomUUID()) {
    if (typeof body.published !== 'boolean') throw new BadRequestException('Choose draft or published.');
    const fulfilment = body.fulfilment;
    if (!Array.isArray(fulfilment) || fulfilment.length === 0 || fulfilment.some(value => !['collection', 'local-delivery'].includes(value))) throw new BadRequestException('Choose at least one valid fulfilment option.');
    const fields = {
      name: text(body.name, 'Product name', 2, 120), description: text(body.description, 'Description', 10, 4000),
      category: text(body.category, 'Category', 2, 60), priceCents: integer(body.priceCents, 'Price in cents', 100, 100000000),
      stock: integer(body.stock, 'Stock', 0, 100000), photos: photos(body.photos), fulfilment: [...new Set(fulfilment)] as Fulfilment[], published: body.published,
    };
    if (fields.published && !fields.photos.length) throw new BadRequestException('Add a product photo before publishing.');
    return this.repo.transaction(async tx => {
      await seller(tx, actor);
      const current = await tx.get<Product>('products', productId);
      if (current && current.ownerUid !== actor.uid) throw new ForbiddenException('You can only edit your own products.');
      const product: Product = { ...fields, id: productId, ownerUid: actor.uid, storeId: actor.uid, updatedAt: new Date().toISOString() };
      tx.set('products', productId, product); return product;
    });
  }
}
