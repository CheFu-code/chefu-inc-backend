import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ProductDocument } from '../products/products.types';

export type CheckoutItem = { productId: string; variantId?: string; quantity: number };
export type CheckoutInput = {
    items: CheckoutItem[];
    currency: 'ZAR';
    termsAccepted: true;
    delivery: Record<string, string>;
};
export type OrderLine = CheckoutItem & { name: string; sku: string; unitPriceMinor: number; stockTracking: boolean };
export const CHECKOUT_COOKIE = 'chefu_checkout';
const provinces = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'];

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Expected an object.');
    return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new BadRequestException('Unexpected checkout field.');
}
export function identifier(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.=-]{1,128}$/.test(value) || ['.', '..'].includes(value)) throw new BadRequestException('Invalid identifier.');
    return value;
}
export function validateCheckout(value: unknown): CheckoutInput {
    const body = object(value);
    fields(body, ['items', 'currency', 'termsAccepted', 'delivery']);
    if (body.currency !== 'ZAR' || body.termsAccepted !== true) throw new BadRequestException('ZAR currency and accepted terms are required.');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw new BadRequestException('Supply between 1 and 50 cart lines.');
    const seen = new Set<string>();
    const items = body.items.map(value => {
        const item = object(value);
        fields(item, ['productId', 'variantId', 'quantity']);
        const productId = identifier(item.productId);
        const variantId = item.variantId === undefined ? undefined : identifier(item.variantId);
        if (!Number.isSafeInteger(item.quantity) || Number(item.quantity) < 1 || Number(item.quantity) > 100) throw new BadRequestException('Quantity must be between 1 and 100.');
        const key = JSON.stringify([productId, variantId ?? null]);
        if (seen.has(key)) throw new BadRequestException('Duplicate cart line.');
        seen.add(key);
        return { productId, ...(variantId ? { variantId } : {}), quantity: item.quantity as number };
    }).sort((a, b) => JSON.stringify([a.productId, a.variantId]).localeCompare(JSON.stringify([b.productId, b.variantId])));
    const rawDelivery = object(body.delivery);
    const limits: Record<string, number> = { firstName: 100, lastName: 100, email: 254, phone: 30, addressLine1: 200, addressLine2: 200, city: 100, province: 30, postalCode: 4, country: 2, notes: 1000 };
    fields(rawDelivery, Object.keys(limits));
    const delivery: Record<string, string> = {};
    for (const [key, max] of Object.entries(limits)) {
        const value = rawDelivery[key] ?? (['addressLine2', 'notes'].includes(key) ? '' : undefined);
        if (typeof value !== 'string' || value.trim().length > max || (!['addressLine2', 'notes'].includes(key) && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) throw new BadRequestException(`Invalid delivery ${key}.`);
        delivery[key] = value.trim();
    }
    delivery.email = delivery.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(delivery.email) || !/^\+?[\d ()-]+$/.test(delivery.phone) || !/^\d{9,15}$/.test(delivery.phone.replace(/\D/g, '')) || !/^\d{4}$/.test(delivery.postalCode) || !provinces.includes(delivery.province) || delivery.country !== 'ZA') throw new BadRequestException('Invalid delivery contact or South African address.');
    return { items, currency: 'ZAR', termsAccepted: true, delivery };
}
export function validateReference(body: unknown) {
    const value = object(body);
    fields(value, ['reference']);
    return identifier(value.reference);
}

// Products and variant arrays come from Firestore, never from the browser.
export function priceOrder(items: CheckoutItem[], products: Map<string, ProductDocument>) {
    const lines: OrderLine[] = items.map(item => {
        const product = products.get(item.productId);
        if (!product || product.status !== 'ACTIVE' || product.currency !== 'ZAR') throw new ConflictException('Product is unavailable.');
        const variant = item.variantId ? product.variants?.find(v => v.id === item.variantId) : undefined;
        if ((item.variantId && !variant) || (!item.variantId && product.variants?.length)) throw new ConflictException('Choose a valid product variant.');
        const price = variant?.priceMinor ?? product.priceMinor;
        const stock = variant?.inventoryQuantity ?? product.inventoryQuantity;
        if (!Number.isSafeInteger(price) || price < 0 || (product.stockTracking !== false && (!Number.isSafeInteger(stock) || stock < item.quantity))) throw new ConflictException('Product price or availability changed.');
        return { ...item, name: product.name, sku: variant?.sku ?? product.sku, unitPriceMinor: price, stockTracking: product.stockTracking !== false };
    });
    const subtotalMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
    const deliveryMinor = subtotalMinor >= 100_000 ? 0 : 6_000;
    const amountMinor = subtotalMinor + deliveryMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 100_000_000) throw new BadRequestException('Order total is outside the supported range.');
    return { lines, subtotalMinor, deliveryMinor, amountMinor, currency: 'ZAR' as const };
}
