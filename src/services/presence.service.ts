import { Types } from "mongoose";
import Driver from "../models/driver.model";
import DriverLocation from "../models/driver-location.model";
import { getRedisClient } from "../utils/redis.util";
import { getIO } from "../utils/socket.util";

/**
 * Driver presence.
 *
 * "Online" used to be tied to a single WebSocket: the moment the phone locked
 * and the socket missed a ping, the server flipped the driver offline — while
 * the app still showed them online and they sat waiting for jobs that could
 * never come. Presence is now heartbeat-based:
 *
 *  - Anything the app does counts as a heartbeat: a socket connection, a
 *    location update, or the foreground service's POST /driver/app/heartbeat
 *    (sent every minute even with the screen locked).
 *  - A driver stays online until no heartbeat has arrived for
 *    DRIVER_OFFLINE_GRACE_MS (default 3 minutes) AND none of their sockets is
 *    connected. The sweep runs every minute from the job scheduler.
 *  - Going offline deliberately (toggle / logout) is immediate, as before.
 */

export const OFFLINE_GRACE_MS = Number(process.env.DRIVER_OFFLINE_GRACE_MS) || 3 * 60 * 1000;

/** DB writes are throttled to one per 20 s per driver; Redis keeps the marker. */
const THROTTLE_SECONDS = 20;

export const recordHeartbeat = async (
  driverId: string | Types.ObjectId,
  opts: { lat?: number; lng?: number; source?: string; force?: boolean } = {},
): Promise<void> => {
  const id = String(driverId);
  const now = new Date();
  const hasCoords =
    typeof opts.lat === "number" &&
    typeof opts.lng === "number" &&
    Number.isFinite(opts.lat) &&
    Number.isFinite(opts.lng) &&
    !(opts.lat === 0 && opts.lng === 0);

  let throttled = false;
  if (!opts.force) {
    try {
      const redis = getRedisClient();
      const ok = await redis.set(`driver:hb:${id}`, "1", { NX: true, EX: THROTTLE_SECONDS });
      throttled = ok === null;
    } catch {
      throttled = false; // no Redis → write through
    }
  }
  if (!throttled) {
    await Driver.updateOne({ _id: id }, { $set: { lastHeartbeatAt: now } });
  }

  if (hasCoords) {
    try {
      const redis = getRedisClient();
      await redis.geoAdd("driver:locations", {
        longitude: opts.lng as number,
        latitude: opts.lat as number,
        member: id,
      });
    } catch {
      /* Redis optional */
    }
    await DriverLocation.findOneAndUpdate(
      { driverId: id },
      {
        driverId: id,
        location: { type: "Point", coordinates: [opts.lng, opts.lat] },
        latitude: opts.lat,
        longitude: opts.lng,
        isOnline: true,
        lastUpdated: now,
      },
      { upsert: true },
    ).catch(() => {});
  }
};

const hasLiveSocket = async (driverId: string): Promise<boolean> => {
  try {
    const sockets = await getIO().in(`user:${driverId}`).fetchSockets();
    return sockets.length > 0;
  } catch {
    return false;
  }
};

/**
 * Flip drivers offline whose last sign of life is older than the grace
 * window and who have no socket connected. Returns how many were flipped.
 */
export const sweepStaleDrivers = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - OFFLINE_GRACE_MS);
  const candidates = await Driver.find({
    isOnline: true,
    $or: [{ lastHeartbeatAt: { $lt: cutoff } }, { lastHeartbeatAt: { $exists: false } }],
  })
    .select("_id lastHeartbeatAt updatedAt")
    .lean();

  let flipped = 0;
  for (const d of candidates as any[]) {
    const id = String(d._id);
    if (await hasLiveSocket(id)) continue;

    // A driver who has never sent a heartbeat (older app) is judged on their
    // last location update instead, so an upgrade is not required to stay online.
    if (!d.lastHeartbeatAt) {
      const loc = await DriverLocation.findOne({ driverId: id }).select("lastUpdated").lean();
      if (loc?.lastUpdated && loc.lastUpdated > cutoff) continue;
    }

    await Driver.updateOne({ _id: id }, { $set: { isOnline: false } });
    await DriverLocation.updateOne({ driverId: id }, { $set: { isOnline: false } }).catch(() => {});
    try {
      await getRedisClient().zRem("driver:locations", id);
    } catch {
      /* Redis optional */
    }
    flipped++;
  }
  if (flipped) console.log(`[presence] ${flipped} driver(s) marked offline after ${OFFLINE_GRACE_MS / 1000}s without a heartbeat`);
  return flipped;
};
