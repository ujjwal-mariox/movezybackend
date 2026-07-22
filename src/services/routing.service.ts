import { cache } from "../utils/redis.util";

/**
 * Road routing.
 *
 * Every map in both apps drew a straight line between pickup and drop, because
 * nothing ever asked for an actual route — and `distanceKm` is a haversine
 * straight-line figure for the same reason.
 *
 * This calls OSRM (the public demo router: no API key, OSM data, same source
 * as the map tiles the apps already render) and caches results, so a route is
 * fetched once per coordinate pair rather than on every map open.
 *
 * Deliberately non-fatal: if the router is unreachable or rate-limited, this
 * returns null and callers fall back to the straight line rather than failing
 * the screen.
 */

const OSRM_BASE =
  process.env.OSRM_URL?.replace(/\/$/, "") || "https://router.project-osrm.org";

/** Coordinates rounded to ~11m, so tiny GPS jitter still hits the same cache key. */
const keyFor = (
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
) =>
  `route:${fromLat.toFixed(4)},${fromLng.toFixed(4)}:${toLat.toFixed(
    4,
  )},${toLng.toFixed(4)}`;

export interface RoadRoute {
  /** [lat, lng] pairs along the road, ready to draw as a polyline. */
  coordinates: [number, number][];
  /** Real road distance in km (not straight-line). */
  distanceKm: number;
  /** Router's duration estimate in minutes. */
  durationMin: number;
  /** "osrm" when routed, "straight" when we fell back. */
  source: "osrm" | "straight";
}

export const getRoute = async (
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): Promise<RoadRoute | null> => {
  if (
    !Number.isFinite(fromLat) ||
    !Number.isFinite(fromLng) ||
    !Number.isFinite(toLat) ||
    !Number.isFinite(toLng) ||
    (fromLat === 0 && fromLng === 0) ||
    (toLat === 0 && toLng === 0)
  ) {
    return null;
  }

  const cacheKey = keyFor(fromLat, fromLng, toLat, toLng);
  try {
    const cached = await cache.get<RoadRoute>(cacheKey);
    if (cached) return cached;
  } catch {
    // Cache unavailable — carry on and fetch live.
  }

  const url =
    `${OSRM_BASE}/route/v1/driving/` +
    `${fromLng},${fromLat};${toLng},${toLat}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=false`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return null;
    const body: any = await res.json();
    const route = body?.routes?.[0];
    const line = route?.geometry?.coordinates;
    if (!Array.isArray(line) || line.length < 2) return null;

    const result: RoadRoute = {
      // OSRM returns [lng, lat]; the apps draw [lat, lng].
      coordinates: line.map((c: number[]) => [c[1], c[0]] as [number, number]),
      distanceKm: Math.round((Number(route.distance || 0) / 1000) * 100) / 100,
      durationMin: Math.round(Number(route.duration || 0) / 60),
      source: "osrm",
    };

    try {
      // Roads don't move; a day is plenty and keeps us well inside the public
      // router's fair-use limits.
      await cache.set(cacheKey, result, 86400);
    } catch {
      /* cache write is best-effort */
    }

    return result;
  } catch {
    // Timeout, network error, or rate limit — the caller falls back.
    return null;
  }
};

/**
 * Road distance/duration across an ordered list of waypoints (pickup, any
 * stops, drop). Each leg uses the routed road figure; a leg the router can't
 * resolve falls back to haversine + a 25 km/h duration estimate, so a router
 * outage degrades gracefully instead of failing the quote.
 */

/**
 * Straight-line km inflated to approximate road distance.
 *
 * Roads don't run as the crow flies. The fare code has always applied 1.3 for
 * this, and the fallback keeps it: without the factor, a router outage would
 * quote every trip ~23% short of what the old code charged.
 */
const ROAD_FACTOR = 1.3;
const haversineKm = (
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number => {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Average city speed the fare code has always billed time against. OSRM's own
 * duration is free-flow — it assumes empty roads — and for Delhi CP → Noida it
 * says 27 minutes where this model says 63. Taking the router's figure would
 * have cut the time charge by roughly a sixth and shown customers an ETA no
 * Indian city trip actually achieves, so duration stays on this model. What
 * changed is the input: it now runs on real road km instead of a guess.
 */
const CITY_SPEED_KMPH = 25;

export interface LegsResult {
  distanceKm: number;
  /** Billing/ETA duration: road distance at CITY_SPEED_KMPH. */
  durationMin: number;
  /** The router's free-flow estimate, for reference. Null if nothing routed. */
  routedDurationMin: number | null;
  /** "osrm" when every leg was road-routed; "mixed" or "straight" otherwise. */
  source: "osrm" | "mixed" | "straight";
}

export const getDistanceForLegs = async (
  legs: { lat: number; lng: number }[],
): Promise<LegsResult | null> => {
  const clean = (legs || []).filter(
    (l) =>
      l &&
      Number.isFinite(Number(l.lat)) &&
      Number.isFinite(Number(l.lng)) &&
      !(Number(l.lat) === 0 && Number(l.lng) === 0),
  );
  if (clean.length < 2) return null;

  let km = 0;
  let routedMin = 0;
  let routed = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    const a = clean[i];
    const b = clean[i + 1];
    const route = await getRoute(
      Number(a.lat),
      Number(a.lng),
      Number(b.lat),
      Number(b.lng),
    );
    if (route) {
      km += route.distanceKm;
      routedMin += route.durationMin;
      routed++;
    } else {
      km +=
        haversineKm(
          Number(a.lat),
          Number(a.lng),
          Number(b.lat),
          Number(b.lng),
        ) * ROAD_FACTOR;
    }
  }

  const totalLegs = clean.length - 1;
  const distanceKm = Math.round(km * 100) / 100;
  return {
    distanceKm,
    durationMin: Math.max(5, Math.ceil((distanceKm / CITY_SPEED_KMPH) * 60)),
    routedDurationMin: routed > 0 ? Math.max(1, Math.round(routedMin)) : null,
    source:
      routed === totalLegs ? "osrm" : routed > 0 ? "mixed" : "straight",
  };
};
