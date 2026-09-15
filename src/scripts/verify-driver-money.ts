import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../models";
import Booking from "../models/booking.model";
import * as FareService from "../services/fare.service";

/**
 * Read-only: does the estimate a driver sees BEFORE completion (subtotal minus
 * the vehicle type's commission for the pickup city) match what settlement
 * froze AFTER completion? One line per recent completed booking.
 */
(async () => {
  await connectDB();
  const rows = await Booking.find({ status: "COMPLETED", driverEarnings: { $exists: true } })
    .sort({ completedAt: -1, updatedAt: -1 })
    .limit(8)
    .select("bookingNumber vehicleTypeId pickup.city subtotal gstAmount gstPercentage finalFare commissionPercent commissionAmount driverEarnings")
    .lean();
  let mismatches = 0;
  for (const b of rows as any[]) {
    const pct = await FareService.commissionPercentFor(b.vehicleTypeId, b.pickup?.city);
    const est = Math.round((b.subtotal - Math.round(((b.subtotal * pct) / 100) * 100) / 100) * 100) / 100;
    const ok = Math.abs(est - Number(b.driverEarnings)) < 0.01;
    if (!ok) mismatches++;
    console.log(
      `${b.bookingNumber} ${String(b.pickup?.city || "-").padEnd(10)} subtotal ${b.subtotal} gst ${b.gstAmount} (${b.gstPercentage}%) customer pays ${b.finalFare} | rate now ${pct}% -> estimate ${est} | frozen ${b.commissionPercent}% -> earnings ${b.driverEarnings} ${ok ? "OK" : "DIFFERS"}`,
    );
  }
  console.log(`\n${rows.length} bookings checked, ${mismatches} where today's rate differs from the frozen one`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("VERIFY FAILED", e);
  process.exit(1);
});
