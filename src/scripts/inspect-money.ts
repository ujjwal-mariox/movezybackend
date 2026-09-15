import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../models";
import Booking from "../models/booking.model";

/** Read-only: the money fields of the latest bookings, to spot what each app would show. */
(async () => {
  await connectDB();
  const rows = await Booking.find({ status: { $in: ["COMPLETED", "IN_PROGRESS", "PICKED", "DRIVER_ARRIVED", "ASSIGNED"] } })
    .sort({ createdAt: -1 })
    .limit(8)
    .select("bookingNumber status paymentMethod paymentStatus subtotal gstAmount gstPercentage promoDiscount coinDiscount userDiscount enterpriseDiscount totalDiscount finalFare fare waitingCharge waitingMinutes addonTotal stopCharges surgeFare commissionPercent commissionAmount driverEarnings pendingCashTopUp createdAt completedAt")
    .lean();
  for (const b of rows as any[]) {
    console.log(
      `${b.bookingNumber} ${b.status} ${b.paymentMethod}/${b.paymentStatus} | subtotal ${b.subtotal} gst ${b.gstAmount} (${b.gstPercentage}%) | discounts promo ${b.promoDiscount || 0} coin ${b.coinDiscount || 0} user ${b.userDiscount || 0} ent ${b.enterpriseDiscount || 0} total ${b.totalDiscount || 0} | finalFare ${b.finalFare} fare ${b.fare} | waiting ${b.waitingCharge || 0} (${b.waitingMinutes || 0}m) addons ${b.addonTotal || 0} stops ${b.stopCharges || 0} surge ${b.surgeFare || 0} | commission ${b.commissionPercent ?? "-"}% = ${b.commissionAmount ?? "-"} → driverEarnings ${b.driverEarnings ?? "-"} | topUp ${b.pendingCashTopUp || 0}`,
    );
  }
  await mongoose.disconnect();
})().catch((e) => { console.error("INSPECT FAILED", e); process.exit(1); });
