import { BadRequestException } from '@nestjs/common';

export function text(value: unknown, name: string, max = 30000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new BadRequestException(`Invalid ${name}.`);
  }
  return value.trim();
}

export function identifier(value: unknown): string {
  const result = text(value, 'identifier', 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new BadRequestException('Invalid identifier.');
  return result;
}

export function metadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 32000) {
    throw new BadRequestException('Invalid metadata.');
  }
  return JSON.parse(JSON.stringify(value));
}
