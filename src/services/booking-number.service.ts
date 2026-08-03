import mongoose from "mongoose";
import Booking from "../models/booking.model";

const COUNTER_ID = "bookingNumber";

interface CounterDoc {
  _id: string;
  seq: number;
}

/**
 * Next display booking number, e.g. "MZ0042".
 *
 * Shared deliberately: `bookingNumber` carries a NON-sparse unique index
 * (booking.model.ts), so any path that creates a Booking without one collides on
 * the duplicate null the moment a second such booking exists — which is exactly
 * what the enterprise credit path did. One generator, one sequence.
 *
 * The counter lives in Mongo, not Redis. It used to be a Redis key seeded from
 * the database, which made Redis a hard dependency of booking creation: a closed
 * client threw out of `cache.exists`, and once the cache helpers were made to
 * degrade gracefully it would have been worse — `exists` returning false would
 * have re-seeded and restarted the sequence, colliding on the unique index for
 * every booking until it caught up. A counter is not a cache. `findOneAndUpdate`
 * with `$inc` is atomic across processes, which is the actual requirement here.
 */
export const generateBookingNumber = async (): Promise<string> => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("Database not connected; cannot allocate a booking number");
  }
  const counters = db.collection<CounterDoc>("counters");

  // Seed once, from the highest number already issued, so an empty counters
  // collection cannot restart numbering at 1. `$setOnInsert` makes this
  // race-safe: concurrent callers all attempt it, exactly one insert wins, and
  // the others leave the existing value untouched.
  const existing = await counters.findOne({ _id: COUNTER_ID });
  if (!existing) {
    const lastBooking = await Booking.findOne(
      { bookingNumber: { $ne: null } },
      { bookingNumber: 1 },
    )
      .sort({ createdAt: -1 })
      .lean();

    let currentMax = 0;
    if (lastBooking?.bookingNumber) {
      const match = lastBooking.bookingNumber.match(/\d+/);
      if (match) currentMax = parseInt(match[0], 10);
    }
    // Total count as a floor, in case the newest row is not the highest number.
    const totalCount = await Booking.countDocuments();
    currentMax = Math.max(currentMax, totalCount);

    await counters.updateOne(
      { _id: COUNTER_ID },
      { $setOnInsert: { seq: currentMax } },
      { upsert: true },
    );
  }

  const updated = await counters.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: 1 } },
    { returnDocument: "after" },
  );

  const seq = updated?.seq;
  if (typeof seq !== "number") {
    throw new Error("Failed to allocate a booking number");
  }

  return `MZ${seq.toString().padStart(4, "0")}`;
};

export default generateBookingNumber;
