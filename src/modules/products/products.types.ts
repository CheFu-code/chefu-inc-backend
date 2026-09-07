export const PRODUCT_STATUSES = [
  'ACTIVE',
  'DRAFT',
  'ARCHIVED',
  'OUT_OF_STOCK',
] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export type ProductVariant = {
  id: string;
  name: string;
  sku: string;
  priceMinor: number;
  compareAtPriceMinor?: number;
  inventoryQuantity: number;
  options: Record<string, string>;
};

export type ProductImage = {
  url: string;
  publicId?: string;
  alt: string;
  sortOrder: number;
};

export type ProductDocument = {
  id: string;
  name: string;
  slug: string;
  shortDescription: string;
  description: string;
  priceMinor: number;
  compareAtPriceMinor?: number;
  currency: 'ZAR';
  category: string;
  sku: string;
  images: ProductImage[];
  thumbnail?: string;
  inventoryQuantity: number;
  lowStockThreshold: number;
  status: ProductStatus;
  featured: boolean;
  variants: ProductVariant[];
  tags: string[];
  metadata: Record<string, string>;
  weightGrams?: number;
  dimensions?: { lengthMm: number; widthMm: number; heightMm: number };
  shippingInformation?: string;
  productType: 'PHYSICAL';
  stockTracking: boolean;
  seoTitle?: string;
  seoDescription?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type ProductInput = Partial<Omit<ProductDocument, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>> & {
  name?: unknown;
  slug?: unknown;
  priceMinor?: unknown;
  inventoryQuantity?: unknown;
  lowStockThreshold?: unknown;
};

export type InventoryInput = {
  adjustment?: unknown;
  quantity?: unknown;
  mode?: unknown;
};

export type UploadImageInput = {
  imageBase64?: unknown;
  contentType?: unknown;
  alt?: unknown;
};