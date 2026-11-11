// Shared helpers for BarFlow server
export const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

export function nowISO() {
  return new Date().toISOString();
}

/** YYYY-MM-DD in the bar's local timezone. */
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** YYYY-MM-DD for any Date/ISO string in the bar's local timezone. */
export function localDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function localTime(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** Round money to 2 decimals without float drift. */
export function money(n) {
  const v = Number(n) || 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function firstOfMonth(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

/** Simple human readable error with an HTTP status. */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
