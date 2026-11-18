import { BadRequestException } from '@nestjs/common';
import { normalizeContactPhone } from '../auth/phone-contact';
import { text } from './marketplace.validation';
import type { Actor, ApplicationEvent, SellerApplication } from './marketplace.types';

const categories = ['Accessories', 'Home & Living', 'Pantry', 'Beauty', 'Clothing', 'Other'];

export function applicationFields(actor: Actor, body: Record<string, unknown>) {
  if (body.businessType !== 'individual' && body.businessType !== 'registered-business') throw new BadRequestException('Choose your business type.');
  let cipcCertificateId: string | undefined;
  let cipcCertificateFormat: 'pdf' | 'jpg' | 'png' | 'webp' | undefined;
  if (body.businessType === 'registered-business') {
    cipcCertificateId = text(body.cipcCertificateId, 'CIPC certificate', 1, 200);
    const prefix = `shopyethu-applications/${actor.uid}/`;
    const assetName = cipcCertificateId.startsWith(prefix)
      ? cipcCertificateId.slice(prefix.length)
      : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.(?:pdf|jpg|png|webp))?$/i.test(assetName)) {
      throw new BadRequestException('Upload your CIPC registration certificate.');
    }
    const format = body.cipcCertificateFormat;
    if (format !== 'pdf' && format !== 'jpg' && format !== 'png' && format !== 'webp') {
      throw new BadRequestException('Upload a PDF, JPG, PNG or WebP CIPC certificate.');
    }
    cipcCertificateFormat = format;
  }
  if (!Array.isArray(body.categories) || !body.categories.length || body.categories.length > categories.length ||
    body.categories.some(value => typeof value !== 'string' || !categories.includes(value)) || new Set(body.categories).size !== body.categories.length) {
    throw new BadRequestException('Choose at least one valid product category.');
  }
  if (typeof body.collectionOffered !== 'boolean') throw new BadRequestException('Choose whether you offer collection.');
  if (body.whatsappAvailable !== undefined && typeof body.whatsappAvailable !== 'boolean') {
    throw new BadRequestException('Choose whether this number is available on WhatsApp.');
  }
  const phone = normalizeContactPhone(text(body.phone, 'Phone number', 7, 30));
  if (!phone || !/^\+27[1-9]\d{8}$/.test(phone)) {
    throw new BadRequestException('Enter a complete valid South African contact number.');
  }
  const email = text(actor.email, 'Contact email', 5, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid contact email.');
  const areaPlaceId = typeof body.areaPlaceId === 'string' && body.areaPlaceId
    ? text(body.areaPlaceId, 'Operating area', 1, 256)
    : undefined;
  if (areaPlaceId && !/^[A-Za-z0-9_-]+$/.test(areaPlaceId)) {
    throw new BadRequestException('Choose a valid South African operating area.');
  }
  return {
    businessName: text(body.businessName, 'Business name', 2, 100),
    businessType: body.businessType as 'individual' | 'registered-business',
    ...(cipcCertificateId && cipcCertificateFormat ? { cipcCertificateId, cipcCertificateFormat } : {}),
    categories: body.categories as string[],
    contactName: text(body.contactName, 'Contact name', 2, 100), email, phone,
    ...(typeof body.whatsappAvailable === 'boolean' ? { whatsappAvailable: body.whatsappAvailable } : {}),
    area: areaPlaceId ? '' : text(body.area, 'Operating area', 2, 120),
    ...(areaPlaceId ? { areaPlaceId } : {}),
    plans: text(body.plans, 'What you plan to sell', 10, 2000),
    collectionOffered: body.collectionOffered,
    collectionArea: body.collectionOffered ? text(body.collectionArea, 'Pickup area', 2, 120) : '',
    pickupHours: body.collectionOffered ? text(body.pickupHours, 'Pickup hours', 3, 300) : '',
    response: typeof body.response === 'string' ? text(body.response, 'Response', 0, 2000) : '',
  };
}

export function applicationHistory(previous: SellerApplication, event: ApplicationEvent) {
  const history = previous.history?.length ? previous.history : [{ status: previous.status, at: previous.updatedAt, reason: previous.reason }];
  // Preserve submission date separately; bound the size of a Firestore document.
  return [...history.slice(-99), event];
}
