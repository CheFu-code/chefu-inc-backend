export function sharedGender(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= 80
    ? value.trim()
    : undefined;
}
