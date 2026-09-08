import "dotenv/config";
import mongoose, { Types } from "mongoose";
import connectDB from "../models";
import Vehicle from "../models/vehicle.model";
import DriverVehicle from "../models/driver-vehicle.model";
import Booking from "../models/booking.model";
import {
  normalizeFuelType,
  normalizeVehicleNumber,
  syncDriverDispatchRows,
  pickVehicleForBooking,
} from "../services/vehicle-lifecycle.service";

/**
 * One-off data migration for the vehicle module. Idempotent; run with
 * `--apply` to write, without it for a dry run that only reports.
 *
 *  1. Fuel: "EV" → "Electric" (the canonical label the enum now accepts).
 *  2. Duplicates: the same registration number registered more than once.
 *     - Same driver: keep the best row (approved > fee paid > newest), soft-
 *       delete the rest — merging what the kept row lacks. This is the
 *       "duplicate entries when fuel type changed" data.
 *     - Different drivers: keep the EARLIEST registration, soft-delete the
 *       later one and log it for the admin (the later partner must re-register
 *       once ownership is sorted out). Test rows like "1234" fall here.
 *  3. Exactly one primary (active) vehicle per driver.
 *  4. Booking.vehicleId backfill for every trip that has a driver but no
 *     vehicle stamp — by the driver's primary, else a vehicle of the trip's
 *     type, else their only/first vehicle.
 *  5. Dispatch rows re-derived for every driver (fixes drivers with several
 *     rows active at once).
 *  6. The unique index on live registration numbers can then build cleanly.
 */

const APPLY = process.argv.includes("--apply");
const log = (...a: any[]) => console.log(APPLY ? "[apply]" : "[dry-run]", ...a);

const score = (v: any): number =>
  (v.verificationStatus === "approved" ? 100 : 0) +
  (v.onboardingFeePaid ? 10 : 0) +
  (v.isPrimary ? 1 : 0) +
  new Date(v.createdAt || 0).getTime() / 1e15; // newest wins ties

(async () => {
  await connectDB();

  // ── 0. Explicit isDeleted:false (partial unique index matches equality) ──
  const missingFlag = await Vehicle.countDocuments({ isDeleted: { $exists: false } });
  log(`vehicles missing isDeleted flag: ${missingFlag}`);
  if (APPLY && missingFlag) {
    await Vehicle.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } });
  }

  // ── 1. Fuel normalisation ─────────────────────────────────────────────
  const fuelRows = await Vehicle.find({ fuelType: { $exists: true, $ne: null } })
    .select("fuelType")
    .lean();
  let fuelFixes = 0;
  for (const v of fuelRows as any[]) {
    const canon = normalizeFuelType(v.fuelType);
    if (canon && canon !== v.fuelType) {
      fuelFixes++;
      if (APPLY) await Vehicle.updateOne({ _id: v._id }, { $set: { fuelType: canon } });
    }
  }
  log(`fuel labels to normalise: ${fuelFixes}`);

  // ── 2. Duplicates ─────────────────────────────────────────────────────
  const live = await Vehicle.find({ isDeleted: { $ne: true } }).lean();
  const byNumber = new Map<string, any[]>();
  for (const v of live as any[]) {
    const k = normalizeVehicleNumber(v.vehicleNumber);
    if (!k) continue;
    byNumber.set(k, [...(byNumber.get(k) || []), v]);
  }
  let sameDriverDups = 0;
  let crossDriverDups = 0;
  for (const [num, rows] of byNumber) {
    if (rows.length < 2) continue;
    const drivers = new Set(rows.map((r) => String(r.driverId)));
    if (drivers.size === 1) {
      const sorted = [...rows].sort((a, b) => score(b) - score(a));
      const keep = sorted[0];
      const drop = sorted.slice(1);
      sameDriverDups += drop.length;
      log(`  ${num}: same driver ×${rows.length} → keep ${keep._id} (${keep.verificationStatus}, paid=${keep.onboardingFeePaid}), drop ${drop.length}`);
      if (APPLY) {
        // Merge anything the kept row lacks from the dropped ones.
        const merged: any = {};
        for (const d of drop) {
          for (const f of ["fuelType", "vehicleBodyType", "city", "vehicleTypeId", "rcBackImage", "rcFrontImage"]) {
            if (!keep[f] && d[f]) merged[f] = d[f];
          }
        }
        if (Object.keys(merged).length) await Vehicle.updateOne({ _id: keep._id }, { $set: merged });
        await Vehicle.updateMany(
          { _id: { $in: drop.map((d) => d._id) } },
          { $set: { isDeleted: true, deletedAt: new Date(), isPrimary: false, rejectionReason: "Merged duplicate registration (migration)" } },
        );
      }
    } else {
      const sorted = [...rows].sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
      );
      const keep = sorted[0];
      const drop = sorted.slice(1);
      crossDriverDups += drop.length;
      log(`  ${num}: ${drivers.size} DIFFERENT drivers → keep earliest ${keep._id} (driver ${keep.driverId}), soft-delete ${drop.map((d) => `${d._id}/driver ${d.driverId}`).join(", ")}`);
      if (APPLY) {
        await Vehicle.updateMany(
          { _id: { $in: drop.map((d) => d._id) } },
          { $set: { isDeleted: true, deletedAt: new Date(), isPrimary: false, rejectionReason: "Registration number already held by another partner (migration)" } },
        );
      }
    }
  }
  log(`duplicates: same-driver rows to remove ${sameDriverDups}, cross-driver rows to remove ${crossDriverDups}`);

  // ── 3. One primary per driver ─────────────────────────────────────────
  const afterDedupe = await Vehicle.find({ isDeleted: { $ne: true } }).lean();
  const byDriver = new Map<string, any[]>();
  for (const v of afterDedupe as any[]) {
    // In dry-run the dropped rows are still live; exclude them here too.
    byDriver.set(String(v.driverId), [...(byDriver.get(String(v.driverId)) || []), v]);
  }
  let primaryFixes = 0;
  for (const [driverId, rows] of byDriver) {
    const primaries = rows.filter((r) => r.isPrimary);
    if (primaries.length === 1) continue;
    const chosen = [...rows].sort((a, b) => score(b) - score(a))[0];
    primaryFixes++;
    log(`  driver ${driverId}: ${primaries.length} primaries → ${chosen.vehicleNumber}`);
    if (APPLY) {
      await Vehicle.updateMany({ driverId: new Types.ObjectId(driverId) }, { $set: { isPrimary: false } });
      await Vehicle.updateOne({ _id: chosen._id }, { $set: { isPrimary: true } });
    }
  }
  log(`drivers whose primary needs fixing: ${primaryFixes}`);

  // ── 4. Booking vehicle backfill ───────────────────────────────────────
  const unstamped = await Booking.find({
    driverId: { $exists: true, $ne: null },
    $or: [{ vehicleId: { $exists: false } }, { vehicleId: null }],
  })
    .select("driverId vehicleTypeId bookingNumber")
    .lean();
  let stamped = 0;
  let unstampable = 0;
  for (const b of unstamped as any[]) {
    const pick = await pickVehicleForBooking(b.driverId, b.vehicleTypeId);
    if (!pick) {
      unstampable++;
      continue;
    }
    stamped++;
    if (APPLY) {
      await Booking.updateOne(
        { _id: b._id },
        { $set: { vehicleId: pick.vehicleId, vehicleNumber: pick.vehicleNumber } },
      );
    }
  }
  log(`bookings to stamp with a vehicle: ${stamped}; drivers with no vehicle at all: ${unstampable}`);

  // ── 5. Dispatch rows ──────────────────────────────────────────────────
  const multiActiveBefore = await DriverVehicle.aggregate([
    { $match: { isDeleted: { $ne: true }, isActive: true } },
    { $group: { _id: "$driverId", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  log(`drivers with >1 active dispatch row before: ${multiActiveBefore.length}`);
  if (APPLY) {
    for (const driverId of byDriver.keys()) await syncDriverDispatchRows(driverId);
    const after = await DriverVehicle.aggregate([
      { $match: { isDeleted: { $ne: true }, isActive: true } },
      { $group: { _id: "$driverId", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    log(`drivers with >1 active dispatch row after: ${after.length}`);
    for (const row of after) {
      const rows = await DriverVehicle.find({ driverId: row._id, isActive: true })
        .select("registrationNumber vehicleTypeId")
        .lean();
      log(`    still multi-active: driver ${row._id} → ${rows.map((r: any) => r.registrationNumber).join(", ")}`);
    }

    // ── 6. Unique index on live numbers ─────────────────────────────────
    try {
      await Vehicle.syncIndexes();
      log("indexes synced (unique_live_vehicle_number in place)");
    } catch (e) {
      log("index sync failed:", (e as Error).message);
    }
  }

  await mongoose.disconnect();
  log("done");
})().catch((e) => {
  console.error("MIGRATION FAILED", e);
  process.exit(1);
});
