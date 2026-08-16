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

export interface GeneratePayFastPaymentInput {
  orderId: string;
  amount: number;
  itemName: string;
  itemDescription?: string;
  customer: {
    fullName: string;
    email: string;
    phone?: string;
  };
  returnUrl?: string;
  cancelUrl?: string;
}

export interface PayFastPaymentData {
  processUrl: string;
  fields: Record<string, string>;
}

export type DrippybanksOrderStatus =
  | 'Processing'
  | 'Packed'
  | 'Shipped'
  | 'Delivered'
  | 'Cancelled';

export type DrippybanksPaymentStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'cancelled';

export interface DrippybanksOrderItemInput {
  id: string;
  name: string;
  quantity: number;
  price: number;
  image: string;
}

export interface DrippybanksOrderCustomerInput {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  paymentMethod: 'payfast';
}

export interface CreateOrderInput {
  id: string;
  date?: string;
  status: DrippybanksOrderStatus;
  total: number;
  subtotal: number;
  shipping: number;
  tax: number;
  deliveryFee: number;
  fulfillmentMethod: 'collect' | 'deliver';
  paymentMethod: 'payfast';
  items: DrippybanksOrderItemInput[];
  customer: DrippybanksOrderCustomerInput;
  promoCode?: string;
  promoDiscountPercent?: number;
}

export interface UpdateOrderStatusInput {
  status: DrippybanksOrderStatus;
}

export interface DrippybanksOrderDocument extends CreateOrderInput {
  createdAt: string;
  updatedAt: string;
  createdByUid: string;
  createdByEmail: string;
  paymentStatus: DrippybanksPaymentStatus;
  payfastPaymentId?: string;
  payfastRawStatus?: string;
  paidAt?: string;
}

