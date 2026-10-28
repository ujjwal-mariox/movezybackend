/**
 * Movezy runs in India: every "hour of the day" the server reasons about —
 * surge windows ("Night 10 PM–6 AM"), pickup time slots, "today" in reports,
 * document-expiry days — and every time it prints on an invoice or export is
 * meant in IST. The host (Render) runs in UTC, so before this the night surge
 * applied 3:30–11:30 AM IST and invoices printed 05:36 for an 11:06 trip.
 *
 * Imported FIRST in server.ts so it is in force before any date is handled.
 * Stored timestamps are unaffected: a Date is an absolute instant; only the
 * local-time views (getHours, setHours, toLocaleString) follow this zone.
 */
export const APP_TIMEZONE = "Asia/Kolkata";

process.env.TZ = APP_TIMEZONE;

/** IST has no daylight saving, so the offset is fixed. */
const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * The same instant shifted so its UTC fields read as IST wall-clock time —
 * for writers (like exceljs) that always serialise a Date as UTC.
 */
export const asIstWallClock = (d: Date): Date => new Date(d.getTime() + IST_OFFSET_MS);

/** "2026-10-14 11:06" in IST. */
export const formatIstDateTime = (d: Date): string =>
  asIstWallClock(d).toISOString().replace("T", " ").slice(0, 16);
