import config from "../config";
import { cache } from "../utils/redis.util";

/**
 * Google Maps Platform, server side: road routes (Routes API), address search
 * (Places API (New) Autocomplete + Place Details) and reverse geocoding
 * (Geocoding API). One key, GOOGLE_MAPS_API_KEY, restricted to this server.
 *
 * Only the current APIs are used: Distance Matrix, Directions and Places
 * (legacy) can't be enabled on Cloud projects created after 1 March 2025.
 *
 * Without a key every function returns null and callers fall back to the free
 * OpenStreetMap services, so nothing breaks before the key arrives.
 * Every function is non-throwing: maps support a screen, they never fail it.
 */

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES_URL = "https://places.googleapis.com/v1";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

const apiKey = (): string => config.maps.apiKey || "";
export const isGoogleMapsConfigured = (): boolean => Boolean(apiKey());

/** Google's encoded polyline → [lat, lng] pairs (the apps draw [lat, lng]). */
export const decodePolyline = (encoded: string): [number, number][] => {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      // Past the end charCodeAt is NaN, which ends the loop: bad input
      // can't spin forever.
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
};

const logFailure = async (what: string, res: Response) => {
  let detail = "";
  try {
    const body: any = await res.json();
    detail = body?.error?.message || body?.error_message || body?.status || "";
  } catch {
    /* no body */
  }
  console.warn(`[maps] Google ${what} failed: HTTP ${res.status} ${detail}`);
};

export interface GoogleRoute {
  distanceMeters: number;
  durationSec: number;
  /** [lat, lng] pairs; empty when the polyline wasn't requested. */
  points: [number, number][];
}

/**
 * Road route through the given points (origin, any stops, destination).
 * `traffic` asks for live-traffic duration (a pricier SKU — ETA only);
 * fares use the traffic-free route, which is what's billed by distance.
 */
export const computeRoute = async (
  points: { lat: number; lng: number }[],
  opts: { traffic?: boolean; polyline?: boolean } = {},
): Promise<GoogleRoute | null> => {
  if (!apiKey() || points.length < 2) return null;
  const wp = (p: { lat: number; lng: number }) => ({
    location: { latLng: { latitude: p.lat, longitude: p.lng } },
  });
  const body: Record<string, any> = {
    origin: wp(points[0]),
    destination: wp(points[points.length - 1]),
    travelMode: "DRIVE",
    routingPreference: opts.traffic ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE",
  };
  if (points.length > 2) body.intermediates = points.slice(1, -1).map(wp);
  const fieldMask = [
    "routes.distanceMeters",
    "routes.duration",
    ...(opts.polyline === false ? [] : ["routes.polyline.encodedPolyline"]),
  ].join(",");

  try {
    const res = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey(),
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      await logFailure("route", res);
      return null;
    }
    const data: any = await res.json();
    const route = data?.routes?.[0];
    if (!route) return null; // no road route between the points
    const encoded = route.polyline?.encodedPolyline;
    return {
      distanceMeters: Number(route.distanceMeters || 0),
      // Duration comes as a string of seconds, e.g. "165s".
      durationSec: parseInt(String(route.duration || "0"), 10) || 0,
      points: encoded ? decodePolyline(encoded) : [],
    };
  } catch (err: any) {
    console.warn(`[maps] Google route failed: ${err?.message || err}`);
    return null;
  }
};

export interface PlaceSuggestion {
  placeId: string;
  /** e.g. "Phoenix Marketcity" */
  title: string;
  /** e.g. "Viman Nagar, Pune, Maharashtra, India" */
  subtitle: string;
}

/**
 * Address suggestions while the user types (India only, biased to `near`).
 * One sessionToken per search, reused by the Place Details call that ends
 * it — Google bills the whole session as one.
 */
export const autocompletePlaces = async (
  input: string,
  sessionToken: string,
  near?: { lat: number; lng: number },
): Promise<PlaceSuggestion[] | null> => {
  if (!apiKey()) return null;
  const body: Record<string, any> = {
    input,
    includedRegionCodes: ["in"],
    languageCode: "en",
  };
  if (sessionToken) body.sessionToken = sessionToken;
  if (near) {
    body.locationBias = {
      circle: {
        center: { latitude: near.lat, longitude: near.lng },
        radius: 30000,
      },
    };
  }
  try {
    const res = await fetch(`${PLACES_URL}/places:autocomplete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey(),
        "X-Goog-FieldMask": [
          "suggestions.placePrediction.placeId",
          "suggestions.placePrediction.text.text",
          "suggestions.placePrediction.structuredFormat.mainText.text",
          "suggestions.placePrediction.structuredFormat.secondaryText.text",
        ].join(","),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      await logFailure("autocomplete", res);
      return null;
    }
    const data: any = await res.json();
    return (data?.suggestions || [])
      .map((s: any) => s?.placePrediction)
      .filter((p: any) => p?.placeId)
      .map((p: any) => ({
        placeId: String(p.placeId),
        title: p.structuredFormat?.mainText?.text || p.text?.text || "",
        subtitle: p.structuredFormat?.secondaryText?.text || "",
      }));
  } catch (err: any) {
    console.warn(`[maps] Google autocomplete failed: ${err?.message || err}`);
    return null;
  }
};

export interface PlaceLocation {
  lat: number;
  lng: number;
  address: string;
}

/** Coordinates + full address of a suggestion. Only Essentials-SKU fields. */
export const getPlaceDetails = async (
  placeId: string,
  sessionToken?: string,
): Promise<PlaceLocation | null> => {
  if (!apiKey()) return null;
  const cacheKey = `maps:place:${placeId}`;
  try {
    const cached = await cache.get<PlaceLocation>(cacheKey);
    if (cached) return cached;
  } catch {
    /* cache is best-effort */
  }
  const qs = new URLSearchParams({ languageCode: "en" });
  if (sessionToken) qs.set("sessionToken", sessionToken);
  try {
    const res = await fetch(
      `${PLACES_URL}/places/${encodeURIComponent(placeId)}?${qs}`,
      {
        headers: {
          "X-Goog-Api-Key": apiKey(),
          "X-Goog-FieldMask": "location,formattedAddress",
        },
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!res.ok) {
      await logFailure("place details", res);
      return null;
    }
    const data: any = await res.json();
    const lat = Number(data?.location?.latitude);
    const lng = Number(data?.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const result = { lat, lng, address: data?.formattedAddress || "" };
    try {
      await cache.set(cacheKey, result, 7 * 24 * 3600);
    } catch {
      /* best-effort */
    }
    return result;
  } catch (err: any) {
    console.warn(`[maps] Google place details failed: ${err?.message || err}`);
    return null;
  }
};

export interface ReverseResult {
  address: string;
  city: string | null;
  state: string | null;
  /** 6-digit PIN code. */
  postcode: string | null;
}

/** Address, city, state and PIN code at a point (Geocoding API). */
export const reverseGeocode = async (
  lat: number,
  lng: number,
): Promise<ReverseResult | null> => {
  if (!apiKey()) return null;
  // ~11 m grid: a pin nudged by a hair doesn't cost another lookup.
  const cacheKey = `maps:rev:${lat.toFixed(4)},${lng.toFixed(4)}`;
  try {
    const cached = await cache.get<ReverseResult>(cacheKey);
    if (cached) return cached;
  } catch {
    /* best-effort */
  }
  const qs = new URLSearchParams({
    latlng: `${lat},${lng}`,
    language: "en",
    region: "in",
    key: apiKey(),
  });
  try {
    const res = await fetch(`${GEOCODE_URL}?${qs}`, {
      signal: AbortSignal.timeout(6000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || (data?.status !== "OK" && data?.status !== "ZERO_RESULTS")) {
      console.warn(
        `[maps] Google reverse geocode failed: HTTP ${res.status} ${data?.status || ""} ${
          data?.error_message || ""
        }`,
      );
      return null;
    }
    const results: any[] = data?.results || [];
    const component = (type: string): string | null => {
      for (const r of results) {
        const c = (r.address_components || []).find((ac: any) =>
          (ac.types || []).includes(type),
        );
        if (c?.long_name) return c.long_name;
      }
      return null;
    };
    const result: ReverseResult = {
      address: results[0]?.formatted_address || "",
      city: component("locality") || component("administrative_area_level_2"),
      state: component("administrative_area_level_1"),
      postcode: component("postal_code"),
    };
    try {
      await cache.set(cacheKey, result, 7 * 24 * 3600);
    } catch {
      /* best-effort */
    }
    return result;
  } catch (err: any) {
    console.warn(`[maps] Google reverse geocode failed: ${err?.message || err}`);
    return null;
  }
};
