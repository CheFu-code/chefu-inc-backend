import { createHash } from 'node:crypto';

export function getPasswordBreachRange(password: string) {
  const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return {
    prefix: digest.slice(0, 5),
    suffix: digest.slice(5),
  };
}

export function findPasswordBreachCount(rangeFile: string, hashSuffix: string): number {
  const expectedSuffix = hashSuffix.toUpperCase();
  for (const line of rangeFile.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const suffix = line.slice(0, separator).trim().toUpperCase();
    if (suffix !== expectedSuffix) continue;

    const count = Number(line.slice(separator + 1).trim());
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  }
  return 0;
}
