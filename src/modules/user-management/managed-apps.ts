import { CHEFU_APPS } from "../apps/app-registry";

export function managedApps(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .flatMap(([id, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const app = raw as Record<string, unknown>;
      return [
        {
          id,
          name:
            CHEFU_APPS.find((registered) => registered.id === id)?.name || id,
          enabled: app.enabled !== false,
          firstSeenAt: appDate(app.firstSeenAt),
          lastSeenAt: appDate(app.lastSeenAt),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function appDate(value: unknown): string | null {
  try {
    const date =
      value &&
      typeof value === "object" &&
      "toDate" in value &&
      typeof value.toDate === "function"
        ? value.toDate()
        : typeof value === "string"
          ? new Date(value)
          : value instanceof Date
            ? value
            : null;
    return date instanceof Date && Number.isFinite(date.getTime())
      ? date.toISOString()
      : null;
  } catch {
    return null;
  }
}
