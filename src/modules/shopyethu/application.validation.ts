import { BadRequestException } from '@nestjs/common';
import { text } from './marketplace.validation';
import type { Actor, ApplicationEvent, SellerApplication } from './marketplace.types';

const categories = ['Accessories', 'Home & Living', 'Pantry', 'Beauty', 'Clothing', 'Other'];

export function applicationFields(actor: Actor, body: Record<string, unknown>) {
  if (body.businessType !== 'individual' && body.businessType !== 'registered-business') throw new BadRequestException('Choose your business type.');
  if (!Array.isArray(body.categories) || !body.categories.length || body.categories.length > categories.length ||
    body.categories.some(value => typeof value !== 'string' || !categories.includes(value)) || new Set(body.categories).size !== body.categories.length) {
    throw new BadRequestException('Choose at least one valid product category.');
  }
  if (body.phoneConfirmed !== true) throw new BadRequestException('Confirm your business contact number.');
  if (typeof body.collectionOffered !== 'boolean') throw new BadRequestException('Choose whether you offer collection.');
  const phone = text(body.phone, 'Phone number', 7, 30);
  if (!/^\+?[\d\s()-]+$/.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15) {
    throw new BadRequestException('Enter a valid contact number.');
  }
  const email = text(actor.email, 'Contact email', 5, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid contact email.');
  return {
    businessName: text(body.businessName, 'Business name', 2, 100),
    businessType: body.businessType as 'individual' | 'registered-business',
    categories: body.categories as string[],
    contactName: text(body.contactName, 'Contact name', 2, 100), email, phone,
    phoneConfirmed: true, area: text(body.area, 'Operating area', 2, 120),
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
