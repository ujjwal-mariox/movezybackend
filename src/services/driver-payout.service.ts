/**
 * Driver payout / withdrawable-balance computation.
 *
 * Driver earnings are NOT a mutable stored balance — they are derived in real
 * time from the driver's COMPLETED bookings (Σ finalFare). A withdrawal is a
 * request against that computed figure that enters the admin payout queue
 * (payout.model: PENDING → APPROVED → PAID). Money that has already been
 * requested (PENDING/APPROVED) or disbursed (PAID) must be excluded so a driver
 * cannot withdraw the same earnings twice.
 *
 * Available balance = lifetime completed earnings − (PENDING + APPROVED + PAID payouts).
 */
import { Types } from "mongoose";
import Booking from "../models/booking.model";
import Payout from "../models/payout.model";

// Minimum a driver may withdraw in one request (env-overridable).
export const MIN_WITHDRAWAL = (() => {
  const n = Number(process.env.MIN_WITHDRAWAL_AMOUNT);
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

export interface DriverBalance {
  lifetimeEarnings: number; // Σ finalFare of all COMPLETED trips
  reserved: number; // sum of PENDING + APPROVED + PAID payouts
  available: number; // withdrawable now (never negative)
}

/**
 * Compute a driver's withdrawable balance from real bookings + payout history.
 */
export const getDriverAvailableBalance = async (
  driverIdStr: string,
): Promise<DriverBalance> => {
  const driverId = new Types.ObjectId(driverIdStr);

  const [earnAgg, payoutAgg] = await Promise.all([
    Booking.aggregate([
      { $match: { driverId, status: "COMPLETED" } },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ["$finalFare", "$fare"] } },
        },
      },
    ]),
    // PENDING + APPROVED are in-flight (not yet paid but claimed); PAID is done.
    // All three reduce what's still available to request.
    Payout.aggregate([
      {
        $match: {
          driverId,
          status: { $in: ["PENDING", "APPROVED", "PAID"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  const lifetimeEarnings = Math.round(earnAgg[0]?.total || 0);
  const reserved = Math.round(payoutAgg[0]?.total || 0);
  const available = Math.max(lifetimeEarnings - reserved, 0);

  return { lifetimeEarnings, reserved, available };
};
