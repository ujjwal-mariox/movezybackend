import "dotenv/config";
import mongoose from "mongoose";
import CancellationReason from "../models/cancellation-reason.model";

/**
 * Seed the USER-side cancellation reasons to the approved list.
 *
 * The eleven reasons below are the ones the customer app must offer, in this
 * order, replacing the earlier ad-hoc set ("Changed my mind", "Price too high",
 * ...). Existing rows are matched by CODE and updated in place — codes are what
 * old bookings reference, so nothing historical breaks. User-side rows not in
 * the approved list are deactivated, never deleted.
 *
 * DRIVER-side reasons are untouched: this list is about the customer flow.
 *
 * Refund percentages: every reason keeps 100% here. The ACTUAL refund is
 * decided at cancel time as min(reason %, stage ceiling) — the FareConfig stage
 * ceilings (100 / 100 / 0 live) already charge post-pickup cancellations, so a
 * per-reason penalty is not re-imposed here. A reason's percentage only ever
 * REDUCES the refund, and the admin can tune any row later.
 *
 * Idempotent. Run with: npx ts-node src/scripts/seed-cancellation-reasons.ts
 */
const REASONS: {
  reason: string;
  code: string;
  sortOrder: number;
}[] = [
  { reason: "Change in plans", code: "CHANGE_IN_PLANS", sortOrder: 1 },
  { reason: "Waiting for long time", code: "LONG_WAIT", sortOrder: 2 },
  { reason: "Unable to contact driver", code: "DRIVER_UNREACHABLE", sortOrder: 3 },
  {
    reason: "Driver denied to go to destination",
    code: "DRIVER_DENIED_DROP",
    sortOrder: 4,
  },
  {
    reason: "Driver denied to come to pickup",
    code: "DRIVER_DENIED_PICKUP",
    sortOrder: 5,
  },
  { reason: "Wrong address shown", code: "WRONG_ADDRESS", sortOrder: 6 },
  {
    reason: "The price is not reasonable",
    code: "PRICE_NOT_REASONABLE",
    sortOrder: 7,
  },
  { reason: "Emergency situation", code: "EMERGENCY", sortOrder: 8 },
  { reason: "Booking mistake", code: "BOOKING_MISTAKE", sortOrder: 9 },
  { reason: "Poor weather conditions", code: "POOR_WEATHER", sortOrder: 10 },
  { reason: "Other", code: "OTHER", sortOrder: 11 },
];

const run = async () => {
  const url = process.env.DB_URL;
  if (!url) throw new Error("DB_URL is not set");
  await mongoose.connect(url);
  console.log(`Connected to ${mongoose.connection.db?.databaseName}\n`);

  for (const r of REASONS) {
    const res = await CancellationReason.updateOne(
      { code: r.code },
      {
        $set: {
          reason: r.reason,
          sortOrder: r.sortOrder,
          isActive: true,
          isRefundable: true,
          refundPercentage: 100,
          penaltyType: "NONE",
          penaltyValue: 0,
          // OTHER was already applicableTo BOTH and drivers use it too — keep
          // shared codes shared, everything else is customer-side.
          applicableTo: r.code === "OTHER" ? "BOTH" : "USER",
        },
      },
      { upsert: true },
    );
    console.log(`  ${res.upsertedCount ? "created" : "updated"}: ${r.code.padEnd(22)} ${r.reason}`);
  }

  // Retire user-facing rows that are not in the approved list. Driver-only
  // rows (CUSTOMER_UNRESPONSIVE, VEHICLE_ISSUE) are left alone.
  const keep = REASONS.map((r) => r.code);
  const retired = await CancellationReason.updateMany(
    {
      code: { $nin: keep },
      applicableTo: { $in: ["USER", "BOTH"] },
      isActive: true,
    },
    { $set: { isActive: false } },
  );
  if (retired.modifiedCount) {
    console.log(`\n  deactivated ${retired.modifiedCount} old user-side reason(s)`);
  }

  const active = await CancellationReason.find({
    isActive: true,
    applicableTo: { $in: ["USER", "BOTH"] },
  })
    .sort({ sortOrder: 1 })
    .lean();
  console.log(`\nActive USER-side reasons now (${active.length}):`);
  for (const a of active as any[]) {
    console.log(`  ${String(a.sortOrder).padStart(2)}. ${a.reason}`);
  }

  await mongoose.disconnect();
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
