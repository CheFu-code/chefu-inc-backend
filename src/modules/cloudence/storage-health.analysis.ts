import type { CloudenceFileDocument } from './cloudence.types';

export const HEALTH_SCAN_LIMIT = 10000;
export const HEALTH_ITEMS_LIMIT = 100;
export const OLD_FILE_DAYS = 90;
const DAY = 86400000;
const MB = 1024 ** 2;
export type HealthCategory = 'duplicates' | 'versions' | 'largeMedia' | 'olderFiles';

function publicFile(file: CloudenceFileDocument) {
  return {
    id: file.id, name: file.name, size: file.size, type: file.type, extension: file.extension,
    createdAt: file.createdAt, updatedAt: file.updatedAt,
    owner: { id: file.owner.id, fullName: file.owner.fullName, email: file.owner.email }, users: file.users || [],
  };
}
type HealthItem = { file: ReturnType<typeof publicFile>; reason: string; keepId?: string; keepName?: string; keepFile?: ReturnType<typeof publicFile> };
type HealthBucket = { count: number; bytes: number; items: HealthItem[] };
const bucket = (): HealthBucket => ({ count: 0, bytes: 0, items: [] });
const time = (value: string) => Date.parse(value);

function namedVersion(file: CloudenceFileDocument) {
  const extension = `.${file.extension}`;
  const name = file.name.toLowerCase().endsWith(extension.toLowerCase())
    ? file.name.slice(0, -extension.length) : file.name;
  const match = name.normalize('NFKC').match(/^(.+?)[\s._-]+(?:v|version)[\s._-]*(\d+)$/i);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { key: `${file.type}:${file.extension.toLowerCase()}:${match[1].trim().toLowerCase()}`, number: Number(match[2]) };
}

/** Read-only analysis. Age and filename patterns are suggestions, never proof of waste. */
export function analyzeStorageHealth(records: CloudenceFileDocument[], ownerId: string, now = Date.now(), truncated = false) {
  const files = [...new Map(records.filter(file => file.ownerId === ownerId && !file.isDeleted &&
    Number.isSafeInteger(file.size) && file.size >= 0).map(file => [file.id, file])).values()];
  const categories = { duplicates: bucket(), versions: bucket(), largeMedia: bucket(), olderFiles: bucket() };
  const assigned = new Set<string>();
  const keepers = new Set<string>();
  // Legacy records may alias a single provider object. Deleting one could break the other.
  const objects = new Map<string, string[]>();
  for (const file of files) {
    const key = file.storageProvider === 'r2' ? (file.storageKey ? `r2:${file.storageKey}` : null)
      : (file.publicId ? `cloudinary:${file.resourceType}:${file.deliveryType || 'upload'}:${file.publicId}` : null);
    if (!key) continue;
    const group = objects.get(key) || [];
    group.push(file.id);
    objects.set(key, group);
  }
  for (const ids of objects.values()) if (ids.length > 1) ids.forEach(id => keepers.add(id));
  const add = (category: HealthCategory, file: CloudenceFileDocument, reason: string, keep?: CloudenceFileDocument) => {
    if (assigned.has(file.id) || keepers.has(file.id)) return;
    assigned.add(file.id);
    const result = categories[category];
    result.count++;
    result.bytes += file.size;
    if (result.items.length < HEALTH_ITEMS_LIMIT) result.items.push({
      file: publicFile(file), reason,
      ...(keep ? { keepId: keep.id, keepName: keep.name, keepFile: publicFile(keep) } : {}),
    });
  };
  const hashes = new Map<string, CloudenceFileDocument[]>();
  for (const file of files) {
    if (!file.sha256 || !/^[a-f0-9]{64}$/i.test(file.sha256)) continue;
    const key = `${file.sha256.toLowerCase()}:${file.size}`;
    const group = hashes.get(key) || [];
    group.push(file);
    hashes.set(key, group);
  }
  for (const group of hashes.values()) {
    if (group.length < 2) continue;
    // Prefer preserving an already shared copy, then the earliest original.
    group.sort((a, b) => Number(!!b.users?.length) - Number(!!a.users?.length) ||
      (time(a.createdAt) || 0) - (time(b.createdAt) || 0) || a.id.localeCompare(b.id));
    const keep = group[0];
    keepers.add(keep.id);
    for (const file of group.slice(1)) add('duplicates', file, 'Identical file content', keep);
  }
  const versions = new Map<string, { file: CloudenceFileDocument; number: number }[]>();
  for (const file of files) {
    if (assigned.has(file.id)) continue;
    const version = namedVersion(file);
    if (version) {
      const group = versions.get(version.key) || [];
      group.push({ file, number: version.number });
      versions.set(version.key, group);
    }
  }
  for (const group of versions.values()) {
    if (new Set(group.map(item => item.number)).size < 2) continue;
    group.sort((a, b) => b.number - a.number || (time(b.file.updatedAt) || 0) - (time(a.file.updatedAt) || 0));
    const newest = group[0];
    keepers.add(newest.file.id);
    for (const item of group.slice(1)) {
      if (item.number < newest.number) add('versions', item.file, 'Lower version number in filename; compare before deleting', newest.file);
    }
  }
  for (const file of [...files].sort((a, b) => b.size - a.size)) {
    const threshold = file.type === 'image' ? 10 * MB : 25 * MB;
    if (['image', 'video', 'audio'].includes(file.type) && file.size >= threshold) {
      add('largeMedia', file, 'Consider a compressed copy; check its quality before removing this original');
    }
    const modified = time(file.updatedAt);
    if (!file.users?.length && Number.isFinite(modified) && modified <= now - OLD_FILE_DAYS * DAY) {
      add('olderFiles', file, 'Unchanged for 90+ days; it may still be important');
    }
  }
  return {
    scannedAt: new Date(now).toISOString(), scannedFiles: files.length, truncated,
    reviewedBytes: Object.values(categories).reduce((sum, category) => sum + category.bytes, 0),
    duplicateBytes: categories.duplicates.bytes,
    unhashedFiles: files.filter(file => !file.sha256 || !/^[a-f0-9]{64}$/i.test(file.sha256)).length,
    categories,
  };
}
