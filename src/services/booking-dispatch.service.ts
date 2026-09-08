/**
 * Booking Dispatch Service
 * Handles finding nearby drivers, sending booking requests (bell ringing),
 * and managing the auto-close mechanism when one driver accepts.
 */

import { Types } from "mongoose";
import Booking from "../models/booking.model";
import Driver from "../models/driver.model";
import DriverVehicle from "../models/driver-vehicle.model";
import { getRedisClient, cache } from "../utils/redis.util";
import { getIO, emitToUser, emitToBooking } from "../utils/socket.util";
import * as mqttUtil from "../utils/mqtt.util";
import * as notificationService from "./notification.service";
import { presentPhone } from "./call-masking.service";
import {
  getTrainingGateStatus,
  hasMandatoryTraining,
} from "./training-gate.service";

// Redis keys
const BOOKING_DRIVERS_KEY = "booking:drivers:"; // booking:drivers:{bookingId} -> Set of driver IDs
const DRIVER_PENDING_BOOKING_KEY = "driver:pending:"; // driver:pending:{driverId} -> booking ID
const BOOKING_TIMEOUT_KEY = "booking:timeout:"; // booking:timeout:{bookingId} -> expiry timestamp

// Configuration
const DRIVER_SEARCH_RADIUS_KM = 5; // Initial search radius
const MAX_SEARCH_RADIUS_KM = 15; // Max search radius
const RADIUS_INCREMENT_KM = 3; // Increase radius by this amount
const BOOKING_REQUEST_TIMEOUT_SECONDS = 30; // Time for drivers to accept
const MAX_DRIVERS_TO_NOTIFY = 25; // Length of the nearest-first queue per radius step

interface NearbyDriver {
  driverId: string;
  distance: number;
  lat: number;
  lng: number;
}

interface BookingDispatchResult {
  success: boolean;
  driversNotified: number;
  driverIds: string[];
  message: string;
}

/** A driver the geo layer says is near the pickup, before any filtering. */
interface GeoCandidate {
  driverId: string;
  distanceKm: number;
  lat: number;
  lng: number;
}

/** Great-circle distance in km — used by the Mongo fallback, which (unlike
 *  Redis GEOSEARCH) does not hand back the distance it matched on. */
const haversineKm = (
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number => {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

/**
 * Candidates from the Redis geo set. Throws if Redis is unavailable — the
 * caller decides what to do about that.
 */
const candidatesFromRedis = async (
  pickupLat: number,
  pickupLng: number,
  radiusKm: number,
): Promise<GeoCandidate[]> => {
  const redis = getRedisClient();
  const rows = await redis.geoSearchWith(
    "driver:locations",
    { longitude: pickupLng, latitude: pickupLat },
    { radius: radiusKm, unit: "km" },
    ["WITHDIST", "WITHCOORD"],
  );
  return (rows || []).map((r) => ({
    driverId: String(r.member),
    distanceKm: parseFloat(String(r.distance ?? 0)),
    lat: r.coordinates?.latitude ? Number(r.coordinates.latitude) : 0,
    lng: r.coordinates?.longitude ? Number(r.coordinates.longitude) : 0,
  }));
};

/** How stale a Mongo location may be and still count as "a driver who is here". */
const FALLBACK_LOCATION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Candidates from Mongo, using the 2dsphere index on DriverLocation.
 *
 * The geo set that dispatch searches lives ONLY in Redis, and the Redis lookup
 * used to be the single source: any Redis error was caught and turned into an
 * empty list, which is indistinguishable from "no drivers are near" — so a
 * Redis outage silently stopped dispatching every booking to every driver,
 * while the customer just saw the search spin. DriverLocation carries the same
 * coordinates behind a 2dsphere index and is written on the same updates, so it
 * can answer the question when Redis cannot. A staleness bound is applied
 * because, unlike the Redis entries, these rows are not evicted when a driver's
 * app stops reporting.
 */
const candidatesFromMongo = async (
  pickupLat: number,
  pickupLng: number,
  radiusKm: number,
): Promise<GeoCandidate[]> => {
  const DriverLocation = (await import("../models/driver-location.model"))
    .default;
  const rows = await DriverLocation.find({
    isOnline: true,
    lastUpdated: { $gte: new Date(Date.now() - FALLBACK_LOCATION_MAX_AGE_MS) },
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [pickupLng, pickupLat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  })
    .select("driverId latitude longitude")
    .limit(50)
    .lean();

  return rows.map((r: any) => ({
    driverId: String(r.driverId),
    distanceKm: haversineKm(pickupLat, pickupLng, r.latitude, r.longitude),
    lat: r.latitude,
    lng: r.longitude,
  }));
};

/**
 * Find nearby available drivers
 */
export const findNearbyDrivers = async (
  pickupLat: number,
  pickupLng: number,
  vehicleTypeId: string,
  radiusKm: number = DRIVER_SEARCH_RADIUS_KM,
): Promise<NearbyDriver[]> => {
  try {
    // Redis first — it is the live index. If it is unavailable, or simply has
    // nothing (an empty or flushed geo set looks identical to "no drivers"),
    // ask Mongo rather than reporting that nobody is available.
    let candidates: GeoCandidate[] = [];
    try {
      candidates = await candidatesFromRedis(pickupLat, pickupLng, radiusKm);
    } catch (err: any) {
      console.warn(
        "Dispatch: Redis geo lookup failed, falling back to Mongo —",
        err?.message || err,
      );
    }

    if (candidates.length === 0) {
      candidates = await candidatesFromMongo(pickupLat, pickupLng, radiusKm);
      if (candidates.length > 0) {
        console.log(
          `Dispatch: Redis returned no drivers; Mongo fallback found ${candidates.length} within ${radiusKm}km`,
        );
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    // Filter by availability and vehicle type
    const availableDrivers: NearbyDriver[] = [];

    // Mandatory training is enforced when a driver goes ONLINE
    // (driver.controller.ts toggleOnline), but that check cannot reach a driver
    // who was already online when an admin marked a program mandatory — they
    // stay online and keep receiving rides they are not cleared for. Re-checking
    // at dispatch closes that window. Resolved once here so the common case (no
    // mandatory program) costs two reads instead of three per candidate.
    const trainingEnforced = await hasMandatoryTraining();

    for (const result of candidates) {
      const driverId = result.driverId;
      const distance = result.distanceKm;
      const coords = { latitude: result.lat, longitude: result.lng };

      // Check if driver is online and approved. NOTE: the approval field is
      // `status: "approved"` (lowercase) — the source of truth used everywhere
      // else (driver.controller go-online/toggle checks). The old filter checked
      // `kycStatus: "APPROVED"` and `isBlocked`, neither of which exists on the
      // Driver schema, so this query matched NO driver and dispatch silently
      // notified nobody. "approved" also excludes "suspended" (the block state).
      const driver = await Driver.findOne({
        _id: driverId,
        isOnline: true,
        status: "approved",
      }).select("_id isOnline");

      if (!driver) continue;

      // Check if driver has a vehicle of the requested type and it's active
      const hasVehicle = await DriverVehicle.findOne({
        driverId: driverId,
        vehicleTypeId: new Types.ObjectId(vehicleTypeId),
        isActive: true,
        isDeleted: { $ne: true },
      });

      if (!hasVehicle) continue;

      // Skip a driver whose mandatory training is outstanding.
      if (trainingEnforced) {
        const gate = await getTrainingGateStatus(driverId);
        if (gate.required && !gate.complete) continue;
      }

      // Check if driver doesn't have an active booking
      const hasActiveBooking = await Booking.findOne({
        driverId: driverId,
        status: {
          $in: ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"],
        },
      });

      if (hasActiveBooking) continue;

      // Check if driver doesn't have a pending request
      const pendingBooking = await cache.get(
        `${DRIVER_PENDING_BOOKING_KEY}${driverId}`,
      );
      if (pendingBooking) continue;

      availableDrivers.push({
        driverId: driverId.toString(),
        distance: parseFloat(distance.toString()),
        lat: coords?.latitude || 0,
        lng: coords?.longitude || 0,
      });
    }

    // Sort by distance (nearest first)
    availableDrivers.sort((a, b) => a.distance - b.distance);

    // Limit to max drivers
    return availableDrivers.slice(0, MAX_DRIVERS_TO_NOTIFY);
  } catch (error) {
    console.error("Error finding nearby drivers:", error);
    return [];
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Sequential dispatch — nearest driver first, one offer at a time.
//
// The old behaviour rang up to ten drivers at once and, when a driver
// declined, did nothing: the booking sat until the 30-second timer fired and
// re-rang the same people. The client's rule is explicit — "assign to the
// nearest driver; if declined, reassign to the next nearest" — so dispatch is
// now a queue:
//
//   1. Candidates within the first radius are ordered by distance and queued.
//   2. The nearest eligible driver gets the offer for DISPATCH_OFFER_SECONDS.
//   3. Decline, timeout, or going offline moves the offer to the next driver
//      immediately; the previous driver's screen is closed with a reason.
//   4. When the queue empties the radius widens (5 → 8 → 11 → 15 km) and
//      drivers who already declined this booking are never re-offered it.
//   5. State lives in Redis for speed and in DispatchOffer rows for the
//      record; a restart is covered by sweepExpiredOffers() and
//      retryStalledSearches() from the job scheduler.
//
// DISPATCH_PARALLEL_OFFERS (AppConfig, default 1) rings that many nearest
// drivers at once for operators who prefer a small race.
// ═══════════════════════════════════════════════════════════════════════════

const BOOKING_QUEUE_KEY = "booking:queue:"; // list of {driverId, distance} nearest first
const BOOKING_OFFERS_KEY = "booking:offers:"; // hash driverId -> expiresAt (ms)
const BOOKING_DECLINED_KEY = "booking:declined:"; // set of drivers not to re-offer
const BOOKING_ROUND_KEY = "booking:round:"; // radius step reached
const BOOKING_OFFER_LOCK_KEY = "booking:offerlock:";
const BOOKING_NO_DRIVERS_KEY = "booking:nodrivers:";
const RADIUS_STEPS_KM = [DRIVER_SEARCH_RADIUS_KM, 8, 11, MAX_SEARCH_RADIUS_KM];
const STATE_TTL_SECONDS = 60 * 60;
/** How long a booking keeps being retried for newly online drivers. */
export const SEARCH_WINDOW_MS = 10 * 60 * 1000;

interface DispatchSettings {
  offerSeconds: number;
  parallelOffers: number;
}

let settingsCache: { value: DispatchSettings; at: number } | null = null;

export const dispatchSettings = async (): Promise<DispatchSettings> => {
  if (settingsCache && Date.now() - settingsCache.at < 60_000) return settingsCache.value;
  let offerSeconds = BOOKING_REQUEST_TIMEOUT_SECONDS;
  let parallelOffers = 1;
  try {
    const { AppConfig } = await import("../models/app-config.model");
    const rows = await AppConfig.find({
      key: { $in: ["DISPATCH_OFFER_SECONDS", "DISPATCH_PARALLEL_OFFERS"] },
    })
      .select("key value")
      .lean();
    for (const r of rows as any[]) {
      const n = Number(r.value);
      if (r.key === "DISPATCH_OFFER_SECONDS" && Number.isFinite(n) && n >= 10 && n <= 120) {
        offerSeconds = Math.round(n);
      }
      if (r.key === "DISPATCH_PARALLEL_OFFERS" && Number.isFinite(n) && n >= 1 && n <= 10) {
        parallelOffers = Math.round(n);
      }
    }
  } catch {
    /* defaults */
  }
  settingsCache = { value: { offerSeconds, parallelOffers }, at: Date.now() };
  return settingsCache.value;
};

const queueKey = (bookingId: string) => `${BOOKING_QUEUE_KEY}${bookingId}`;
const offersKey = (bookingId: string) => `${BOOKING_OFFERS_KEY}${bookingId}`;
const declinedKey = (bookingId: string) => `${BOOKING_DECLINED_KEY}${bookingId}`;
const roundKey = (bookingId: string) => `${BOOKING_ROUND_KEY}${bookingId}`;

/** Everything Redis holds for one booking's dispatch cycle. */
const clearDispatchState = async (bookingId: string, keepDeclined = false): Promise<void> => {
  const redis = getRedisClient();
  const keys = [
    queueKey(bookingId),
    offersKey(bookingId),
    roundKey(bookingId),
    `${BOOKING_TIMEOUT_KEY}${bookingId}`,
    `${BOOKING_NO_DRIVERS_KEY}${bookingId}`,
  ];
  if (!keepDeclined) keys.push(declinedKey(bookingId));
  await redis.del(keys);
};

/** Offers still inside their window. Expired entries are pruned as a side effect. */
const liveOffers = async (bookingId: string): Promise<string[]> => {
  const redis = getRedisClient();
  const all = await redis.hGetAll(offersKey(bookingId));
  const live: string[] = [];
  for (const [driverId, exp] of Object.entries(all)) {
    if (Number(exp) > Date.now()) live.push(driverId);
    else await redis.hDel(offersKey(bookingId), driverId);
  }
  return live;
};

/**
 * The same gate findNearbyDrivers applies, re-run at the moment of the offer:
 * a driver can go offline, accept another job, or lose their vehicle between
 * being queued and reaching the front of the queue.
 */
const driverEligible = async (driverId: string, vehicleTypeId: string): Promise<boolean> => {
  const driver = await Driver.findOne({ _id: driverId, isOnline: true, status: "approved" })
    .select("_id")
    .lean();
  if (!driver) return false;

  const hasVehicle = await DriverVehicle.findOne({
    driverId: new Types.ObjectId(driverId),
    vehicleTypeId: new Types.ObjectId(vehicleTypeId),
    isActive: true,
    isDeleted: { $ne: true },
  })
    .select("_id")
    .lean();
  if (!hasVehicle) return false;

  if (await hasMandatoryTraining()) {
    const gate = await getTrainingGateStatus(driverId);
    if (gate.required && !gate.complete) return false;
  }

  const busy = await Booking.findOne({
    driverId: new Types.ObjectId(driverId),
    status: { $in: ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"] },
  })
    .select("_id")
    .lean();
  if (busy) return false;

  const pending = await cache.get(`${DRIVER_PENDING_BOOKING_KEY}${driverId}`);
  return !pending;
};

const buildOfferPayload = (booking: any, expiresAt: number, offerSeconds: number) => ({
  bookingId: String(booking._id),
  bookingNumber: booking.bookingNumber || "",
  pickup: {
    address: booking.pickup?.address || "",
    lat: booking.pickup?.lat,
    lng: booking.pickup?.lng,
  },
  drop: {
    address: booking.drop?.address || "",
    lat: booking.drop?.lat || 0,
    lng: booking.drop?.lng || 0,
  },
  stops: (booking.stops || []).map((s: any) => ({
    address: s?.address || "",
    lat: s?.lat,
    lng: s?.lng,
  })),
  distance: booking.distanceKm || 0,
  estimatedFare: booking.finalFare || booking.fare || 0,
  vehicleType: (booking.vehicleTypeId as any)?.name || "Vehicle",
  serviceType: booking.serviceType,
  goodsType: booking.goodsType,
  expiresAt,
  offerSeconds,
});

/**
 * (Re)build the nearest-first queue for a booking starting at `startRound`,
 * widening the radius until someone new is found. Drivers who declined or are
 * being offered right now are excluded. Returns false when nobody is left.
 */
const rebuildQueue = async (bookingId: string, booking: any, startRound: number): Promise<boolean> => {
  const redis = getRedisClient();
  const pickupLat = booking.pickup?.lat;
  const pickupLng = booking.pickup?.lng;
  const vehicleTypeId = String((booking.vehicleTypeId as any)?._id || booking.vehicleTypeId || "");
  if (!pickupLat || !pickupLng || !vehicleTypeId) return false;

  const excluded = new Set<string>(await redis.sMembers(declinedKey(bookingId)));
  for (const d of await liveOffers(bookingId)) excluded.add(d);

  for (let round = Math.max(0, startRound); round < RADIUS_STEPS_KM.length; round++) {
    const nearby = await findNearbyDrivers(pickupLat, pickupLng, vehicleTypeId, RADIUS_STEPS_KM[round]);
    const fresh = nearby.filter((d) => !excluded.has(d.driverId));
    await redis.set(roundKey(bookingId), String(round), { EX: STATE_TTL_SECONDS });
    if (fresh.length > 0) {
      await redis.del(queueKey(bookingId));
      await redis.rPush(
        queueKey(bookingId),
        fresh.map((d) => JSON.stringify({ driverId: d.driverId, distance: d.distance })),
      );
      await redis.expire(queueKey(bookingId), STATE_TTL_SECONDS);
      return true;
    }
  }
  return false;
};

/** Tell the customer nobody is available — once per search cycle. */
const noDriversAvailable = async (bookingId: string, booking: any): Promise<void> => {
  const redis = getRedisClient();
  const first = await redis.set(`${BOOKING_NO_DRIVERS_KEY}${bookingId}`, "1", {
    NX: true,
    EX: 5 * 60,
  });
  if (first === null) return;
  const userId = booking.userId?._id?.toString() || booking.userId?.toString();
  if (userId) {
    emitToUser(userId, "booking:no_drivers", {
      bookingId,
      message: "No drivers available at the moment. We'll keep looking for a few minutes.",
    });
  }
};

/**
 * Offer the booking to the next driver(s) in the queue. Safe to call from
 * several places at once — a short Redis lock serialises the advance.
 * Returns the driver ids offered in this call.
 */
export const offerNext = async (bookingId: string): Promise<string[]> => {
  const redis = getRedisClient();
  const lockKey = `${BOOKING_OFFER_LOCK_KEY}${bookingId}`;
  const locked = await redis.set(lockKey, "1", { NX: true, PX: 8000 });
  if (locked === null) return [];

  try {
    const booking = await Booking.findById(bookingId).populate("vehicleTypeId", "name icon").lean();
    if (!booking || booking.driverId || !["SEARCHING", "PENDING"].includes(String(booking.status))) {
      await clearDispatchState(bookingId);
      return [];
    }

    const { offerSeconds, parallelOffers } = await dispatchSettings();
    let slots = parallelOffers - (await liveOffers(bookingId)).length;
    if (slots <= 0) return [];

    const vehicleTypeId = String((booking.vehicleTypeId as any)?._id || booking.vehicleTypeId || "");
    const offered: string[] = [];
    let rebuilt = false;

    while (slots > 0) {
      const raw = await redis.lPop(queueKey(bookingId));
      if (!raw) {
        if (rebuilt) break;
        rebuilt = true;
        const prev = await redis.get(roundKey(bookingId));
        const nextRound = prev === null ? 0 : Number(prev) + 1;
        if (!(await rebuildQueue(bookingId, booking, nextRound))) break;
        continue;
      }

      let entry: { driverId: string; distance: number };
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      const driverId = String(entry.driverId || "");
      if (!driverId) continue;
      if (await redis.sIsMember(declinedKey(bookingId), driverId)) continue;
      if (!(await driverEligible(driverId, vehicleTypeId))) continue;

      const expiresAt = Date.now() + offerSeconds * 1000;

      try {
        const DispatchOffer = (await import("../models/dispatch-offer.model")).default;
        await DispatchOffer.findOneAndUpdate(
          { bookingId: booking._id, driverId },
          {
            $set: { expiresAt: new Date(expiresAt), response: "PENDING", respondedAt: undefined },
            $setOnInsert: { offeredAt: new Date() },
          },
          { upsert: true },
        );
      } catch (offerErr) {
        console.error("dispatch: offer persist failed (non-fatal)", offerErr);
      }

      await redis.setEx(`${DRIVER_PENDING_BOOKING_KEY}${driverId}`, offerSeconds, bookingId);
      await redis.sAdd(`${BOOKING_DRIVERS_KEY}${bookingId}`, driverId);
      await redis.expire(`${BOOKING_DRIVERS_KEY}${bookingId}`, STATE_TTL_SECONDS);
      await redis.hSet(offersKey(bookingId), driverId, String(expiresAt));
      await redis.expire(offersKey(bookingId), STATE_TTL_SECONDS);

      const payload = {
        ...buildOfferPayload(booking, expiresAt, offerSeconds),
        driverDistance: entry.distance,
        priority: "high",
        sound: "booking_bell",
      };
      emitToUser(driverId, "booking:request", payload);
      try {
        await mqttUtil.sendBookingRequestToDriver(driverId, payload);
      } catch {
        /* MQTT optional */
      }
      try {
        const driverDoc = await Driver.findById(driverId).select("fcmToken").lean();
        if (driverDoc?.fcmToken) {
          await notificationService.sendPushNotification(
            driverDoc.fcmToken,
            "🔔 New booking request",
            `Pickup: ${payload.pickup.address.substring(0, 50)} | ₹${payload.estimatedFare}`,
            { type: "BOOKING_REQUEST", bookingId, action: "ACCEPT_BOOKING" },
          );
        }
      } catch {
        /* push optional */
      }

      // Primary timer; sweepExpiredOffers() is the restart-proof backstop.
      setTimeout(() => {
        handleOfferTimeout(bookingId, driverId).catch((e) =>
          console.error("dispatch: offer timeout handler failed", e),
        );
      }, offerSeconds * 1000 + 1000);

      offered.push(driverId);
      slots--;
    }

    if (offered.length === 0 && (await liveOffers(bookingId)).length === 0) {
      await noDriversAvailable(bookingId, booking);
    }
    return offered;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
};

/**
 * Dispatch a booking: build the nearest-first queue and ring the first
 * driver. `fresh: false` (used by the retry sweep) keeps the list of drivers
 * who already declined so they are not rung again.
 */
export const dispatchBookingToDrivers = async (
  bookingId: string,
  options: { fresh?: boolean } = {},
): Promise<BookingDispatchResult> => {
  const fresh = options.fresh !== false;
  try {
    const booking = await Booking.findById(bookingId).populate("vehicleTypeId", "name icon").lean();

    if (!booking) {
      return { success: false, driversNotified: 0, driverIds: [], message: "Booking not found" };
    }
    if (!booking.pickup?.lat || !booking.pickup?.lng) {
      return { success: false, driversNotified: 0, driverIds: [], message: "Invalid pickup location" };
    }
    const vehicleTypeId = (booking.vehicleTypeId as any)?._id?.toString() || booking.vehicleTypeId?.toString();
    if (!vehicleTypeId) {
      return { success: false, driversNotified: 0, driverIds: [], message: "Invalid vehicle type" };
    }

    const redis = getRedisClient();
    if (fresh) await clearDispatchState(bookingId);
    else await redis.del(queueKey(bookingId));

    await Booking.findByIdAndUpdate(bookingId, {
      status: "SEARCHING",
      ...(fresh || !booking.searchStartedAt ? { searchStartedAt: new Date() } : {}),
    });

    const built = await rebuildQueue(bookingId, booking, 0);
    if (!built) {
      await noDriversAvailable(bookingId, booking);
      return {
        success: false,
        driversNotified: 0,
        driverIds: [],
        message: "No available drivers found nearby",
      };
    }

    const offered = await offerNext(bookingId);
    if (offered.length === 0) {
      return {
        success: false,
        driversNotified: 0,
        driverIds: [],
        message: "No available drivers found nearby",
      };
    }
    return {
      success: true,
      driversNotified: offered.length,
      driverIds: offered,
      message:
        offered.length === 1
          ? "Booking offered to the nearest driver"
          : `Booking offered to the ${offered.length} nearest drivers`,
    };
  } catch (error: any) {
    console.error("Error dispatching booking:", error);
    return {
      success: false,
      driversNotified: 0,
      driverIds: [],
      message: error.message || "Failed to dispatch booking",
    };
  }
};

/**
 * A driver did not answer inside the window: record it, close their screen,
 * and move to the next driver. Idempotent — the timer, the sweep and a late
 * decline can all call it.
 */
const handleOfferTimeout = async (bookingId: string, driverId: string): Promise<void> => {
  const redis = getRedisClient();
  const DispatchOffer = (await import("../models/dispatch-offer.model")).default;
  const [expRaw, offerDoc] = await Promise.all([
    redis.hGet(offersKey(bookingId), driverId),
    DispatchOffer.findOne({ bookingId: new Types.ObjectId(bookingId), driverId: new Types.ObjectId(driverId) })
      .select("response expiresAt")
      .lean(),
  ]);
  const stillPending = offerDoc?.response === "PENDING";
  if (!expRaw && !stillPending) return; // answered or already handled
  const expiresAt = expRaw ? Number(expRaw) : new Date(offerDoc!.expiresAt).getTime();
  if (expiresAt > Date.now() + 500) return; // window refreshed

  await redis.hDel(offersKey(bookingId), driverId);
  await DispatchOffer.updateOne(
    { bookingId: new Types.ObjectId(bookingId), driverId: new Types.ObjectId(driverId), response: "PENDING" },
    { $set: { response: "EXPIRED", respondedAt: new Date() } },
  );
  const pending = await redis.get(`${DRIVER_PENDING_BOOKING_KEY}${driverId}`);
  if (pending === bookingId) await redis.del(`${DRIVER_PENDING_BOOKING_KEY}${driverId}`);
  await redis.sAdd(declinedKey(bookingId), driverId);
  await redis.expire(declinedKey(bookingId), STATE_TTL_SECONDS);

  emitToUser(driverId, "booking:closed", {
    bookingId,
    reason: "EXPIRED",
    message: "The request timed out and was offered to the next driver",
  });

  await offerNext(bookingId);
};

/**
 * Restart-proof backstop for the offer timers: lapse every PENDING offer whose
 * window passed and advance its booking. Run every 30 s by the scheduler.
 */
export const sweepExpiredOffers = async (): Promise<number> => {
  const DispatchOffer = (await import("../models/dispatch-offer.model")).default;
  const stale = await DispatchOffer.find({
    response: "PENDING",
    expiresAt: { $lt: new Date(Date.now() - 2000) },
  })
    .select("bookingId driverId")
    .limit(200)
    .lean();
  for (const o of stale as any[]) {
    try {
      await handleOfferTimeout(String(o.bookingId), String(o.driverId));
    } catch (e) {
      console.error("dispatch: sweep expired offer failed", e);
    }
  }
  return stale.length;
};

/**
 * Bookings still SEARCHING with no live offer and nothing queued get another
 * pass — a driver may have come online since. Stops after SEARCH_WINDOW_MS;
 * the customer can cancel or retry from the app.
 */
export const retryStalledSearches = async (): Promise<number> => {
  const since = new Date(Date.now() - SEARCH_WINDOW_MS);
  const rows = await Booking.find({
    status: "SEARCHING",
    driverId: null,
    searchStartedAt: { $gte: since },
    $or: [{ isScheduled: { $ne: true } }, { scheduledAt: { $lte: new Date(Date.now() + 15 * 60 * 1000) } }],
  })
    .select("_id")
    .limit(100)
    .lean();
  const redis = getRedisClient();
  let retried = 0;
  for (const b of rows as any[]) {
    const id = String(b._id);
    if ((await liveOffers(id)).length > 0) continue;
    if ((await redis.lLen(queueKey(id))) > 0) {
      await offerNext(id);
      retried++;
      continue;
    }
    const r = await dispatchBookingToDrivers(id, { fresh: false });
    if (r.success) retried++;
  }
  return retried;
};

/**
 * Handle driver accepting a booking — closes it for everyone else.
 */
export const handleDriverAcceptance = async (
  bookingId: string,
  driverId: string,
): Promise<{ success: boolean; message: string }> => {
  try {
    const redis = getRedisClient();

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return { success: false, message: "Booking not found" };
    }
    if (booking.status !== "SEARCHING" && booking.status !== "PENDING") {
      return { success: false, message: "Booking is no longer available" };
    }
    if (booking.driverId) {
      return { success: false, message: "Booking already assigned to another driver" };
    }

    // The vehicle-category rule is checked on EVERY accept, offered or not: a
    // two-wheeler partner must never end up on a three-wheeler job because a
    // stale offer was still on their screen.
    const hasVehicle = await DriverVehicle.findOne({
      driverId: new Types.ObjectId(driverId),
      vehicleTypeId: booking.vehicleTypeId,
      isActive: true,
      isDeleted: { $ne: true },
    }).select("_id registrationNumber");
    if (!hasVehicle) {
      return {
        success: false,
        message: "You don't have an active vehicle of the required type",
      };
    }

    // Fast path: the driver holds the offer. Fallback: the offer set lives in
    // Redis and can be lost on a restart — verify against the DB instead of
    // refusing a legitimate accept; the atomic update below still prevents
    // double assignment.
    const wasNotified = await redis.sIsMember(`${BOOKING_DRIVERS_KEY}${bookingId}`, driverId);
    if (!wasNotified) {
      const driver = await Driver.findOne({ _id: driverId, isOnline: true, status: "approved" }).select("_id");
      if (!driver) {
        return { success: false, message: "Driver is not online or not approved" };
      }
      const hasActiveBooking = await Booking.findOne({
        driverId: new Types.ObjectId(driverId),
        status: { $in: ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"] },
      }).select("_id");
      if (hasActiveBooking) {
        return { success: false, message: "Complete your active booking before accepting a new one" };
      }
    }

    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: bookingId, status: { $in: ["SEARCHING", "PENDING"] }, driverId: null },
      {
        $set: {
          driverId: new Types.ObjectId(driverId),
          status: "ASSIGNED",
          assignedAt: new Date(),
          ...(hasVehicle.registrationNumber ? { vehicleNumber: hasVehicle.registrationNumber } : {}),
        },
      },
      { new: true },
    ).populate("userId", "fullName fcmToken");

    if (!updatedBooking) {
      return { success: false, message: "Booking already assigned to another driver" };
    }

    // Record the outcome on every offer for this booking.
    try {
      const DispatchOffer = (await import("../models/dispatch-offer.model")).default;
      await DispatchOffer.updateOne(
        { bookingId: booking._id, driverId: new Types.ObjectId(driverId) },
        { $set: { response: "ACCEPTED", respondedAt: new Date() } },
      );
      await DispatchOffer.updateMany(
        { bookingId: booking._id, driverId: { $ne: new Types.ObjectId(driverId) }, response: "PENDING" },
        { $set: { response: "EXPIRED", respondedAt: new Date() } },
      );
    } catch {
      /* non-fatal */
    }

    const notifiedDrivers = await redis.sMembers(`${BOOKING_DRIVERS_KEY}${bookingId}`);
    for (const otherDriverId of notifiedDrivers) {
      if (otherDriverId === driverId) continue;
      await redis.del(`${DRIVER_PENDING_BOOKING_KEY}${otherDriverId}`);
      emitToUser(otherDriverId, "booking:closed", {
        bookingId,
        reason: "ACCEPTED_BY_OTHER",
        message: "This booking has been accepted by another driver",
      });
      try {
        await mqttUtil.sendBookingCancelledToDriver(otherDriverId, bookingId, "Booking accepted by another driver");
      } catch {
        /* MQTT optional */
      }
    }
    try {
      await mqttUtil.sendBookingAcceptedBroadcast(bookingId, driverId, notifiedDrivers);
    } catch {
      /* MQTT optional */
    }

    await redis.del(`${BOOKING_DRIVERS_KEY}${bookingId}`);
    await redis.del(`${DRIVER_PENDING_BOOKING_KEY}${driverId}`);
    await clearDispatchState(bookingId);

    // Both parties' app-level sockets join the booking room now, so chat and
    // status events reach them even before either opens the trip screen.
    const userId = updatedBooking.userId?._id?.toString() || updatedBooking.userId?.toString();
    try {
      const io = getIO();
      io.in(`user:${driverId}`).socketsJoin(`booking:${bookingId}`);
      if (userId) io.in(`user:${userId}`).socketsJoin(`booking:${bookingId}`);
    } catch {
      /* socket server optional in tests */
    }

    if (userId) {
      const driver = await Driver.findById(driverId).select("fullName mobileNumber profilePhoto rating").lean();
      emitToUser(userId, "booking:accepted", {
        bookingId,
        status: "ASSIGNED",
        driver: {
          _id: driverId,
          fullName: driver?.fullName,
          // Masked when number hiding is on; the app calls through the server.
          mobileNumber: presentPhone(driver?.mobileNumber),
          profilePhoto: driver?.profilePhoto,
          rating: driver?.rating,
        },
      });

      const userFcmToken = (updatedBooking.userId as any)?.fcmToken;
      if (userFcmToken) {
        await notificationService.sendPushNotification(
          userFcmToken,
          "🚗 Driver Assigned!",
          `${driver?.fullName || "Your driver"} has accepted your booking and is on the way.`,
          { type: "BOOKING_ACCEPTED", bookingId, driverId },
        );
      }
    }

    emitToBooking(bookingId, "booking:status", { bookingId, status: "ASSIGNED", driverId });

    return { success: true, message: "Booking accepted successfully" };
  } catch (error: any) {
    console.error("Error handling driver acceptance:", error);
    return { success: false, message: error.message || "Failed to accept booking" };
  }
};

/**
 * Driver declined: record it and move straight to the next nearest driver.
 */
export const handleDriverRejection = async (
  bookingId: string,
  driverId: string,
): Promise<{ success: boolean; message: string }> => {
  try {
    const redis = getRedisClient();
    await redis.del(`${DRIVER_PENDING_BOOKING_KEY}${driverId}`);
    await redis.hDel(offersKey(bookingId), driverId);
    await redis.sAdd(declinedKey(bookingId), driverId);
    await redis.expire(declinedKey(bookingId), STATE_TTL_SECONDS);
    try {
      const DispatchOffer = (await import("../models/dispatch-offer.model")).default;
      await DispatchOffer.updateOne(
        { bookingId: new Types.ObjectId(bookingId), driverId: new Types.ObjectId(driverId), response: "PENDING" },
        { $set: { response: "SKIPPED", respondedAt: new Date() } },
      );
    } catch {
      /* non-fatal */
    }

    // Next nearest, right away.
    offerNext(bookingId).catch((e) => console.error("dispatch: advance after decline failed", e));

    return { success: true, message: "Booking rejected" };
  } catch (error: any) {
    console.error("Error handling driver rejection:", error);
    return { success: false, message: error.message || "Failed to reject booking" };
  }
};

/**
 * Cancel booking dispatch (when the user cancels)
 */
export const cancelBookingDispatch = async (bookingId: string): Promise<void> => {
  try {
    const redis = getRedisClient();
    const notifiedDrivers = await redis.sMembers(`${BOOKING_DRIVERS_KEY}${bookingId}`);
    const live = new Set(await liveOffers(bookingId));

    for (const driverId of notifiedDrivers) {
      await redis.del(`${DRIVER_PENDING_BOOKING_KEY}${driverId}`);
      // Only drivers with the request on screen need the interruption.
      if (!live.has(driverId)) continue;
      emitToUser(driverId, "booking:cancelled", {
        bookingId,
        reason: "CANCELLED_BY_USER",
        message: "Booking was cancelled by the user",
      });
      try {
        await mqttUtil.sendBookingCancelledToDriver(driverId, bookingId, "Cancelled by user");
      } catch {
        /* MQTT optional */
      }
    }

    try {
      const DispatchOffer = (await import("../models/dispatch-offer.model")).default;
      await DispatchOffer.updateMany(
        { bookingId: new Types.ObjectId(bookingId), response: "PENDING" },
        { $set: { response: "EXPIRED", respondedAt: new Date() } },
      );
    } catch {
      /* non-fatal */
    }

    await redis.del(`${BOOKING_DRIVERS_KEY}${bookingId}`);
    await clearDispatchState(bookingId);
  } catch (error) {
    console.error("Error cancelling booking dispatch:", error);
  }
};

export default {
  findNearbyDrivers,
  dispatchBookingToDrivers,
  offerNext,
  sweepExpiredOffers,
  retryStalledSearches,
  handleDriverAcceptance,
  handleDriverRejection,
  cancelBookingDispatch,
};
