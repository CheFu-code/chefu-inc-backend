import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Actor, MarketplaceRepository, Order, Product, ProductReview, Storefront } from './marketplace.types';
import { exists, integer, text } from './marketplace.validation';

const reviewId = (orderId: string, productId: string) =>
  createHash('sha256').update(`${orderId}:${productId}`).digest('hex');
const canReview = (status: Order['status']) => status === 'completed' || status === 'collected';

export class ReviewsService {
  constructor(private readonly repo: MarketplaceRepository) {}

  async list(productId: string, after = '') {
    if (after.length > 512) throw new BadRequestException('Invalid review cursor.');
    const product = exists(await this.repo.get<Product>('products', text(productId, 'Product', 1, 120)), 'Product');
    const store = exists(await this.repo.get<Storefront>('stores', product.storeId), 'Store');
    if (!product.published || store.status !== 'active' || store.sellerPaused) {
      throw new BadRequestException('Reviews are unavailable for this listing.');
    }
    const page = this.repo.page
      ? await this.repo.page<ProductReview>('reviews', [['productId', product.id]], after, 5, {
        order: { field: 'createdAt', direction: 'desc' },
      })
      : { items: (await this.repo.list<ProductReview>('reviews', [['productId', product.id]]))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 5), nextCursor: null };
    const reviewCount = Number.isSafeInteger(product.reviewCount) && (product.reviewCount || 0) > 0
      ? product.reviewCount! : 0;
    const ratingTotal = Number.isSafeInteger(product.ratingTotal) && (product.ratingTotal || 0) > 0
      ? product.ratingTotal! : 0;
    return {
      reviewCount,
      averageRating: reviewCount ? Math.round((ratingTotal / reviewCount) * 10) / 10 : null,
      reviews: page.items.map(({ id, rating, comment, createdAt }) => ({
        id, rating, comment, createdAt, verifiedPurchase: true,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async reviewedProducts(actor: Actor, orderId: string) {
    const order = exists(await this.repo.get<Order>('orders', text(orderId, 'Order', 1, 150)), 'Order');
    if (order.buyerUid !== actor.uid) throw new ForbiddenException('This order belongs to another buyer.');
    if (!canReview(order.status)) return { reviewedProductIds: [] };
    const items = [...new Set(order.items.map(item => item.productId))];
    const ids = items.map(productId => reviewId(order.id, productId));
    const reviews = this.repo.getMany
      ? await this.repo.getMany<ProductReview>('reviews', ids)
      : new Map((await Promise.all(ids.map(async id => [id, await this.repo.get<ProductReview>('reviews', id)] as const)))
        .filter((entry): entry is readonly [string, ProductReview] => entry[1] !== null));
    return {
      reviewedProductIds: items.filter((productId, index) => reviews.has(ids[index])),
    };
  }

  async create(actor: Actor, productId: string, body: Record<string, unknown>) {
    const orderId = text(body.orderId, 'Order', 1, 150);
    const rating = integer(body.rating, 'Rating', 1, 5);
    if (body.comment !== undefined && typeof body.comment !== 'string') {
      throw new BadRequestException('Review must be text.');
    }
    const commentValue = typeof body.comment === 'string' ? body.comment.trim() : '';
    const comment = commentValue ? text(commentValue, 'Review', 1, 500) : '';
    const targetProductId = text(productId, 'Product', 1, 120);
    const id = reviewId(orderId, targetProductId);
    return this.repo.transaction(async tx => {
      const order = exists(await tx.get<Order>('orders', orderId), 'Order');
      if (order.buyerUid !== actor.uid) throw new ForbiddenException('This order belongs to another buyer.');
      if (!canReview(order.status)) throw new ConflictException('You can review this item after the order is completed or collected.');
      if (!order.items.some(item => item.productId === targetProductId)) {
        throw new BadRequestException('This product was not included in the order.');
      }
      const product = exists(await tx.get<Product>('products', targetProductId), 'Product');
      if (product.storeId !== order.storeId) throw new ConflictException('The ordered product no longer matches this listing.');
      if (await tx.get<ProductReview>('reviews', id)) {
        throw new ConflictException('You have already reviewed this product for that order.');
      }
      const review: ProductReview = {
        id: randomUUID(), productId: targetProductId, orderId: order.id, buyerUid: actor.uid,
        rating, comment, verifiedPurchase: true, createdAt: new Date().toISOString(),
      };
      tx.set('reviews', id, review);
      tx.set('products', product.id, {
        ...product,
        reviewCount: (Number.isSafeInteger(product.reviewCount) ? product.reviewCount || 0 : 0) + 1,
        ratingTotal: (Number.isSafeInteger(product.ratingTotal) ? product.ratingTotal || 0 : 0) + rating,
      });
      return {
        id: review.id, productId: review.productId, rating: review.rating,
        comment: review.comment, createdAt: review.createdAt, verifiedPurchase: true,
      };
    });
  }
}
