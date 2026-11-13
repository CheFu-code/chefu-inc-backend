import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Actor, Reader, Storefront } from './marketplace.types';

export function text(value: unknown, label: string, min = 1, max = 500) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new BadRequestException(`${label} must contain ${min}–${max} characters.`);
  return value.trim();
}
export function integer(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new BadRequestException(`${label} must be a whole number between ${min} and ${max}.`);
  return value;
}
export function id(value: unknown) { return text(value, 'Reference', 1, 120).replace(/[^A-Za-z0-9_-]/g, '_'); }
export function assertAdmin(actor: Actor) {
  if (!actor.roles.some(role => role.trim().toLowerCase() === 'admin')) throw new ForbiddenException('CheFu staff access required.');
}
export async function seller(reader: Reader, actor: Actor): Promise<Storefront> {
  const store = await reader.get<Storefront>('stores', actor.uid);
  if (!store) throw new ForbiddenException('Your seller application must be approved by CheFu first.');
  if (store.ownerUid !== actor.uid || store.status !== 'active') throw new ForbiddenException(store.reason || 'Selling is currently suspended.');
  return store;
}
export function exists<T>(value: T | null, label: string): T {
  if (!value) throw new NotFoundException(`${label} was not found.`);
  return value;
}
export function photos(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5) throw new BadRequestException('Use up to five photo URLs.');
  return value.map(item => {
    const raw = text(item, 'Photo URL', 8, 2048);
    try { const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
    catch { throw new BadRequestException('Photo URLs must use HTTPS. Upload hosting must be connected before local files can be published.'); }
    return raw;
  });
}
