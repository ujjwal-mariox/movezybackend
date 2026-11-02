import { Router } from "express";

import ErrorHandlerMiddleware from "../middlewares/error-handler.middleware";
import ResponseMiddleware from "../middlewares/response.middleware";
import AuthMiddleware from "../middlewares/auth.middleware";
import {
  autocompletePlaces,
  getPlaceDetails,
  isGoogleMapsConfigured,
  reverseGeocode,
} from "../services/google-maps.service";

/**
 * Address search for the customer app, proxied so the Google key stays on
 * the server and only signed-in customers can spend it.
 *
 * Without GOOGLE_MAPS_API_KEY these answer from OpenStreetMap's free Nominatim
 * (what the app called directly before), so the screens keep working until
 * the key is set. Nominatim's policy forbids that for production traffic.
 *
 * Fallback suggestions carry their coordinates in the id ("geo:lat,lng"), so
 * /place resolves them without a second lookup.
 */
const router = Router();
router.use(AuthMiddleware().verifyUserToken);

const NOMINATIM = "https://nominatim.openstreetmap.org";
const nominatimHeaders = {
  "User-Agent": "Movezy/1.0 (address search fallback)",
  "Accept-Language": "en",
};

const num = (v: any): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : undefined;
};

// GET /maps/autocomplete?q=phoenix mall&session=<token>&lat=18.5&lng=73.8
router.get(
  "/autocomplete",
  ErrorHandlerMiddleware(async (req: any, res: any) => {
    const q = String(req.query.q || "").trim().slice(0, 120);
    // Google: URL-safe base64, at most 36 characters.
    const session = String(req.query.session || "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 36);
    const lat = num(req.query.lat);
    const lng = num(req.query.lng);
    const near = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;

    if (q.length < 3) {
      res.locals.data = { suggestions: [] };
      return;
    }

    if (isGoogleMapsConfigured()) {
      const suggestions = await autocompletePlaces(q, session, near);
      res.locals.data = { suggestions: suggestions || [], source: "google" };
      return;
    }

    let suggestions: { placeId: string; title: string; subtitle: string }[] = [];
    try {
      const qs = new URLSearchParams({
        q,
        format: "jsonv2",
        limit: "5",
        countrycodes: "in",
      });
      const r = await fetch(`${NOMINATIM}/search?${qs}`, {
        headers: nominatimHeaders,
        signal: AbortSignal.timeout(6000),
      });
      const list: any[] = r.ok ? await r.json() : [];
      suggestions = list.map((item) => {
        const [title, ...rest] = String(item.display_name || "").split(", ");
        return {
          placeId: `geo:${item.lat},${item.lon}`,
          title,
          subtitle: rest.join(", "),
        };
      });
    } catch {
      /* empty list */
    }
    res.locals.data = { suggestions, source: "osm" };
  }),
  ResponseMiddleware,
);

// GET /maps/place/:placeId?session=<token> → { lat, lng, address }
router.get(
  "/place/:placeId",
  ErrorHandlerMiddleware(async (req: any, res: any) => {
    const placeId = String(req.params.placeId || "").slice(0, 300);
    const session = String(req.query.session || "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 36);

    if (placeId.startsWith("geo:")) {
      const [lat, lng] = placeId.slice(4).split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const rev = await reverseGeocode(lat, lng);
        res.locals.data = { place: { lat, lng, address: rev?.address || "" } };
        return;
      }
    }

    const place = await getPlaceDetails(placeId, session);
    if (!place) {
      return res
        .status(404)
        .json({ success: false, message: "Place not found" });
    }
    res.locals.data = { place };
  }),
  ResponseMiddleware,
);

// GET /maps/reverse?lat=18.52&lng=73.85 → { address, city, state, postcode }
router.get(
  "/reverse",
  ErrorHandlerMiddleware(async (req: any, res: any) => {
    const lat = num(req.query.lat);
    const lng = num(req.query.lng);
    if (lat === undefined || lng === undefined) {
      return res
        .status(400)
        .json({ success: false, message: "lat and lng are required" });
    }

    const google = await reverseGeocode(lat, lng);
    if (google) {
      res.locals.data = { ...google, source: "google" };
      return;
    }

    let result = {
      address: "",
      city: null as string | null,
      state: null as string | null,
      postcode: null as string | null,
    };
    try {
      const qs = new URLSearchParams({
        lat: String(lat),
        lon: String(lng),
        format: "jsonv2",
        addressdetails: "1",
      });
      const r = await fetch(`${NOMINATIM}/reverse?${qs}`, {
        headers: nominatimHeaders,
        signal: AbortSignal.timeout(6000),
      });
      const body: any = r.ok ? await r.json() : {};
      const a = body?.address || {};
      result = {
        address: body?.display_name || "",
        city: a.city || a.town || a.city_district || a.county || null,
        state: a.state || null,
        postcode: a.postcode || null,
      };
    } catch {
      /* empty result */
    }
    res.locals.data = { ...result, source: "osm" };
  }),
  ResponseMiddleware,
);

export default router;
