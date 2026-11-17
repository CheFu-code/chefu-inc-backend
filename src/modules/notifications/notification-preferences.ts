export const notificationPreferenceKeys = [
  'activity',
  'general',
  'marketing',
  'security',
  'courseReminders',
  'aiCourseCompletion',
  'weeklyProgressSummary',
] as const;

export type NotificationPreferenceKey =
  (typeof notificationPreferenceKeys)[number];

export type NotificationPreferences = Record<NotificationPreferenceKey, boolean>;

export const shopYethuNotificationPreferenceKeys = [
  'orderUpdates',
  'sellerUpdates',
  'accountSecurityAlerts',
] as const;

export type ShopYethuNotificationPreferenceKey =
  (typeof shopYethuNotificationPreferenceKeys)[number];

export type ShopYethuNotificationPreferences = Record<
  ShopYethuNotificationPreferenceKey,
  boolean
>;

export const defaultNotificationPreferences: NotificationPreferences = {
  activity: false,
  general: false,
  marketing: false,
  security: true,
  courseReminders: true,
  aiCourseCompletion: true,
  weeklyProgressSummary: false,
};

export const defaultShopYethuNotificationPreferences: ShopYethuNotificationPreferences = {
  orderUpdates: true,
  sellerUpdates: true,
  accountSecurityAlerts: true,
};

export function normalizeNotificationPreferences(
  value: unknown,
): NotificationPreferences {
  const source =
    value && typeof value === 'object'
      ? (value as Partial<Record<NotificationPreferenceKey, unknown>>)
      : {};

  return notificationPreferenceKeys.reduce<NotificationPreferences>(
    (prefs, key) => ({
      ...prefs,
      [key]:
        typeof source[key] === 'boolean'
          ? Boolean(source[key])
          : defaultNotificationPreferences[key],
    }),
    { ...defaultNotificationPreferences },
  );
}

export function normalizeShopYethuNotificationPreferences(
  value: unknown,
): ShopYethuNotificationPreferences {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<Record<ShopYethuNotificationPreferenceKey, unknown>>)
      : {};

  return shopYethuNotificationPreferenceKeys.reduce<ShopYethuNotificationPreferences>(
    (prefs, key) => ({
      ...prefs,
      [key]:
        typeof source[key] === 'boolean'
          ? Boolean(source[key])
          : defaultShopYethuNotificationPreferences[key],
    }),
    { ...defaultShopYethuNotificationPreferences },
  );
}

export function sanitizePreferencePatch(value: unknown) {
  const source =
    value && typeof value === 'object'
      ? (value as Partial<Record<NotificationPreferenceKey, unknown>>)
      : {};

  return notificationPreferenceKeys.reduce<
    Partial<Record<NotificationPreferenceKey, boolean>>
  >((patch, key) => {
    if (typeof source[key] === 'boolean') {
      patch[key] = Boolean(source[key]);
    }

    return patch;
  }, {});
}

export function sanitizeShopYethuPreferencePatch(value: unknown) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<Record<ShopYethuNotificationPreferenceKey, unknown>>)
      : {};

  return shopYethuNotificationPreferenceKeys.reduce<
    Partial<Record<ShopYethuNotificationPreferenceKey, boolean>>
  >((patch, key) => {
    if (typeof source[key] === 'boolean') {
      patch[key] = Boolean(source[key]);
    }

    return patch;
  }, {});
}
