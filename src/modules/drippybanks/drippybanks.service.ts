import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { v2 as cloudinary, UploadApiOptions } from 'cloudinary';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  CreateProductInput,
  DrippyProductDocument,
  UpdateProductInput,
  UploadImageInput,
} from './drippybanks.types';

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class DrippybanksService {
  private readonly logger = new Logger(DrippybanksService.name);
  private readonly collectionName = 'drippybanksProducts';

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  async listProducts(): Promise<{ products: DrippyProductDocument[] }> {
    const db = this.firebaseAdmin.db();
    const snapshot = await db.collection(this.collectionName).get();

    if (snapshot.empty) {
      return { products: [] };
    }

    const products = snapshot.docs.map(doc =>
      this.serializeProduct(doc.id, doc.data()),
    );
    return { products: this.sortProducts(products) };
  }

  async getProductById(id: string): Promise<DrippyProductDocument> {
    if (!id || typeof id !== 'string') {
      throw new BadRequestException('Product ID is required.');
    }

    const doc = await this.firebaseAdmin
      .db()
      .collection(this.collectionName)
      .doc(id)
      .get();

    if (!doc.exists) {
      throw new NotFoundException(`Product with ID "${id}" was not found.`);
    }

    return this.serializeProduct(doc.id, doc.data() || {});
  }

  async createProduct(
    user: AuthenticatedUser,
    input: CreateProductInput,
  ): Promise<DrippyProductDocument> {
    const validated = this.validateProductInput(input);
    const id = `prod_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const productDoc: DrippyProductDocument = {
      ...validated,
      id,
      createdAt: now,
      updatedAt: now,
      createdBy: user.email,
    };

    await this.firebaseAdmin
      .db()
      .collection(this.collectionName)
      .doc(id)
      .set(productDoc);

    this.logger.log(
      JSON.stringify({
        event: 'drippybanks_product_created',
        productId: id,
        name: productDoc.name,
        admin: user.email,
      }),
    );

    return productDoc;
  }

  async updateProduct(
    user: AuthenticatedUser,
    id: string,
    input: UpdateProductInput,
  ): Promise<DrippyProductDocument> {
    if (!id || typeof id !== 'string') {
      throw new BadRequestException('Product ID is required.');
    }

    const existing = await this.getProductById(id);
    const validated = this.validatePartialProductInput(input);
    const now = new Date().toISOString();

    const updatedDoc: DrippyProductDocument = {
      ...existing,
      ...validated,
      id,
      updatedAt: now,
    };

    await this.firebaseAdmin
      .db()
      .collection(this.collectionName)
      .doc(id)
      .set(updatedDoc, { merge: true });

    this.logger.log(
      JSON.stringify({
        event: 'drippybanks_product_updated',
        productId: id,
        admin: user.email,
      }),
    );

    return updatedDoc;
  }

  async deleteProduct(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ success: boolean; id: string }> {
    if (!id || typeof id !== 'string') {
      throw new BadRequestException('Product ID is required.');
    }

    const product = await this.getProductById(id);

    // If product image is hosted on Cloudinary, delete it from the media library
    if (product.image && product.image.includes('res.cloudinary.com')) {
      await this.deleteCloudinaryImage(product.image);
    }

    await this.firebaseAdmin.db().collection(this.collectionName).doc(id).delete();

    this.logger.log(
      JSON.stringify({
        event: 'drippybanks_product_deleted',
        productId: id,
        admin: user.email,
      }),
    );

    return { success: true, id };
  }

  async toggleStock(
    user: AuthenticatedUser,
    id: string,
  ): Promise<DrippyProductDocument> {
    const existing = await this.getProductById(id);
    const newStatus = !existing.inStock;

    await this.firebaseAdmin
      .db()
      .collection(this.collectionName)
      .doc(id)
      .update({
        inStock: newStatus,
        updatedAt: new Date().toISOString(),
      });

    this.logger.log(
      JSON.stringify({
        event: 'drippybanks_product_stock_toggled',
        productId: id,
        inStock: newStatus,
        admin: user.email,
      }),
    );

    return {
      ...existing,
      inStock: newStatus,
      updatedAt: new Date().toISOString(),
    };
  }

  async uploadImage(
    user: AuthenticatedUser,
    input: UploadImageInput,
  ): Promise<{ url: string; path: string }> {
    if (!input || !input.imageBase64) {
      throw new BadRequestException('Image data (imageBase64) is required.');
    }

    const parsed = this.parseImageBody(input.imageBase64, input.contentType);
    const buffer = Buffer.from(parsed.base64, 'base64');

    if (!buffer.length) {
      throw new BadRequestException('Uploaded image is empty.');
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Image exceeds the maximum allowed size of 5 MB.');
    }

    const publicId = `drippybanks/products/${Date.now()}_${randomUUID()}`;

    const result = await this.uploadBufferToCloudinary(buffer, {
      public_id: publicId,
      resource_type: 'image',
      folder: undefined, // already encoded in publicId
      overwrite: false,
      tags: ['drippybanks', 'product', user.email],
    });

    this.logger.log(
      JSON.stringify({
        event: 'drippybanks_image_uploaded',
        publicId: result.public_id,
        admin: user.email,
      }),
    );

    return {
      url: result.secure_url,
      path: result.public_id,
    };
  }

  private parseImageBody(rawInput: string, explicitContentType?: string) {
    const dataUriMatch = rawInput.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    const contentType = String(
      dataUriMatch?.[1] || explicitContentType || 'image/jpeg',
    ).toLowerCase();
    const base64 = dataUriMatch ? dataUriMatch[2] : rawInput;

    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new BadRequestException(
        'Unsupported image type. Please upload PNG, JPG, or WEBP.',
      );
    }

    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
      throw new BadRequestException('Image payload must be a valid base64 string.');
    }

    return {
      base64,
      contentType: contentType === 'image/jpg' ? 'image/jpeg' : contentType,
    };
  }

  private resolveExtension(contentType: string): string {
    if (contentType === 'image/png') return 'png';
    if (contentType === 'image/webp') return 'webp';
    return 'jpg';
  }

  /**
   * Uploads a Buffer to Cloudinary using upload_stream (no temp file needed).
   */
  private uploadBufferToCloudinary(
    buffer: Buffer,
    options: UploadApiOptions,
  ): Promise<{ secure_url: string; public_id: string }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        options,
        (error, result) => {
          if (error) return reject(new Error(error.message));
          if (!result) return reject(new Error('Cloudinary returned no result.'));
          resolve({ secure_url: result.secure_url, public_id: result.public_id });
        },
      );
      Readable.from(buffer).pipe(stream);
    });
  }

  /**
   * Deletes a Cloudinary asset given its public URL.
   * Extracts the public_id from the URL path (everything after /upload/[version]/,
   * minus the file extension).
   */
  private async deleteCloudinaryImage(url: string): Promise<void> {
    try {
      // e.g. https://res.cloudinary.com/<cloud>/image/upload/v123/drippybanks/products/xyz.jpg
      const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/);
      const publicId = match?.[1] ?? null;
      if (publicId) {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
      }
    } catch (err) {
      this.logger.warn(`Could not delete Cloudinary image: ${url}`, err);
    }
  }

  private validateProductInput(
    input: CreateProductInput,
  ): Omit<DrippyProductDocument, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('Request body must be an object.');
    }

    const name = String(input.name || '').trim();
    if (!name) {
      throw new BadRequestException('Product name is required.');
    }

    const category = String(input.category || '').trim();
    if (!category) {
      throw new BadRequestException('Product category is required.');
    }

    const price = typeof input.price === 'number' ? input.price : Number(input.price);
    if (isNaN(price) || price < 0) {
      throw new BadRequestException('Price must be a valid non-negative number.');
    }

    const image = String(input.image || '').trim();
    if (!image) {
      throw new BadRequestException('Product image URL is required.');
    }

    const originalPrice =
      input.originalPrice !== undefined && input.originalPrice !== null
        ? Number(input.originalPrice)
        : undefined;

    const sizes = Array.isArray(input.sizes) && input.sizes.length > 0
      ? input.sizes.map(s => String(s).trim()).filter(Boolean)
      : ['One Size'];

    const colors = Array.isArray(input.colors) && input.colors.length > 0
      ? input.colors.map(c => String(c).trim()).filter(Boolean)
      : ['Standard'];

    const badge = input.badge ? String(input.badge).trim() : undefined;
    const description = input.description ? String(input.description).trim() : undefined;
    const fit = input.fit ? String(input.fit).trim() : undefined;
    const inStock = input.inStock !== false;
    const stock = typeof input.stock === 'number' ? input.stock : Number(input.stock || 50);
    const featured = Boolean(input.featured);

    return {
      name,
      category,
      price,
      originalPrice: originalPrice && originalPrice > 0 ? originalPrice : undefined,
      image,
      sizes,
      colors,
      badge: badge || undefined,
      description: description || undefined,
      fit: fit || undefined,
      inStock,
      stock: isNaN(stock) ? 50 : stock,
      featured,
    };
  }

  private validatePartialProductInput(
    input: UpdateProductInput,
  ): Partial<Omit<DrippyProductDocument, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>> {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('Request body must be an object.');
    }

    const update: Partial<DrippyProductDocument> = {};

    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new BadRequestException('Product name cannot be empty.');
      update.name = name;
    }

    if (input.category !== undefined) {
      const category = String(input.category).trim();
      if (!category) throw new BadRequestException('Category cannot be empty.');
      update.category = category;
    }

    if (input.price !== undefined) {
      const price = Number(input.price);
      if (isNaN(price) || price < 0) {
        throw new BadRequestException('Price must be a non-negative number.');
      }
      update.price = price;
    }

    if (input.originalPrice !== undefined) {
      const originalPrice = input.originalPrice ? Number(input.originalPrice) : undefined;
      update.originalPrice = originalPrice && originalPrice > 0 ? originalPrice : undefined;
    }

    if (input.image !== undefined) {
      const image = String(input.image).trim();
      if (!image) throw new BadRequestException('Product image cannot be empty.');
      update.image = image;
    }

    if (input.sizes !== undefined) {
      update.sizes = Array.isArray(input.sizes)
        ? input.sizes.map(s => String(s).trim()).filter(Boolean)
        : ['One Size'];
    }

    if (input.colors !== undefined) {
      update.colors = Array.isArray(input.colors)
        ? input.colors.map(c => String(c).trim()).filter(Boolean)
        : ['Standard'];
    }

    if (input.badge !== undefined) {
      update.badge = input.badge ? String(input.badge).trim() : undefined;
    }

    if (input.description !== undefined) {
      update.description = input.description ? String(input.description).trim() : undefined;
    }

    if (input.fit !== undefined) {
      update.fit = input.fit ? String(input.fit).trim() : undefined;
    }

    if (input.inStock !== undefined) {
      update.inStock = Boolean(input.inStock);
    }

    if (input.stock !== undefined) {
      const stock = Number(input.stock);
      update.stock = isNaN(stock) ? 0 : stock;
    }

    if (input.featured !== undefined) {
      update.featured = Boolean(input.featured);
    }

    return update;
  }

  private serializeProduct(id: string, data: Record<string, unknown>): DrippyProductDocument {
    return {
      id: String(data.id || id),
      name: String(data.name || 'Untitled Piece'),
      price: typeof data.price === 'number' ? data.price : Number(data.price || 0),
      originalPrice:
        typeof data.originalPrice === 'number'
          ? data.originalPrice
          : data.originalPrice
            ? Number(data.originalPrice)
            : undefined,
      category: String(data.category || 'Tops'),
      image: String(data.image || '/placeholder.png'),
      sizes: Array.isArray(data.sizes) ? data.sizes.map(String) : ['One Size'],
      colors: Array.isArray(data.colors) ? data.colors.map(String) : ['Midnight Black'],
      badge: data.badge ? String(data.badge) : undefined,
      description: data.description ? String(data.description) : undefined,
      fit: data.fit ? String(data.fit) : undefined,
      inStock: data.inStock !== false,
      stock: typeof data.stock === 'number' ? data.stock : Number(data.stock || 50),
      featured: Boolean(data.featured),
      createdAt: data.createdAt ? String(data.createdAt) : new Date().toISOString(),
      updatedAt: data.updatedAt ? String(data.updatedAt) : undefined,
      createdBy: data.createdBy ? String(data.createdBy) : undefined,
    };
  }

  private sortProducts(products: DrippyProductDocument[]): DrippyProductDocument[] {
    return products.sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
    );
  }
}
