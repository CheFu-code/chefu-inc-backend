import { BadRequestException } from "@nestjs/common";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Invalid payload.");
  return value as Record<string, unknown>;
}
export function text(
  value: unknown,
  label: string,
  max: number,
  optional = false,
): string {
  if (optional && value === undefined) return "";
  if (
    typeof value !== "string" ||
    (!optional && !value.trim()) ||
    value.trim().length > max
  )
    throw new BadRequestException(`Invalid ${label}.`);
  return value.trim();
}
export function number(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new BadRequestException(`Invalid ${label}.`);
  return value;
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new BadRequestException("Invalid ID.");
  return value;
}
export function date(value: unknown): string {
  const match =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
          value,
        )
      : null;
  if (
    !match ||
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value))
  )
    throw new BadRequestException("Invalid date.");
  const month = Number(match[2]),
    day = Number(match[3]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate()
  )
    throw new BadRequestException("Invalid date.");
  return new Date(value).toISOString();
}
export function range(start: unknown, end: unknown, maxDays: number) {
  const from = date(start),
    to = date(end);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > maxDays * 86_400_000 + 7_200_000)
    throw new BadRequestException("Invalid date range.");
  return { start: from, end: to };
}
export function limit(value?: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new BadRequestException("Invalid limit.");
  return number(Number(value), "limit", 1, 100);
}

export function reminder(value: unknown) {
  const input = object(value);
  if (typeof input.enabled !== "boolean") throw new BadRequestException("Invalid reminder setting.");
  const output: { enabled: boolean; hour: number; minute: number; days?: number[]; sound?: boolean; restAlerts?: boolean } = {
    enabled: input.enabled,
    hour: number(input.hour, "reminder hour", 0, 23),
    minute: number(input.minute, "reminder minute", 0, 59),
  };
  if (input.days !== undefined) {
    if (!Array.isArray(input.days) || input.days.length > 7 || (input.enabled && input.days.length === 0)) throw new BadRequestException("Choose at least one training day.");
    const days = input.days.map(day => number(day, "training day", 1, 7));
    if (new Set(days).size !== days.length) throw new BadRequestException("Duplicate training day.");
    output.days = days.sort((a, b) => a - b);
  }
  for (const key of ["sound", "restAlerts"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new BadRequestException("Invalid notification preference.");
      output[key] = input[key];
    }
  }
  return output;
}
