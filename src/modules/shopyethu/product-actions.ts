import { ForbiddenException } from '@nestjs/common';
import type { Actor, MarketplaceRepository, Product, Storefront } from './marketplace.types';
import { exists, seller, text } from './marketplace.validation';

type DeletionReceipt = { id: string; storeId: string; ownerUid: string; deleted: true; deletedAt: string };

function assertOwner(product: { ownerUid: string; storeId: string }, actor: Actor, store: Storefront) {
  if (product.ownerUid !== actor.uid || product.storeId !== store.id) {
    throw new ForbiddenException('You can only manage your own products.');
  }
}

export async function moveProductToDraft(repo: MarketplaceRepository, actor: Actor, rawId: string) {
  const id = text(rawId, 'Product reference', 1, 120);
  return repo.transaction(async tx => {
    const store = await seller(tx, actor);
    const product = exists(await tx.get<Product>('products', id), 'Product');
    assertOwner(product, actor, store);
    if (!product.published) return product;
    // Update only publication; stock or edits made since the screen loaded survive.
    const updated = { ...product, published: false, updatedAt: new Date().toISOString() };
    tx.set('products', id, updated);
    return updated;
  });
}

export async function deleteProduct(repo: MarketplaceRepository, actor: Actor, rawId: string) {
  const id = text(rawId, 'Product reference', 1, 120);
  return repo.transaction(async tx => {
    const store = await seller(tx, actor);
    const product = await tx.get<Product>('products', id);
    if (!product) {
      // A lost-response retry returns the original receipt without another write.
      const receipt = exists(await tx.get<DeletionReceipt>('deleted_products', id), 'Product');
      assertOwner(receipt, actor, store);
      return receipt;
    }
    assertOwner(product, actor, store);
    const receipt: DeletionReceipt = { id, storeId: product.storeId, ownerUid: product.ownerUid,
      deleted: true, deletedAt: new Date().toISOString() };
    tx.set('deleted_products', id, receipt);
    tx.delete('products', id);
    // Order records already contain their item details. Keep their photos hosted.
    return receipt;
  });
}
