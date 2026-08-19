import { Types } from "mongoose";
import DriverLocation from "../models/driver-location.model";
import Booking from "../models/booking.model";
import Driver from "../models/driver.model";
import { cache } from "../utils/redis.util";
import socketUtils from "../utils/socket.util";
import config from "../config";

const LOCATION_CACHE_TTL = 60; // 1 minute
const NEARBY_DRIVER_RADIUS = 5000; // 5km in meters

/**
 * Update driver location
 */
export const updateDriverLocation = async (
  driverId: Types.ObjectId,
  location: {
    lat: number;
    lng: number;
    heading?: number;
    speed?: number;
    accuracy?: number;
  },
): Promise<void> => {
  const now = new Date();

  // Update in database
  await DriverLocation.findOneAndUpdate(
    { driverId },
    {
      driverId,
      location: {
        type: "Point",
        coordinates: [location.lng, location.lat],
      },
      heading: location.heading || 0,
      speed: location.speed || 0,
      accuracy: location.accuracy || 0,
      lastUpdated: now,
      isOnline: true,
    },
    { upsert: true },
  );

  // Cache in Redis for quick access
  await cache.set(
    `driver:location:${driverId}`,
    {
      lat: location.lat,
      lng: location.lng,
      heading: location.heading,
      speed: location.speed,
      updatedAt: now.toISOString(),
    },
    LOCATION_CACHE_TTL,
  );

  // Check if driver has active booking, emit to user. NOTE: the Booking status
  // enum uses PICKED / IN_PROGRESS — the old PICKED_UP / IN_TRANSIT values
  // matched nothing, so live location updates silently stopped after pickup.
  const activeBooking = await Booking.findOne({
    driverId,
    status: { $in: ["ASSIGNED", "DRIVER_ARRIVED", "PICKED", "IN_PROGRESS"] },
  });

  if (activeBooking) {
    const io = socketUtils.getIO();
    if (io) {
      io.to(`booking:${activeBooking._id}`).emit("driver:location", {
        bookingId: activeBooking._id,
        driverId,
        location: {
          lat: location.lat,
          lng: location.lng,
          heading: location.heading,
          speed: location.speed,
        },
        updatedAt: now,
      });
    }
  }
};

/**
 * Get driver location
 */
export const getDriverLocation = async (
  driverId: Types.ObjectId,
): Promise<{
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  updatedAt: string;
} | null> => {
  // Try cache first
  const cached = await cache.get<any>(`driver:location:${driverId}`);
  if (cached) {
    return cached;
  }

  // Fallback to database
  const location = await DriverLocation.findOne({ driverId });
  if (location) {
    return {
      lat: location.location.coordinates[1],
      lng: location.location.coordinates[0],
      heading: location.heading,
      speed: location.speed,
      updatedAt: location.updatedAt?.toISOString() || new Date().toISOString(),
    };
  }

  return null;
};

/**
 * Get booking tracking info
 */
export const getBookingTracking = async (
  bookingId: Types.ObjectId,
  userId: Types.ObjectId,
) => {
  const booking = await Booking.findOne({ _id: bookingId, userId })
    .populate(
      "driverId",
      "name mobileNumber profileImage rating vehicleNumber vehicleModel",
    )
    .populate("vehicleTypeId", "name icon");

  if (!booking) {
    throw new Error("Booking not found");
  }

  let driverLocation = null;
  let eta = null;

  if (booking.driverId) {
    driverLocation = await getDriverLocation(booking.driverId._id);

    // Calculate ETA based on current location and destination
    if (driverLocation) {
      eta = await calculateETA(
        { lat: driverLocation.lat, lng: driverLocation.lng },
        booking.status === "ASSIGNED" || booking.status === "DRIVER_ARRIVED"
          ? {
              lat: booking.pickup.lat,
              lng: booking.pickup.lng,
            }
          : {
              lat: booking.drop.lat,
              lng: booking.drop.lng,
            },
      );
    }
  }

  return {
    booking: {
      _id: booking._id,
      bookingNumber: booking.bookingNumber,
      status: booking.status,
      pickup: booking.pickup,
      drop: booking.drop,
      stops: booking.stops,
    },
    driver: booking.driverId,
    vehicleType: booking.vehicleTypeId,
    driverLocation,
    eta,
    statusTimeline: getStatusTimeline(booking),
  };
};

/**
 * Calculate ETA between two points
 */
const fmtDuration = (minutes: number) =>
  minutes < 60
    ? `${minutes} mins`
    : `${Math.floor(minutes / 60)} hr ${minutes % 60} mins`;

// Straight-line (haversine) fallback: real road ETA needs a Maps key.
const estimateETA = (
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
) => {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(destination.lat - origin.lat);
  const dLng = toRad(destination.lng - origin.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(origin.lat)) *
      Math.cos(toRad(destination.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  const duration = Math.ceil(distance * 3); // ~3 min/km in city traffic
  return {
    distance: Math.round(distance * 10) / 10,
    duration,
    durationText: fmtDuration(duration),
  };
};

const calculateETA = async (
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): Promise<{ distance: number; duration: number; durationText: string }> => {
  const apiKey = config.maps.apiKey;
  // Use real road distance/time from Google when a key is configured; otherwise
  // fall back to the straight-line estimate (no fake precision).
  if (apiKey) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/distancematrix/json` +
        `?origins=${origin.lat},${origin.lng}` +
        `&destinations=${destination.lat},${destination.lng}` +
        `&mode=driving&departure_time=now&key=${apiKey}`;
      const resp = await fetch(url);
      const data: any = await resp.json();
      const el = data?.rows?.[0]?.elements?.[0];
      if (data?.status === "OK" && el?.status === "OK") {
        const distanceKm = (el.distance?.value ?? 0) / 1000;
        // Prefer duration_in_traffic when available.
        const durationSec =
          el.duration_in_traffic?.value ?? el.duration?.value ?? 0;
        const durationMin = Math.max(1, Math.ceil(durationSec / 60));
        return {
          distance: Math.round(distanceKm * 10) / 10,
          duration: durationMin,
          durationText: fmtDuration(durationMin),
        };
      }
    } catch (err) {
      console.warn("[tracking] Maps ETA failed, using estimate:", err);
    }
  }
  return estimateETA(origin, destination);
};

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Get status timeline for booking
 */
const getStatusTimeline = (booking: any) => {
  const timeline: {
    status: string;
    label: string;
    time?: Date;
    completed: boolean;
  }[] = [
    {
      status: "CONFIRMED",
      label: "Booking Confirmed",
      completed: true,
      time: booking.createdAt,
    },
  ];

  const statuses = [
    "ASSIGNED",
    "DRIVER_ARRIVED",
    "PICKED_UP",
    "IN_TRANSIT",
    "COMPLETED",
  ];
  const statusLabels: Record<string, string> = {
    ASSIGNED: "Driver Assigned",
    DRIVER_ARRIVED: "Driver Arrived",
    PICKED_UP: "Goods Picked Up",
    IN_TRANSIT: "On the Way",
    COMPLETED: "Delivered",
  };

  const currentIndex = statuses.indexOf(booking.status);

  statuses.forEach((status, index) => {
    timeline.push({
      status,
      label: statusLabels[status],
      completed: index <= currentIndex,
      time:
        index <= currentIndex
          ? booking[`${status.toLowerCase()}At`]
          : undefined,
    });
  });

  return timeline;
};

/**
 * Find nearby drivers
 */
export const findNearbyDrivers = async (
  location: { lat: number; lng: number },
  vehicleTypeId?: Types.ObjectId,
  radiusMeters: number = NEARBY_DRIVER_RADIUS,
): Promise<any[]> => {
  const query: any = {
    location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [location.lng, location.lat],
        },
        $maxDistance: radiusMeters,
      },
    },
    isOnline: true,
    lastUpdated: { $gte: new Date(Date.now() - 5 * 60 * 1000) }, // Active in last 5 mins
  };

  // Driver schema fields are fullName/profilePhoto and there is NO isAvailable
  // or vehicleTypeId on Driver (vehicle type lives in DriverVehicle). The old
  // match on those non-existent fields nulled EVERY populated driver, so this
  // always returned an empty list. Filter approved+online via real fields and
  // resolve vehicle type through DriverVehicle when requested.
  const driverLocations = await DriverLocation.find(query)
    .populate({
      path: "driverId",
      select: "fullName profilePhoto rating isOnline isActive status",
      match: { isActive: true, status: "approved" },
    })
    .limit(20);

  let results = driverLocations.filter((dl) => dl.driverId);

  if (vehicleTypeId) {
    const DriverVehicle = (await import("../models/driver-vehicle.model"))
      .default;
    const withType = await DriverVehicle.find({
      driverId: { $in: results.map((dl: any) => dl.driverId._id) },
      vehicleTypeId,
      isActive: true,
      isDeleted: { $ne: true },
    }).select("driverId");
    const allowed = new Set(withType.map((v) => String(v.driverId)));
    results = results.filter((dl: any) => allowed.has(String(dl.driverId._id)));
  }

  return results
    .map((dl: any) => ({
      // Normalized driver payload — the user app reads driver.name.
      driver: {
        _id: dl.driverId._id,
        name: dl.driverId.fullName,
        profilePhoto: dl.driverId.profilePhoto,
        rating: dl.driverId.rating,
      },
      location: {
        lat: dl.location.coordinates[1],
        lng: dl.location.coordinates[0],
      },
      heading: dl.heading,
      distance: calculateDistance(
        location.lat,
        location.lng,
        dl.location.coordinates[1],
        dl.location.coordinates[0],
      ),
    }))
    .sort((a, b) => a.distance - b.distance);
};

/**
 * Calculate distance between two points (in km)
 */
const calculateDistance = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
};

/**
 * Set driver online/offline
 */
export const setDriverOnlineStatus = async (
  driverId: Types.ObjectId,
  isOnline: boolean,
  location?: { lat: number; lng: number },
): Promise<void> => {
  if (isOnline && location) {
    await DriverLocation.findOneAndUpdate(
      { driverId },
      {
        driverId,
        location: {
          type: "Point",
          coordinates: [location.lng, location.lat],
        },
        isOnline: true,
        lastUpdated: new Date(),
      },
      { upsert: true },
    );
  } else {
    await DriverLocation.findOneAndUpdate(
      { driverId },
      { isOnline: false, lastUpdated: new Date() },
    );
  }

  // Update driver status
  // Driver schema has no isAvailable — strict mode silently dropped it. Online
  // availability is tracked solely via isOnline.
  await Driver.findByIdAndUpdate(driverId, { isOnline });

  // Clear cache
  await cache.del(`driver:location:${driverId}`);
};

/**
 * Get drivers on map (for admin)
 */
export const getDriversOnMap = async (
  bounds?: {
    north: number;
    south: number;
    east: number;
    west: number;
  },
  vehicleTypeId?: Types.ObjectId,
) => {
  const query: any = {
    isOnline: true,
    lastUpdated: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
  };

  if (bounds) {
    query.location = {
      $geoWithin: {
        $box: [
          [bounds.west, bounds.south],
          [bounds.east, bounds.north],
        ],
      },
    };
  }

  // Driver fields are fullName/profilePhoto/isOnline; there is no
  // isAvailable/vehicleTypeId on Driver (the old select/match made every name
  // undefined and a vehicle-type filter dropped ALL drivers). Vehicle type is
  // resolved via DriverVehicle below.
  const driverLocations = await DriverLocation.find(query)
    .populate({
      path: "driverId",
      select:
        "fullName profilePhoto isOnline currentBookingId deviceInfo mobileNumber",
    })
    .limit(500);

  let onMap = driverLocations.filter((dl) => dl.driverId);

  if (vehicleTypeId) {
    const DriverVehicle = (await import("../models/driver-vehicle.model"))
      .default;
    const withType = await DriverVehicle.find({
      driverId: { $in: onMap.map((dl: any) => dl.driverId._id) },
      vehicleTypeId,
      isActive: true,
      isDeleted: { $ne: true },
    }).select("driverId");
    const allowed = new Set(withType.map((v) => String(v.driverId)));
    onMap = onMap.filter((dl: any) => allowed.has(String(dl.driverId._id)));
  }

  // Pull the ETA of each driver's CURRENT booking so the map can show a red
  // "delayed" pin. Without this the tracking feed had no notion of lateness at
  // all — every working driver looked equally fine.
  const activeBookingIds = onMap
    .map((dl: any) => dl.driverId.currentBookingId)
    .filter(Boolean);
  const etaByBooking = new Map<string, Date | null>();
  if (activeBookingIds.length > 0) {
    const Booking = (await import("../models/booking.model")).default;
    const activeBookings = await Booking.find({
      _id: { $in: activeBookingIds },
    })
      .select("estimatedDropTime")
      .lean();
    for (const b of activeBookings as any[]) {
      etaByBooking.set(String(b._id), b.estimatedDropTime ?? null);
    }
  }

  const nowMs = Date.now();

  return onMap
    .map((dl: any) => ({
      driverId: dl.driverId._id,
      name: dl.driverId.fullName,
      profileImage: dl.driverId.profilePhoto,
      isAvailable: dl.driverId.isOnline,
      // Fetched all along and then discarded, which is why the map's Call and
      // View-order actions had nothing to work with.
      phone: dl.driverId.mobileNumber,
      hasActiveBooking: !!dl.driverId.currentBookingId,
      currentBookingId: dl.driverId.currentBookingId || null,
      currentBookingEta: dl.driverId.currentBookingId
        ? etaByBooking.get(String(dl.driverId.currentBookingId)) ?? null
        : null,
      // True only when there IS an estimate and it has passed — never a guess
      // from "the trip feels long".
      isDelayed: (() => {
        const eta = dl.driverId.currentBookingId
          ? etaByBooking.get(String(dl.driverId.currentBookingId))
          : null;
        return eta ? new Date(eta).getTime() < nowMs : false;
      })(),
      // Real speed from the location document; the panel was showing a
      // placeholder for this.
      speed: dl.speed ?? 0,
      location: {
        lat: dl.location.coordinates[1],
        lng: dl.location.coordinates[0],
      },
      heading: dl.heading,
      lastUpdated: dl.lastUpdated,
      // Device info for battery & app version tracking
      deviceInfo: dl.driverId.deviceInfo ? {
        batteryLevel: dl.driverId.deviceInfo.batteryLevel,
        isCharging: dl.driverId.deviceInfo.isCharging,
        appVersion: dl.driverId.deviceInfo.appVersion,
        platform: dl.driverId.deviceInfo.platform,
      } : null,
    }));
};

/**
 * Get driver location history (for debugging/admin)
 */
export const getDriverLocationHistory = async (
  driverId: Types.ObjectId,
  startTime: Date,
  endTime: Date,
): Promise<any[]> => {
  // In production, store location history in a separate collection
  // For now, return empty
  return [];
};

/**
 * Subscribe to booking updates
 */
export const subscribeToBooking = async (
  bookingId: Types.ObjectId,
  socketId: string,
): Promise<void> => {
  const io = socketUtils.getIO();
  if (io) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.join(`booking:${bookingId}`);
    }
  }
};

/**
 * Unsubscribe from booking updates
 */
export const unsubscribeFromBooking = async (
  bookingId: Types.ObjectId,
  socketId: string,
): Promise<void> => {
  const io = socketUtils.getIO();
  if (io) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.leave(`booking:${bookingId}`);
    }
  }
};
