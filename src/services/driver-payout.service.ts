/**
 * Driver payout / withdrawable-balance computation.
 *
 * Driver earnings are NOT a mutable stored balance — they are derived in real
 * time from the driver's COMPLETED bookings (Σ driverEarnings, the settlement
 * frozen on each booking at completion). This used to sum `finalFare`, which
 * includes the customer's GST and carries no commission: drivers could withdraw
 * tax the platform owes the government, and the platform retained nothing.
 * A withdrawal is a request against that computed figure that enters the queue
 * (payout.model: PENDING → APPROVED → PAID). Money that has already been
 * requested (PENDING/APPROVED) or disbursed (PAID) must be excluded so a driver
 * cannot withdraw the same earnings twice.
 *
 * Available balance = lifetime completed earnings − (PENDING + APPROVED + PAID payouts).
 */
import { Types } from "mongoose";
import Booking from "../models/booking.model";
import Payout from "../models/payout.model";
import { getAwardedIncentiveTotal } from "./incentive.service";

// Minimum a driver may withdraw in one request (env-overridable).
export const MIN_WITHDRAWAL = (() => {
  const n = Number(process.env.MIN_WITHDRAWAL_AMOUNT);
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

export interface DriverBalance {
  lifetimeEarnings: number; // Σ driverEarnings of COMPLETED trips + awarded incentives
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

  const [earnAgg, payoutAgg, incentiveTotal] = await Promise.all([
    Booking.aggregate([
      { $match: { driverId, status: "COMPLETED" } },
      {
        $group: {
          _id: null,
          // `driverEarnings` is frozen at completion (subtotal − commission).
          // completeTrip is the only path that sets status COMPLETED, so every
          // trip carries one; historical trips were backfilled. A booking
          // without it contributes 0 rather than silently falling back to
          // finalFare, which is what paid out the customer's GST.
          total: { $sum: { $ifNull: ["$driverEarnings", 0] } },
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
    // Bonuses the driver has genuinely unlocked. The app has always shown these
    // as "Total (Earnings + Bonus)", so they must be withdrawable too.
    getAwardedIncentiveTotal(driverId),
  ]);

  const tripEarnings = earnAgg[0]?.total || 0;
  const lifetimeEarnings = Math.round(tripEarnings + incentiveTotal);
  const reserved = Math.round(payoutAgg[0]?.total || 0);
  const available = Math.max(lifetimeEarnings - reserved, 0);

  return { lifetimeEarnings, reserved, available };
};
