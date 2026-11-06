/**
 * Calendar-date helpers for due dates (plan.md 5.1). Dates are "YYYY-MM-DD"
 * strings with no time zone, so a due date never shifts with the server's clock.
 */
export type IsoDate = string;

function parse(date: IsoDate): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Expected YYYY-MM-DD, got "${date}"`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function format(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Adds whole months, keeping the anchor day where it exists and using the
 * month's last day where it does not (Jan 31 + 1 month = Feb 28 or 29).
 */
export function addMonths(date: IsoDate, months: number, anchorDay?: number): IsoDate {
  const { y, m, d } = parse(date);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(year, month));
  return format(year, month, day);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const { y, m, d } = parse(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parse(from);
  const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

export function dayOfMonth(date: IsoDate): number {
  return parse(date).d;
}
