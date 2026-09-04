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
  | 'Pending'
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
  cancelledReason?: string;
}

export interface PayFastItnPayload {
  m_payment_id?: string;
  pf_payment_id?: string;
  payment_status?: string;
  item_name?: string;
  item_description?: string;
  amount_gross?: string | number;
  amount_fee?: string | number;
  amount_net?: string | number;
  merchant_id?: string | number;
  signature?: string;
  name_first?: string;
  name_last?: string;
  email_address?: string;
  cell_number?: string;
  [key: string]: unknown;
}

export interface DrippybanksPayFastTransaction {
  pfPaymentId: string;
  orderId: string;
  paymentStatus: string;
  amountGross: number;
  amountFee?: number;
  amountNet?: number;
  merchantId: string;
  processedAt: string;
  idempotentHits?: number;
  rawPayload?: Record<string, unknown>;
}

