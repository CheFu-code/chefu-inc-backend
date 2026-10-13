import { BadRequestException } from '@nestjs/common';

export type ScheduleRule = { frequency: 'daily' | 'weekly'; time: string; weekday?: string };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function nextRunAt(rule: ScheduleRule, timezone: string, after = new Date()): string {
  if (!rule || !['daily', 'weekly'].includes(rule.frequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)
    || (rule.frequency === 'weekly' && !DAYS.includes(rule.weekday || ''))) {
    throw new BadRequestException('Invalid schedule rule.');
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23' });
  } catch { throw new BadRequestException('Invalid schedule timezone.'); }
  // Iterate actual instants so nonexistent DST times are skipped and offsets
  // never depend on the server's local timezone.
  const start = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (let minute = 0; minute < 8 * 24 * 60; minute++) {
    const instant = new Date(start + minute * 60000);
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    if (`${parts.hour}:${parts.minute}` === rule.time && (rule.frequency === 'daily' || parts.weekday.toLowerCase() === rule.weekday)) {
      return instant.toISOString();
    }
  }
  throw new BadRequestException('Unable to resolve schedule time.');
}
