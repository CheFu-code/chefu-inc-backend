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

export const defaultNotificationPreferences: NotificationPreferences = {
  activity: false,
  general: false,
  marketing: false,
  security: true,
  courseReminders: true,
  aiCourseCompletion: true,
  weeklyProgressSummary: false,
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
