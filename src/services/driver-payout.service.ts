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
 * Cash trips are netted off (client rule, 2026-11-04). On a cash trip the
 * driver keeps the whole fare, including Movezy's commission and the GST, so
 * that cash already counts as paid to them. A prepaid trip's cash top-up for
 * stops added later counts the same way. Money the driver adds to their
 * wallet pays dues down.
 *
 * Balance = earnings + bonuses + wallet − cash held − (PENDING + APPROVED + PAID payouts).
 * Above zero it is withdrawable; below zero the driver owes Movezy (dues).
 */
import { Types } from "mongoose";
import Booking from "../models/booking.model";
import Payout from "../models/payout.model";
import WalletModel from "../models/wallet.model";
import { FareConfig } from "../models/app-config.model";
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
  cashHeld: number; // cash the driver collected: cash-trip fares + prepaid top-ups
  walletPaidIn: number; // the driver's wallet balance, which pays dues down
  dues: number; // what the driver owes Movezy (never negative)
}

/**
 * Compute a driver's withdrawable balance from real bookings + payout history.
 */
export const getDriverAvailableBalance = async (
  driverIdStr: string,
): Promise<DriverBalance> => {
  const driverId = new Types.ObjectId(driverIdStr);

  const [earnAgg, payoutAgg, incentiveTotal, wallet] = await Promise.all([
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
          // Cash in the driver's hand: the whole fare on a cash trip, or the
          // top-up for stops added after a prepaid booking was paid.
          cashHeld: {
            $sum: {
              $cond: [
                { $eq: ["$paymentMethod", "CASH"] },
                { $ifNull: ["$finalFare", 0] },
                {
                  $add: [
                    { $ifNull: ["$cashTopUpCollected", 0] },
                    { $ifNull: ["$pendingCashTopUp", 0] },
                  ],
                },
              ],
            },
          },
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
    WalletModel.findOne({ userId: driverId }).select("balance").lean(),
  ]);

  const tripEarnings = earnAgg[0]?.total || 0;
  const lifetimeEarnings = Math.round(tripEarnings + incentiveTotal);
  const reserved = Math.round(payoutAgg[0]?.total || 0);
  const cashHeld = Math.round(earnAgg[0]?.cashHeld || 0);
  const walletPaidIn = Math.round(Math.max(Number((wallet as any)?.balance) || 0, 0));
  const balance = lifetimeEarnings + walletPaidIn - cashHeld - reserved;
  const available = Math.max(balance, 0);
  const dues = Math.max(-balance, 0);

  return { lifetimeEarnings, reserved, available, cashHeld, walletPaidIn, dues };
};

/**
 * Whether a driver's cash dues are over the admin's limit, which keeps them
 * offline until they pay in. A limit of 0 (the default) means no limit.
 */
export const cashDuesBlock = async (
  driverIdStr: string,
): Promise<{ blocked: boolean; dues: number; limit: number }> => {
  const config = await FareConfig.findOne({ isActive: true }).select("driverCashDueLimit").lean();
  const limit = Math.max(Number((config as any)?.driverCashDueLimit) || 0, 0);
  if (limit <= 0) return { blocked: false, dues: 0, limit: 0 };
  const { dues } = await getDriverAvailableBalance(driverIdStr);
  return { blocked: dues > limit, dues, limit };
};
