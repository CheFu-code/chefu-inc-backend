import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { FieldValue } from "firebase-admin/firestore";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { v2 as cloudinary, UploadApiOptions } from "cloudinary";
import { AuthenticatedUser } from "../auth/authenticated-user";
import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";
import { assertCloudinaryConfigured, assertPayFastConfigured } from "../../common/env";
import {
  CreateOrderInput,
  CreateProductInput,
  DrippybanksOrderDocument,
  DrippybanksOrderStatus,
  DrippybanksPaymentStatus,
  DrippyProductDocument,
  UpdateProductInput,
  UploadImageInput,
  GeneratePayFastPaymentInput,
  PayFastPaymentData,
  PayFastItnPayload,
  DrippybanksPayFastTransaction,
} from "./drippybanks.types";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const ORDER_STATUSES: DrippybanksOrderStatus[] = [
  "Pending",
  "Processing",
  "Packed",
  "Shipped",
  "Delivered",
  "Cancelled",
];

@Injectable()
export class DrippybanksService {
  private readonly logger = new Logger(DrippybanksService.name);
  private readonly collectionName = "drippybanksProducts";
  private readonly ordersCollectionName = "drippybanksOrders";
  private readonly transactionsCollectionName = "drippybanksPayfastTransactions";

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

    const products = snapshot.docs.map((doc) =>
      this.serializeProduct(doc.id, doc.data()),
    );
    return { products: this.sortProducts(products) };
  }

  async getProductById(id: string): Promise<DrippyProductDocument> {
    if (!id || typeof id !== "string") {
      throw new BadRequestException("Product ID is required.");
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
        event: "drippybanks_product_created",
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
    if (!id || typeof id !== "string") {
      throw new BadRequestException("Product ID is required.");
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
        event: "drippybanks_product_updated",
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
    if (!id || typeof id !== "string") {
      throw new BadRequestException("Product ID is required.");
    }

    const product = await this.getProductById(id);

    // If product image is hosted on Cloudinary, delete it from the media library
    if (product.image && product.image.includes("res.cloudinary.com")) {
      await this.deleteCloudinaryImage(product.image);
    }

    await this.firebaseAdmin
      .db()
      .collection(this.collectionName)
      .doc(id)
      .delete();

    this.logger.log(
      JSON.stringify({
        event: "drippybanks_product_deleted",
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
        event: "drippybanks_product_stock_toggled",
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
    assertCloudinaryConfigured();

    if (!input || !input.imageBase64) {
      throw new BadRequestException("Image data (imageBase64) is required.");
    }

    const parsed = this.parseImageBody(input.imageBase64, input.contentType);
    const buffer = Buffer.from(parsed.base64, "base64");

    if (!buffer.length) {
      throw new BadRequestException("Uploaded image is empty.");
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        "Image exceeds the maximum allowed size of 5 MB.",
      );
    }

    const publicId = `drippybanks/products/${Date.now()}_${randomUUID()}`;

    const result = await this.uploadBufferToCloudinary(buffer, {
      public_id: publicId,
      resource_type: "image",
      folder: undefined, // already encoded in publicId
      overwrite: false,
      tags: ["drippybanks", "product", user.email],
    });

    this.logger.log(
      JSON.stringify({
        event: "drippybanks_image_uploaded",
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
    const dataUriMatch = rawInput.match(
      /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i,
    );
    const contentType = String(
      dataUriMatch?.[1] || explicitContentType || "image/jpeg",
    ).toLowerCase();
    const base64 = dataUriMatch ? dataUriMatch[2] : rawInput;

    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new BadRequestException(
        "Unsupported image type. Please upload PNG, JPG, or WEBP.",
      );
    }

    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
      throw new BadRequestException(
        "Image payload must be a valid base64 string.",
      );
    }

    return {
      base64,
      contentType: contentType === "image/jpg" ? "image/jpeg" : contentType,
    };
  }

  private resolveExtension(contentType: string): string {
    if (contentType === "image/png") return "png";
    if (contentType === "image/webp") return "webp";
    return "jpg";
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
          if (!result)
            return reject(new Error("Cloudinary returned no result."));
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
          });
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
        await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
      }
    } catch (err) {
      this.logger.warn(`Could not delete Cloudinary image: ${url}`, err);
    }
  }

  private validateProductInput(
    input: CreateProductInput,
  ): Omit<
    DrippyProductDocument,
    "id" | "createdAt" | "updatedAt" | "createdBy"
  > {
    if (!input || typeof input !== "object") {
      throw new BadRequestException("Request body must be an object.");
    }

    const name = String(input.name || "").trim();
    if (!name) {
      throw new BadRequestException("Product name is required.");
    }

    const category = String(input.category || "").trim();
    if (!category) {
      throw new BadRequestException("Product category is required.");
    }

    const price =
      typeof input.price === "number" ? input.price : Number(input.price);
    if (isNaN(price) || price < 0) {
      throw new BadRequestException(
        "Price must be a valid non-negative number.",
      );
    }

    const image = String(input.image || "").trim();
    if (!image) {
      throw new BadRequestException("Product image URL is required.");
    }

    const originalPrice =
      input.originalPrice !== undefined && input.originalPrice !== null
        ? Number(input.originalPrice)
        : undefined;

    const sizes =
      Array.isArray(input.sizes) && input.sizes.length > 0
        ? input.sizes.map((s) => String(s).trim()).filter(Boolean)
        : ["One Size"];

    const colors =
      Array.isArray(input.colors) && input.colors.length > 0
        ? input.colors.map((c) => String(c).trim()).filter(Boolean)
        : ["Standard"];

    const badge = input.badge ? String(input.badge).trim() : undefined;
    const description = input.description
      ? String(input.description).trim()
      : undefined;
    const fit = input.fit ? String(input.fit).trim() : undefined;
    const inStock = input.inStock !== false;
    const stock =
      typeof input.stock === "number" ? input.stock : Number(input.stock || 50);
    const featured = Boolean(input.featured);

    return {
      name,
      category,
      price,
      originalPrice:
        originalPrice && originalPrice > 0 ? originalPrice : undefined,
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
  ): Partial<
    Omit<DrippyProductDocument, "id" | "createdAt" | "updatedAt" | "createdBy">
  > {
    if (!input || typeof input !== "object") {
      throw new BadRequestException("Request body must be an object.");
    }

    const update: Partial<DrippyProductDocument> = {};

    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new BadRequestException("Product name cannot be empty.");
      update.name = name;
    }

    if (input.category !== undefined) {
      const category = String(input.category).trim();
      if (!category) throw new BadRequestException("Category cannot be empty.");
      update.category = category;
    }

    if (input.price !== undefined) {
      const price = Number(input.price);
      if (isNaN(price) || price < 0) {
        throw new BadRequestException("Price must be a non-negative number.");
      }
      update.price = price;
    }

    if (input.originalPrice !== undefined) {
      const originalPrice = input.originalPrice
        ? Number(input.originalPrice)
        : undefined;
      update.originalPrice =
        originalPrice && originalPrice > 0 ? originalPrice : undefined;
    }

    if (input.image !== undefined) {
      const image = String(input.image).trim();
      if (!image)
        throw new BadRequestException("Product image cannot be empty.");
      update.image = image;
    }

    if (input.sizes !== undefined) {
      update.sizes = Array.isArray(input.sizes)
        ? input.sizes.map((s) => String(s).trim()).filter(Boolean)
        : ["One Size"];
    }

    if (input.colors !== undefined) {
      update.colors = Array.isArray(input.colors)
        ? input.colors.map((c) => String(c).trim()).filter(Boolean)
        : ["Standard"];
    }

    if (input.badge !== undefined) {
      update.badge = input.badge ? String(input.badge).trim() : undefined;
    }

    if (input.description !== undefined) {
      update.description = input.description
        ? String(input.description).trim()
        : undefined;
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

  private serializeProduct(
    id: string,
    data: Record<string, unknown>,
  ): DrippyProductDocument {
    return {
      id: String(data.id || id),
      name: String(data.name || "Untitled Piece"),
      price:
        typeof data.price === "number" ? data.price : Number(data.price || 0),
      originalPrice:
        typeof data.originalPrice === "number"
          ? data.originalPrice
          : data.originalPrice
            ? Number(data.originalPrice)
            : undefined,
      category: String(data.category || "Tops"),
      image: String(data.image || "/placeholder.png"),
      sizes: Array.isArray(data.sizes) ? data.sizes.map(String) : ["One Size"],
      colors: Array.isArray(data.colors)
        ? data.colors.map(String)
        : ["Midnight Black"],
      badge: data.badge ? String(data.badge) : undefined,
      description: data.description ? String(data.description) : undefined,
      fit: data.fit ? String(data.fit) : undefined,
      inStock: data.inStock !== false,
      stock:
        typeof data.stock === "number" ? data.stock : Number(data.stock || 50),
      featured: Boolean(data.featured),
      createdAt: data.createdAt
        ? String(data.createdAt)
        : new Date().toISOString(),
      updatedAt: data.updatedAt ? String(data.updatedAt) : undefined,
      createdBy: data.createdBy ? String(data.createdBy) : undefined,
    };
  }

  private sortProducts(
    products: DrippyProductDocument[],
  ): DrippyProductDocument[] {
    return products.sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime(),
    );
  }

  async createOrder(
    user: AuthenticatedUser,
    input: CreateOrderInput,
  ): Promise<DrippybanksOrderDocument> {
    const validated = this.validateOrderInput(input, user.email);
    const now = new Date().toISOString();
    const orderRef = this.firebaseAdmin
      .db()
      .collection(this.ordersCollectionName)
      .doc(validated.id);

    const existing = await orderRef.get();
    if (existing.exists) {
      throw new BadRequestException(`Order ${validated.id} already exists.`);
    }

    const orderDoc: DrippybanksOrderDocument = {
      ...validated,
      status: "Pending",
      paymentStatus: "pending",
      createdAt: now,
      updatedAt: now,
      createdByUid: user.uid,
      createdByEmail: user.email.trim().toLowerCase(),
    };

    await orderRef.set(orderDoc);

    this.logger.log(
      JSON.stringify({
        event: "drippybanks_order_created",
        orderId: orderDoc.id,
        customerEmail: orderDoc.createdByEmail,
        total: orderDoc.total,
      }),
    );

    return orderDoc;
  }

  async listMyOrders(
    user: AuthenticatedUser,
  ): Promise<{ orders: DrippybanksOrderDocument[] }> {
    const customerEmail = user.email.trim().toLowerCase();
    const snapshot = await this.firebaseAdmin
      .db()
      .collection(this.ordersCollectionName)
      .where("createdByEmail", "==", customerEmail)
      .limit(50)
      .get();

    const orders = snapshot.docs
      .map((doc) => this.serializeOrder(doc.id, doc.data()))
      .sort(
        (a, b) =>
          new Date(b.createdAt || 0).getTime() -
          new Date(a.createdAt || 0).getTime(),
      );

    return { orders };
  }

  async listOrdersForAdmin(): Promise<{ orders: DrippybanksOrderDocument[] }> {
    const snapshot = await this.firebaseAdmin
      .db()
      .collection(this.ordersCollectionName)
      .limit(100)
      .get();

    const orders = snapshot.docs
      .map((doc) => this.serializeOrder(doc.id, doc.data()))
      .sort(
        (a, b) =>
          new Date(b.createdAt || 0).getTime() -
          new Date(a.createdAt || 0).getTime(),
      );

    return { orders };
  }

  async getOrderByIdForUser(
    user: AuthenticatedUser,
    orderId: string,
  ): Promise<{ order: DrippybanksOrderDocument }> {
    const order = await this.getOrderById(orderId);
    const isAdmin = user.roles
      .map((role) => role.toLowerCase())
      .includes("admin");
    const customerEmail = user.email.trim().toLowerCase();

    if (!isAdmin && order.createdByEmail !== customerEmail) {
      throw new ForbiddenException("You do not have access to this order.");
    }

    return { order };
  }

  async updateOrderStatus(
    user: AuthenticatedUser,
    orderId: string,
    nextStatus: DrippybanksOrderStatus,
  ): Promise<{ order: DrippybanksOrderDocument }> {
    if (!ORDER_STATUSES.includes(nextStatus)) {
      throw new BadRequestException("Invalid order status.");
    }

    const order = await this.getOrderById(orderId);
    const updatedAt = new Date().toISOString();

    const nextOrder: DrippybanksOrderDocument = {
      ...order,
      status: nextStatus,
      updatedAt,
    };

    await this.firebaseAdmin
      .db()
      .collection(this.ordersCollectionName)
      .doc(orderId)
      .set(
        {
          status: nextStatus,
          updatedAt,
        },
        { merge: true },
      );

    this.logger.log(
      JSON.stringify({
        event: "drippybanks_order_status_updated",
        orderId,
        updatedBy: user.email,
        status: nextStatus,
      }),
    );

    return { order: nextOrder };
  }

  // ── PayFast Payment Integration (payfast.io) ──

  async generatePayFastPayment(
    user: AuthenticatedUser,
    input: GeneratePayFastPaymentInput,
  ): Promise<PayFastPaymentData> {
    assertPayFastConfigured();

    const order = await this.getOrderById(input.orderId);
    const customerEmail = user.email.trim().toLowerCase();
    const isAdmin = user.roles
      .map((role) => role.toLowerCase())
      .includes("admin");

    if (!isAdmin && order.createdByEmail !== customerEmail) {
      throw new ForbiddenException(
        "You do not have access to this order payment request.",
      );
    }

    const merchantId = process.env.PAYFAST_MERCHANT_ID || "10000100";
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY || "46f0cd694581a";
    const passphrase = process.env.PAYFAST_PASSPHRASE || "";
    const isSandbox = process.env.PAYFAST_SANDBOX !== "false";
    const processUrl = isSandbox
      ? "https://sandbox.payfast.co.za/eng/process"
      : "https://www.payfast.co.za/eng/process";

    const amount = Number(input.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new BadRequestException("Valid payment amount is required.");
    }

    const names = (input.customer?.fullName || "Customer").trim().split(" ");
    const name_first = names[0] || "Valued";
    const name_last = names.slice(1).join(" ") || "Customer";

    const fields: Record<string, string> = {
      merchant_id: merchantId,
      merchant_key: merchantKey,
      return_url:
        input.returnUrl ||
        `${process.env.DRIPPYBANKS_APP_URL || "https://drippybanks.chefu.co.za"}/checkout?payfast_success=true&order_id=${input.orderId}`,
      cancel_url:
        input.cancelUrl ||
        `${process.env.DRIPPYBANKS_APP_URL || "https://drippybanks.chefu.co.za"}/checkout?cancelled=true`,
      notify_url: `${process.env.BACKEND_PUBLIC_URL || "https://api.chefu.co.za"}/drippybanks/payfast/notify`,
      name_first,
      name_last,
      email_address: input.customer?.email?.trim() || "customer@chefu.co.za",
      m_payment_id: input.orderId,
      amount: amount.toFixed(2),
      item_name: (input.itemName || `DrippyBanks Order ${input.orderId}`).slice(
        0,
        100,
      ),
    };

    if (input.customer?.phone) {
      fields.cell_number = input.customer.phone.trim();
    }
    if (input.itemDescription) {
      fields.item_description = input.itemDescription.slice(0, 255);
    }

    // Build PayFast parameter string for MD5 signature
    let pfOutput = "";
    for (const key in fields) {
      if (
        Object.prototype.hasOwnProperty.call(fields, key) &&
        fields[key] !== ""
      ) {
        pfOutput += `${key}=${encodeURIComponent(fields[key].trim()).replace(/%20/g, "+")}&`;
      }
    }

    let getString = pfOutput.slice(0, -1);
    if (passphrase) {
      getString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
    }

    const signature = createHash("md5").update(getString).digest("hex");
    fields.signature = signature;

    this.logger.log(
      JSON.stringify({
        event: "drippybanks_payfast_payment_generated",
        orderId: input.orderId,
        amount: fields.amount,
        isSandbox,
      }),
    );

    return {
      processUrl,
      fields,
    };
  }

  async handlePayFastNotify(
    body: Record<string, unknown>,
  ): Promise<{ status: string }> {
    assertPayFastConfigured();

    this.logger.log(
      JSON.stringify({
        event: "drippybanks_payfast_itn_received",
        paymentId: body.m_payment_id,
        pfPaymentId: body.pf_payment_id,
        paymentStatus: body.payment_status,
      }),
    );

    // 1. Mandatory Signature Validation (Never skip or bypass)
    const signature = String(body.signature || "").trim();
    if (!signature) {
      this.logger.warn(
        JSON.stringify({
          event: "drippybanks_payfast_missing_signature",
          paymentId: body.m_payment_id,
        }),
      );
      throw new BadRequestException("Missing PayFast signature.");
    }

    const passphrase = process.env.PAYFAST_PASSPHRASE || "";
    const isSandbox = process.env.PAYFAST_SANDBOX !== "false";

    const isValidSignature = this.verifyPayFastSignature(body, passphrase);
    if (!isValidSignature) {
      this.logger.warn(
        JSON.stringify({
          event: "drippybanks_payfast_invalid_signature",
          paymentId: body.m_payment_id,
          receivedSignature: body.signature,
        }),
      );
      throw new BadRequestException("Invalid PayFast signature.");
    }

    // 2. Strict Merchant ID Validation
    const expectedMerchantId = (process.env.PAYFAST_MERCHANT_ID || "10000100").trim();
    const receivedMerchantId = String(body.merchant_id || "").trim();
    if (receivedMerchantId && receivedMerchantId !== expectedMerchantId) {
      this.logger.warn(
        JSON.stringify({
          event: "drippybanks_payfast_merchant_mismatch",
          expected: expectedMerchantId,
          received: receivedMerchantId,
        }),
      );
      throw new BadRequestException("Invalid merchant ID.");
    }

    // 3. Server-to-Server Confirmation with PayFast (/eng/query/validate)
    const isProduction = process.env.NODE_ENV === "production";
    const bypassHostValidation =
      !isProduction && process.env.PAYFAST_BYPASS_QUERY_VALIDATE === "true";

    if (!bypassHostValidation) {
      const isServerValid = await this.validatePayFastItnWithHost(
        body,
        isSandbox,
      );
      if (!isServerValid) {
        this.logger.warn(
          JSON.stringify({
            event: "drippybanks_payfast_host_validation_failed",
            paymentId: body.m_payment_id,
            pfPaymentId: body.pf_payment_id,
          }),
        );
        throw new BadRequestException("PayFast server confirmation failed.");
      }
    }

    const paymentStatus = String(body.payment_status || "").toUpperCase();
    const orderId = String(body.m_payment_id || "").trim();
    const payfastPaymentId = String(body.pf_payment_id || "").trim();
    const amountGross = Number(body.amount_gross || 0);
    const amountFee = body.amount_fee !== undefined ? Number(body.amount_fee) : undefined;
    const amountNet = body.amount_net !== undefined ? Number(body.amount_net) : undefined;

    if (!orderId) {
      throw new BadRequestException("Order ID (m_payment_id) missing from ITN.");
    }

    const orderRef = this.firebaseAdmin
      .db()
      .collection(this.ordersCollectionName)
      .doc(orderId);

    // 4. Handle Successful Payment (COMPLETE) via Atomic Firestore Transaction
    if (paymentStatus === "COMPLETE") {
      const db = this.firebaseAdmin.db();
      const txRef = payfastPaymentId
        ? db.collection(this.transactionsCollectionName).doc(payfastPaymentId)
        : null;

      const txResult = await db.runTransaction(async (transaction) => {
        const orderDoc = await transaction.get(orderRef);
        if (!orderDoc.exists) {
          throw new NotFoundException(`Order ${orderId} was not found.`);
        }

        const orderData = orderDoc.data() as DrippybanksOrderDocument;

        // Idempotency check 1: If order is already marked paid
        if (orderData.paymentStatus === "paid") {
          this.logger.log(
            JSON.stringify({
              event: "drippybanks_payfast_itn_idempotent_order_already_paid",
              orderId,
              pfPaymentId: payfastPaymentId,
            }),
          );
          return { status: "ALREADY_PROCESSED" };
        }

        // Idempotency check 2: If transaction pf_payment_id was already recorded
        if (txRef) {
          const existingTx = await transaction.get(txRef);
          if (existingTx.exists) {
            this.logger.log(
              JSON.stringify({
                event: "drippybanks_payfast_itn_idempotent_tx_already_exists",
                orderId,
                pfPaymentId: payfastPaymentId,
              }),
            );
            return { status: "ALREADY_PROCESSED" };
          }
        }

        // Strict Amount Matching Check: within 0.01 ZAR tolerance
        const orderTotal = Number(orderData.total || 0);
        if (Math.abs(amountGross - orderTotal) > 0.01) {
          this.logger.error(
            JSON.stringify({
              event: "drippybanks_payfast_amount_mismatch",
              orderId,
              orderTotal,
              amountGross,
            }),
          );
          throw new BadRequestException(
            "Payment amount does not match order total.",
          );
        }

        // Read all product docs in transaction to decrement stock
        const rawItems = Array.isArray(orderData.items) ? orderData.items : [];
        const productRefs = rawItems.map((item) => ({
          item,
          ref: db.collection(this.collectionName).doc(item.id),
        }));

        const productDocs = await Promise.all(
          productRefs.map(({ ref }) => transaction.get(ref)),
        );

        const now = new Date().toISOString();

        // Atomic write: decrement product stock
        for (let i = 0; i < productRefs.length; i++) {
          const { item, ref } = productRefs[i];
          const pDoc = productDocs[i];
          if (pDoc.exists) {
            const pData = pDoc.data() || {};
            const currentStock =
              typeof pData.stock === "number" ? pData.stock : 50;
            const newStock = Math.max(0, currentStock - item.quantity);
            transaction.update(ref, {
              stock: newStock,
              inStock: newStock > 0,
              updatedAt: now,
            });
          }
        }

        // Atomic write: update order status to Paid and Processing
        transaction.update(orderRef, {
          paymentStatus: "paid",
          status: "Processing",
          paidAt: now,
          updatedAt: now,
          payfastPaymentId: payfastPaymentId || undefined,
          payfastRawStatus: paymentStatus,
        });

        // Atomic write: record transaction for idempotency audit log
        if (txRef && payfastPaymentId) {
          const txRecord: DrippybanksPayFastTransaction = {
            pfPaymentId: payfastPaymentId,
            orderId,
            paymentStatus,
            amountGross,
            amountFee: isNaN(Number(amountFee)) ? undefined : amountFee,
            amountNet: isNaN(Number(amountNet)) ? undefined : amountNet,
            merchantId: receivedMerchantId || expectedMerchantId,
            processedAt: now,
          };
          transaction.set(txRef, txRecord);
        }

        return { status: "PROCESSED" };
      });

      this.logger.log(
        JSON.stringify({
          event: "drippybanks_payfast_payment_confirmed",
          orderId,
          pfPaymentId: payfastPaymentId,
          result: txResult.status,
        }),
      );

      return { status: "OK" };
    }

    // 5. Handle Cancelled or Failed Payments Safely
    const now = new Date().toISOString();
    const orderDoc = await orderRef.get();
    if (orderDoc.exists) {
      const orderData = orderDoc.data() || {};
      // Never downgrade an already paid order
      if (orderData.paymentStatus !== "paid") {
        if (paymentStatus === "CANCELLED") {
          await orderRef.set(
            {
              paymentStatus: "cancelled",
              status: "Cancelled",
              cancelledReason: "PayFast payment was cancelled",
              payfastRawStatus: paymentStatus,
              payfastPaymentId: payfastPaymentId || undefined,
              updatedAt: now,
            },
            { merge: true },
          );
        } else if (paymentStatus === "FAILED") {
          await orderRef.set(
            {
              paymentStatus: "failed",
              cancelledReason: "PayFast payment failed",
              payfastRawStatus: paymentStatus,
              payfastPaymentId: payfastPaymentId || undefined,
              updatedAt: now,
            },
            { merge: true },
          );
        }
      }
    }

    return { status: "OK" };
  }

  private async validatePayFastItnWithHost(
    body: Record<string, unknown>,
    isSandbox: boolean,
  ): Promise<boolean> {
    const validateHost = isSandbox
      ? "https://sandbox.payfast.co.za/eng/query/validate"
      : "https://www.payfast.co.za/eng/query/validate";

    const params = new URLSearchParams();
    for (const key of Object.keys(body)) {
      const val = body[key];
      if (val !== undefined && val !== null) {
        params.append(key, String(val).trim());
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(validateHost, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.logger.warn(
          `PayFast query validate returned HTTP ${response.status}`,
        );
        return false;
      }

      const text = (await response.text()).trim();
      return text === "VALID";
    } catch (err) {
      this.logger.error("Failed to query validate with PayFast host", err);
      return false;
    }
  }

  private verifyPayFastSignature(
    body: Record<string, unknown>,
    passphrase: string,
  ): boolean {
    const receivedSignature = String(body.signature || "").trim().toLowerCase();
    if (!receivedSignature) return false;

    let pfOutput = "";
    for (const key in body) {
      if (
        Object.prototype.hasOwnProperty.call(body, key) &&
        key !== "signature"
      ) {
        const val = body[key];
        if (val !== undefined && val !== null && String(val) !== "") {
          pfOutput += `${key}=${encodeURIComponent(String(val).trim()).replace(/%20/g, "+")}&`;
        }
      }
    }

    let getString = pfOutput.slice(0, -1);
    if (passphrase) {
      getString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, "+")}`;
    }

    const calculatedSignature = createHash("md5")
      .update(getString)
      .digest("hex")
      .toLowerCase();

    return calculatedSignature === receivedSignature;
  }

  async cleanupExpiredPendingOrders(
    cutoffMinutes = 60,
  ): Promise<{ cancelledCount: number; orderIds: string[] }> {
    const db = this.firebaseAdmin.db();
    const cutoffDate = new Date(Date.now() - cutoffMinutes * 60 * 1000);
    const cutoffIso = cutoffDate.toISOString();

    const snapshot = await db
      .collection(this.ordersCollectionName)
      .where("paymentStatus", "==", "pending")
      .get();

    if (snapshot.empty) {
      return { cancelledCount: 0, orderIds: [] };
    }

    const expiredDocs = snapshot.docs.filter((doc) => {
      const data = doc.data();
      const createdAt = String(data.createdAt || data.date || "");
      return createdAt && createdAt < cutoffIso;
    });

    if (expiredDocs.length === 0) {
      return { cancelledCount: 0, orderIds: [] };
    }

    const batch = db.batch();
    const now = new Date().toISOString();
    const cancelledOrderIds: string[] = [];

    for (const doc of expiredDocs) {
      cancelledOrderIds.push(doc.id);
      batch.update(doc.ref, {
        paymentStatus: "cancelled",
        status: "Cancelled",
        cancelledReason: `Checkout session expired (unpaid after ${cutoffMinutes}m)`,
        updatedAt: now,
      });
    }

    await batch.commit();

    this.logger.log(
      JSON.stringify({
        event: "drippybanks_expired_pending_orders_cleaned",
        cancelledCount: cancelledOrderIds.length,
        orderIds: cancelledOrderIds,
        cutoffMinutes,
      }),
    );

    return {
      cancelledCount: cancelledOrderIds.length,
      orderIds: cancelledOrderIds,
    };
  }

  private async getOrderById(
    orderId: string,
  ): Promise<DrippybanksOrderDocument> {
    if (!orderId || typeof orderId !== "string") {
      throw new BadRequestException("Order ID is required.");
    }

    const orderDoc = await this.firebaseAdmin
      .db()
      .collection(this.ordersCollectionName)
      .doc(orderId)
      .get();

    if (!orderDoc.exists) {
      throw new NotFoundException(`Order ${orderId} was not found.`);
    }

    return this.serializeOrder(orderDoc.id, orderDoc.data() || {});
  }

  private validateOrderInput(
    input: CreateOrderInput,
    requestEmail: string,
  ): CreateOrderInput {
    if (!input || typeof input !== "object") {
      throw new BadRequestException("Order payload is required.");
    }

    const id = String(input.id || "").trim();
    if (!id) {
      throw new BadRequestException("Order ID is required.");
    }

    if (
      input.fulfillmentMethod !== "collect" &&
      input.fulfillmentMethod !== "deliver"
    ) {
      throw new BadRequestException(
        "Fulfillment method must be collect or deliver.",
      );
    }

    if (input.paymentMethod !== "payfast") {
      throw new BadRequestException(
        "Only payfast payment method is supported.",
      );
    }

    if (!ORDER_STATUSES.includes(input.status)) {
      throw new BadRequestException("Order status is invalid.");
    }

    const total = Number(input.total);
    const subtotal = Number(input.subtotal);
    const shipping = Number(input.shipping);
    const tax = Number(input.tax);
    const deliveryFee = Number(input.deliveryFee);

    if (
      [total, subtotal, shipping, tax, deliveryFee].some(
        (n) => Number.isNaN(n) || n < 0,
      )
    ) {
      throw new BadRequestException(
        "Order amounts must be valid non-negative numbers.",
      );
    }

    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestException("Order items are required.");
    }

    const items = input.items.map((item) => {
      const itemId = String(item.id || "").trim();
      const name = String(item.name || "").trim();
      const image = String(item.image || "").trim();
      const quantity = Number(item.quantity);
      const price = Number(item.price);

      if (!itemId || !name || !image) {
        throw new BadRequestException(
          "Each order item must include id, name, and image.",
        );
      }
      if (Number.isNaN(quantity) || quantity <= 0) {
        throw new BadRequestException(
          "Each order item must include a valid quantity.",
        );
      }
      if (Number.isNaN(price) || price < 0) {
        throw new BadRequestException(
          "Each order item must include a valid price.",
        );
      }

      return {
        id: itemId,
        name,
        image,
        quantity,
        price,
      };
    });

    if (!input.customer || typeof input.customer !== "object") {
      throw new BadRequestException("Customer details are required.");
    }

    const normalizedRequestEmail = requestEmail.trim().toLowerCase();
    const customerEmail = String(input.customer.email || "")
      .trim()
      .toLowerCase();
    if (!customerEmail || customerEmail !== normalizedRequestEmail) {
      throw new BadRequestException(
        "Customer email must match the authenticated account.",
      );
    }

    const customer = {
      fullName: String(input.customer.fullName || "").trim(),
      email: customerEmail,
      phone: String(input.customer.phone || "").trim(),
      address: String(input.customer.address || "").trim(),
      city: String(input.customer.city || "").trim(),
      postalCode: String(input.customer.postalCode || "").trim(),
      country: String(input.customer.country || "").trim(),
      paymentMethod: "payfast" as const,
    };

    if (!customer.fullName || !customer.email || !customer.phone) {
      throw new BadRequestException(
        "Customer full name, email, and phone are required.",
      );
    }

    if (input.fulfillmentMethod === "deliver") {
      if (
        !customer.address ||
        !customer.city ||
        !customer.postalCode ||
        !customer.country
      ) {
        throw new BadRequestException(
          "Delivery orders require full delivery address details.",
        );
      }
    }

    return {
      id,
      date: input.date ? String(input.date) : new Date().toISOString(),
      status: input.status,
      total,
      subtotal,
      shipping,
      tax,
      deliveryFee,
      fulfillmentMethod: input.fulfillmentMethod,
      paymentMethod: "payfast",
      items,
      customer,
      promoCode: input.promoCode
        ? String(input.promoCode).trim().toUpperCase()
        : undefined,
      promoDiscountPercent:
        input.promoDiscountPercent !== undefined
          ? Number(input.promoDiscountPercent)
          : undefined,
    };
  }

  private serializeOrder(
    id: string,
    data: Record<string, unknown>,
  ): DrippybanksOrderDocument {
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const items = rawItems
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const typedItem = item as Record<string, unknown>;
        return {
          id: String(typedItem.id || ""),
          name: String(typedItem.name || ""),
          image: String(typedItem.image || ""),
          quantity: Number(typedItem.quantity || 0),
          price: Number(typedItem.price || 0),
        };
      })
      .filter(
        (
          item,
        ): item is {
          id: string;
          name: string;
          image: string;
          quantity: number;
          price: number;
        } => !!item && !!item.id && !!item.name,
      );

    const customerData =
      data.customer && typeof data.customer === "object"
        ? (data.customer as Record<string, unknown>)
        : {};

    const paymentStatusValue = String(
      data.paymentStatus || "pending",
    ).toLowerCase();
    const paymentStatus: DrippybanksPaymentStatus =
      paymentStatusValue === "paid"
        ? "paid"
        : paymentStatusValue === "failed"
          ? "failed"
          : paymentStatusValue === "cancelled"
            ? "cancelled"
            : "pending";

    const statusCandidate = String(
      data.status || "Pending",
    ) as DrippybanksOrderStatus;
    const status = ORDER_STATUSES.includes(statusCandidate)
      ? statusCandidate
      : "Pending";

    return {
      id: String(data.id || id),
      date: String(data.date || data.createdAt || new Date().toISOString()),
      status,
      total: Number(data.total || 0),
      subtotal: Number(data.subtotal || 0),
      shipping: Number(data.shipping || 0),
      tax: Number(data.tax || 0),
      deliveryFee: Number(data.deliveryFee || 0),
      fulfillmentMethod:
        data.fulfillmentMethod === "deliver" ? "deliver" : "collect",
      paymentMethod: "payfast",
      items,
      customer: {
        fullName: String(customerData.fullName || ""),
        email: String(customerData.email || ""),
        phone: String(customerData.phone || ""),
        address: String(customerData.address || ""),
        city: String(customerData.city || ""),
        postalCode: String(customerData.postalCode || ""),
        country: String(customerData.country || ""),
        paymentMethod: "payfast",
      },
      promoCode: data.promoCode ? String(data.promoCode) : undefined,
      promoDiscountPercent:
        data.promoDiscountPercent !== undefined
          ? Number(data.promoDiscountPercent)
          : undefined,
      createdAt: String(data.createdAt || new Date().toISOString()),
      updatedAt: String(
        data.updatedAt || data.createdAt || new Date().toISOString(),
      ),
      createdByUid: String(data.createdByUid || ""),
      createdByEmail: String(data.createdByEmail || "").toLowerCase(),
      paymentStatus,
      payfastPaymentId: data.payfastPaymentId
        ? String(data.payfastPaymentId)
        : undefined,
      payfastRawStatus: data.payfastRawStatus
        ? String(data.payfastRawStatus)
        : undefined,
      paidAt: data.paidAt ? String(data.paidAt) : undefined,
    };
  }
}
