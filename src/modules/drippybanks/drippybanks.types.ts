export interface DrippyProductDocument {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  category: string;
  image: string;
  sizes: string[];
  colors: string[];
  badge?: string;
  description?: string;
  fit?: string;
  inStock: boolean;
  stock: number;
  featured?: boolean;
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
}

export interface CreateProductInput {
  name: string;
  price: number;
  originalPrice?: number;
  category: string;
  image: string;
  sizes?: string[];
  colors?: string[];
  badge?: string;
  description?: string;
  fit?: string;
  inStock?: boolean;
  stock?: number;
  featured?: boolean;
}

export interface UpdateProductInput {
  name?: string;
  price?: number;
  originalPrice?: number;
  category?: string;
  image?: string;
  sizes?: string[];
  colors?: string[];
  badge?: string;
  description?: string;
  fit?: string;
  inStock?: boolean;
  stock?: number;
  featured?: boolean;
}

export interface UploadImageInput {
  imageBase64: string;
  contentType?: string;
}

export interface CreatePayPalOrderInput {
  amount: number;
  currency?: string;
  items?: Array<{ name: string; quantity: number; price: number }>;
}

export interface CapturePayPalOrderInput {
  orderId: string;
}
