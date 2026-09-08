import VehicleType from "../models/vehicle-type.model";
import { cache } from "../utils/redis.util";

/**
 * City-aware pricing for a vehicle type.
 *
 * Rates used to be one global number per vehicle type. The client operates in
 * several cities with genuinely different economics (Pune ≠ Mumbai ≠ Nagpur),
 * so a vehicle type now carries:
 *   - its DEFAULT rates (the top-level baseFare / perKmRate / … fields), and
 *   - optional `cityOverrides` rows, each naming one or more cities and any
 *     subset of the rate fields to override there.
 *
 * Resolution is one lookup: find the first active override row whose city
 * list matches the booking's pickup city; every field it leaves blank falls
 * through to the default. Nothing else in the fare engine needs to know a
 * city exists — it just receives the resolved rate card.
 *
 * Same mechanism carries the three per-vehicle values the client asked to
 * move OFF the global Commission & Charges page: minimum fare, free waiting
 * minutes and driver commission. Each is nullable on the vehicle type; null
 * means "use the global FareConfig value", so nothing changes for a type the
 * admin hasn't touched.
 */

export interface CityOverride {
  cities: string[];
  baseFare?: number | null;
  perKmRate?: number | null;
  perMinuteRate?: number | null;
  minimumFare?: number | null;
  freeWaitingMinutes?: number | null;
  commissionPercent?: number | null;
  isActive?: boolean;
}

export interface EffectiveRates {
  baseFare: number;
  perKmRate: number;
  perMinuteRate: number;
  minimumFare: number;
  freeWaitingMinutes: number;
  commissionPercent: number;
  /** Where the card came from — surfaced in quotes so ops can see it. */
  rateSource: "DEFAULT" | "CITY";
  /** The configured city label that matched, when rateSource is CITY. */
  rateCity?: string;
}

/** A finite number, or undefined for null / "" / NaN — so `??` can fall through. */
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** "Delhi NCR" → "delhi ncr"; strips punctuation so "Navi-Mumbai" matches "Navi Mumbai". */
export const normalizeCity = (s?: string | null): string =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const cityTokens = (s: string): string[] =>
  normalizeCity(s)
    .split(" ")
    .filter((t) => t.length >= 4);

/**
 * Does an admin-configured city label apply to a resolved pickup city?
 *
 * Reverse geocoding returns whatever the map provider calls the place —
 * "New Delhi", "Pune City", "Navi Mumbai" — while the admin types what the
 * business calls it. Exact match first; then containment either way; then a
 * shared meaningful token ("delhi" in both "Delhi NCR" and "New Delhi").
 * Tokens under 4 letters are ignored so "New" or "City" can't cause a hit.
 */
export const cityMatches = (configured: string, resolved: string): boolean => {
  const a = normalizeCity(configured);
  const b = normalizeCity(resolved);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const bt = new Set(cityTokens(b));
  return cityTokens(a).some((t) => bt.has(t));
};

/**
 * The rate card to price a trip with. Pure: pass the vehicle type document,
 * the active FareConfig (for global fallbacks) and the pickup city (or null).
 */
export const resolveRates = (
  vehicleType: any,
  fareConfig: any,
  city?: string | null,
): EffectiveRates => {
  const base: EffectiveRates = {
    baseFare: num(vehicleType?.baseFare) ?? 0,
    perKmRate: num(vehicleType?.perKmRate) ?? 0,
    perMinuteRate: num(vehicleType?.perMinuteRate) ?? 0,
    minimumFare:
      num(vehicleType?.minimumFare) ?? num(fareConfig?.minimumFare) ?? 50,
    freeWaitingMinutes:
      num(vehicleType?.freeWaitingMinutes) ??
      num(fareConfig?.freeWaitingMinutes) ??
      10,
    commissionPercent:
      num(vehicleType?.commissionPercent) ??
      num(fareConfig?.driverCommissionPercent) ??
      20,
    rateSource: "DEFAULT",
  };

  if (!city) return base;

  const rows: CityOverride[] = Array.isArray(vehicleType?.cityOverrides)
    ? vehicleType.cityOverrides
    : [];
  const hit = rows.find(
    (r) =>
      r &&
      r.isActive !== false &&
      Array.isArray(r.cities) &&
      r.cities.some((c) => cityMatches(c, city)),
  );
  if (!hit) return base;

  const matchedLabel =
    hit.cities.find((c) => cityMatches(c, city)) ?? hit.cities[0];

  return {
    baseFare: num(hit.baseFare) ?? base.baseFare,
    perKmRate: num(hit.perKmRate) ?? base.perKmRate,
    perMinuteRate: num(hit.perMinuteRate) ?? base.perMinuteRate,
    minimumFare: num(hit.minimumFare) ?? base.minimumFare,
    freeWaitingMinutes: num(hit.freeWaitingMinutes) ?? base.freeWaitingMinutes,
    commissionPercent: num(hit.commissionPercent) ?? base.commissionPercent,
    rateSource: "CITY",
    rateCity: matchedLabel,
  };
};

/**
 * Whether ANY vehicle type has a city override at all. When none do, the
 * whole city machinery is skipped — no reverse geocoding, no lookups — so
 * introducing the feature costs nothing until an admin actually uses it.
 * Cached briefly; an admin adding the first override is live within a minute.
 */
export const anyCityOverridesConfigured = async (): Promise<boolean> => {
  const key = "vehicle-types:city-overrides-exist";
  const cached = await cache.get<string>(key);
  if (cached === "1") return true;
  if (cached === "0") return false;
  const exists = await VehicleType.exists({
    isDeleted: { $ne: true },
    "cityOverrides.0": { $exists: true },
  });
  await cache.set(key, exists ? "1" : "0", 60);
  return !!exists;
};

/**
 * City name for a coordinate, via OpenStreetMap's Nominatim — the same
 * provider the customer app already searches addresses with. Results are
 * cached per ~1 km cell for a week (Nominatim asks for ≤1 request/second and
 * for results to be cached; the cell key makes repeat quotes from one
 * neighbourhood free). A failure caches a miss for an hour so a provider
 * outage cannot turn every quote into a 4-second stall.
 */
export const resolveCityFromCoords = async (
  lat: number,
  lng: number,
): Promise<string | null> => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;

  const key = `geo:city:${lat.toFixed(2)}:${lng.toFixed(2)}`;
  const cached = await cache.get<string>(key);
  if (cached) return cached === "-" ? null : cached;

  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
      `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}` +
      `&zoom=10&addressdetails=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Movezy/1.0 (fare city resolver)",
        "Accept-Language": "en",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const body: any = await res.json();
    const a = body?.address || {};
    const city: string | null =
      a.city ||
      a.town ||
      a.city_district ||
      a.municipality ||
      a.county ||
      a.state_district ||
      a.village ||
      null;
    await cache.set(key, city || "-", 7 * 24 * 3600);
    return city;
  } catch (err) {
    console.warn("[vehicle-rate] reverse geocode failed:", (err as Error).message);
    await cache.set(key, "-", 3600);
    return null;
  }
};

/**
 * The city a booking should be priced for.
 *
 * Prefers what the app sends (`pickup.city`, captured from the device's own
 * geocoder when the customer picks the address). Falls back to reverse
 * geocoding the pickup coordinates — but only once an admin has configured at
 * least one city override, so older app builds and a plain single-city
 * deployment never pay for a lookup they can't use.
 */
export const resolveBookingCity = async (
  pickup:
    | { city?: string | null; lat?: number | string; lng?: number | string }
    | null
    | undefined,
): Promise<string | null> => {
  const sent = String(pickup?.city || "").trim();
  if (sent) return sent;
  if (!(await anyCityOverridesConfigured())) return null;
  return resolveCityFromCoords(Number(pickup?.lat), Number(pickup?.lng));
};
