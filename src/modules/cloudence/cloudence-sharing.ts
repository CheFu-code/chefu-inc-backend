import type { CloudenceFileDocument } from "./cloudence.types";

export function isSharingExpiredForUser(
  file: CloudenceFileDocument,
  email: string,
  now = Date.now(),
) {
  const normalizedEmail = email.trim().toLowerCase();
  const userExpirations = file.shareExpiresAtByUser;

  if (
    Object.prototype.hasOwnProperty.call(userExpirations ?? {}, normalizedEmail)
  ) {
    const expiresAt = userExpirations![normalizedEmail];
    if (expiresAt === null) return false;
    const timestamp = Date.parse(expiresAt ?? "");
    return !Number.isFinite(timestamp) || timestamp <= now;
  }

  if (!file.shareExpiresAt) return false;
  const timestamp = Date.parse(file.shareExpiresAt);
  return !Number.isFinite(timestamp) || timestamp <= now;
}
