import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { UploadApiOptions, v2 as cloudinary } from 'cloudinary';
import { assertCloudinaryConfigured } from '../../common/env';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  PRODUCT_STATUSES,
  InventoryInput,
  ProductDocument,
  ProductInput,
  ProductStatus,
  UploadImageInput,
} from './products.types';

const COLLECTION = 'products';
const AUDIT_COLLECTION = 'commerceAuditLogs';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  async listPublicProducts() {
    const snapshot = await this.firebaseAdmin.db().collection(COLLECTION)
      .where('status', 'in', ['ACTIVE', 'OUT_OF_STOCK'])
      .orderBy('featured', 'desc').orderBy('updatedAt', 'desc').get();
    return { products: snapshot.docs.map(doc => this.serialize(doc.id, doc.data())) };
  }

  async listAdminProducts() {
    const snapshot = await this.firebaseAdmin.db().collection(COLLECTION).orderBy('updatedAt', 'desc').get();
    return { products: snapshot.docs.map(doc => this.serialize(doc.id, doc.data())) };
  }

  async getProductBySlug(slug: string, includeArchived: boolean) {
    if (!slug?.trim()) throw new BadRequestException('Product slug is required.');
    const snapshot = await this.firebaseAdmin.db().collection(COLLECTION).where('slug', '==', slug.trim()).limit(1).get();
    if (snapshot.empty) throw new NotFoundException('Product was not found.');
    const product = this.serialize(snapshot.docs[0].id, snapshot.docs[0].data());
    if (!includeArchived && !['ACTIVE', 'OUT_OF_STOCK'].includes(product.status)) throw new NotFoundException('Product was not found.');
    return product;
  }

  async create(user: AuthenticatedUser, input: ProductInput) {
    const product = this.validate(input, true);
    const db = this.firebaseAdmin.db();
    const duplicate = await db.collection(COLLECTION).where('sku', '==', product.sku).limit(1).get();
    if (!duplicate.empty) throw new ConflictException('SKU is already in use.');
    const id = `prod_${randomUUID()}`;
    const now = new Date().toISOString();
    const document = { ...product, id, createdAt: now, updatedAt: now, createdBy: user.email } as ProductDocument;
    await db.collection(COLLECTION).doc(id).create(document);
    await this.audit(user, 'PRODUCT_CREATED', id, { after: document });
    return document;
  }

  async update(user: AuthenticatedUser, id: string, input: ProductInput) {
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const existingSnapshot = await ref.get();
    if (!existingSnapshot.exists) throw new NotFoundException('Product was not found.');
    const existing = this.serialize(id, existingSnapshot.data() || {});
    const validated = this.validate({ ...existing, ...input }, false);
    if (validated.sku !== existing.sku) {
      const duplicate = await this.firebaseAdmin.db().collection(COLLECTION).where('sku', '==', validated.sku).limit(2).get();
      if (duplicate.docs.some(doc => doc.id !== id)) throw new ConflictException('SKU is already in use.');
    }
    const updated = { ...existing, ...validated, id, updatedAt: new Date().toISOString() } as ProductDocument;
    await ref.set(updated);
    await this.audit(user, existing.priceMinor !== updated.priceMinor ? 'PRICE_CHANGED' : 'PRODUCT_UPDATED', id, { before: existing, after: updated });
    return updated;
  }

  async archive(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Product was not found.');
    await ref.update({ status: 'ARCHIVED', updatedAt: new Date().toISOString() });
    await this.audit(user, 'PRODUCT_ARCHIVED', id, { beforeStatus: snapshot.data()?.status, afterStatus: 'ARCHIVED' });
    return { success: true, id, status: 'ARCHIVED' as const };
  }

  async adjustInventory(user: AuthenticatedUser, id: string, input: InventoryInput) {
    const mode = input?.mode === 'set' ? 'set' : 'adjust';
    const value = Number(mode === 'set' ? input.quantity : input.adjustment);
    if (!Number.isInteger(value) || value < 0 && mode === 'set') throw new BadRequestException('Inventory must be a non-negative integer.');
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const result = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new NotFoundException('Product was not found.');
      const current = Number(snapshot.data()?.inventoryQuantity || 0);
      const quantity = mode === 'set' ? value : current + value;
      if (!Number.isInteger(quantity) || quantity < 0) throw new BadRequestException('Inventory cannot become negative.');
      const status: ProductStatus = quantity === 0 ? 'OUT_OF_STOCK' : snapshot.data()?.status === 'OUT_OF_STOCK' ? 'ACTIVE' : snapshot.data()?.status;
      transaction.update(ref, { inventoryQuantity: quantity, status, updatedAt: new Date().toISOString() });
      return { quantity, status, previousQuantity: current };
    });
    await this.audit(user, 'INVENTORY_CHANGED', id, result);
    return { id, inventoryQuantity: result.quantity, status: result.status };
  }

  async uploadImage(user: AuthenticatedUser, input: UploadImageInput) {
    assertCloudinaryConfigured();
    const raw = String(input?.imageBase64 || '');
    const match = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    const contentType = String(match?.[1] || input?.contentType || 'image/jpeg').toLowerCase();
    const base64 = match?.[2] || raw;
    if (!IMAGE_TYPES.has(contentType) || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) throw new BadRequestException('Upload a valid PNG, JPG, or WEBP image.');
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new BadRequestException('Image must be between 1 byte and 5 MB.');
    const result = await this.uploadBuffer(buffer, { public_id: `chefu/products/${randomUUID()}`, resource_type: 'image', overwrite: false, tags: ['chefu', 'product', user.email] });
    return { url: result.secure_url, publicId: result.public_id, alt: String(input?.alt || '').trim() };
  }

  private validate(input: ProductInput, creating: boolean) {
    if (!input || typeof input !== 'object') throw new BadRequestException('Request body must be an object.');
    const name = String(input.name || '').trim();
    const slug = String(input.slug || this.slugify(name)).trim();
    const sku = String(input.sku || '').trim().toUpperCase();
    const priceMinor = Number(input.priceMinor);
    const inventoryQuantity = Number(input.inventoryQuantity ?? 0);
    const lowStockThreshold = Number(input.lowStockThreshold ?? 5);
    if (!name || !slug || !sku) throw new BadRequestException('Name, slug, and SKU are required.');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new BadRequestException('Slug must contain lowercase letters, numbers, and hyphens only.');
    if (!Number.isInteger(priceMinor) || priceMinor < 0) throw new BadRequestException('Price must be a non-negative integer in minor units.');
    if (!Number.isInteger(inventoryQuantity) || inventoryQuantity < 0 || !Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) throw new BadRequestException('Inventory values must be non-negative integers.');
    const status = String(input.status || (inventoryQuantity === 0 ? 'OUT_OF_STOCK' : 'DRAFT')) as ProductStatus;
    if (!PRODUCT_STATUSES.includes(status)) throw new BadRequestException('Invalid product status.');
    if (creating && status === 'ACTIVE' && inventoryQuantity === 0) throw new BadRequestException('An active product must have inventory or use OUT_OF_STOCK.');
    return {
      name, slug, sku, priceMinor, currency: 'ZAR' as const,
      shortDescription: String(input.shortDescription || '').trim(), description: String(input.description || '').trim(),
      compareAtPriceMinor: input.compareAtPriceMinor === undefined ? undefined : Number(input.compareAtPriceMinor),
      category: String(input.category || '').trim(), images: Array.isArray(input.images) ? input.images : [], thumbnail: input.thumbnail ? String(input.thumbnail) : undefined,
      inventoryQuantity, lowStockThreshold, status, featured: Boolean(input.featured), variants: Array.isArray(input.variants) ? input.variants : [], tags: Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean) : [], metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata as Record<string, string> : {},
      weightGrams: input.weightGrams === undefined ? undefined : Number(input.weightGrams), dimensions: input.dimensions, shippingInformation: input.shippingInformation ? String(input.shippingInformation) : undefined,
      productType: 'PHYSICAL' as const, stockTracking: input.stockTracking !== false, seoTitle: input.seoTitle ? String(input.seoTitle) : undefined, seoDescription: input.seoDescription ? String(input.seoDescription) : undefined,
    };
  }

  private serialize(id: string, data: FirebaseFirestore.DocumentData): ProductDocument {
    return { ...(data as ProductDocument), id, variants: Array.isArray(data.variants) ? data.variants : [], images: Array.isArray(data.images) ? data.images : [], tags: Array.isArray(data.tags) ? data.tags : [], metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {} };
  }

  private async audit(user: AuthenticatedUser, action: string, productId: string, details: Record<string, unknown>) {
    await this.firebaseAdmin.db().collection(AUDIT_COLLECTION).add({ actorUid: user.uid, actorEmail: user.email, action, productId, details, createdAt: FieldValue.serverTimestamp() });
  }

  private slugify(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  private uploadBuffer(buffer: Buffer, options: UploadApiOptions): Promise<{ secure_url: string; public_id: string }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
        if (error) return reject(new BadRequestException('Image upload failed.'));
        if (!result?.secure_url || !result.public_id) return reject(new BadRequestException('Image upload returned no asset.'));
        resolve({ secure_url: result.secure_url, public_id: result.public_id });
      });
      Readable.from(buffer).pipe(stream);
    });
  }
}