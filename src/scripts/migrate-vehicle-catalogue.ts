/**
 * Every category's vehicles become sub-categories of it (client request,
 * decided 2026-11-04), finishing what migrate-2w-subcategories started:
 *
 *  - 3 Wheeler: the generic "3 wheeler" type is retired. Its vehicles move by
 *    fuel: Electric → E Loader, everything else → Mini 3W, which becomes the
 *    3W default.
 *  - 4 Wheeler: "Tata Ace" (already inactive, yet still the 4W default) is
 *    retired the same way. Its vehicles move to Pickup 8ft, the new default.
 *  - 2 Wheeler: vehicles left on the retired "2 Wheeler" move by body type
 *    (Bike → Bike, else Scooter), the 2026-10-26 rule.
 *
 * Moved vehicles keep their approval, and each vehicle's dispatch row is
 * re-derived, so drivers keep receiving jobs. Dispatch rows still on a
 * retired type are re-derived from their vehicle. Goods types, promos and
 * add-ons that listed a retired type list its replacements. Past bookings keep
 * the old type.
 *
 * Dry run by default (reads only):
 *   npx ts-node src/scripts/migrate-vehicle-catalogue.ts
 * Write the changes:
 *   npx ts-node src/scripts/migrate-vehicle-catalogue.ts --apply
 */
import mongoose, { Types } from "mongoose";
import connectDB from "../models";
import VehicleType from "../models/vehicle-type.model";
import Vehicle from "../models/vehicle.model";
import DriverVehicle from "../models/driver-vehicle.model";
import GoodsType from "../models/goods-type.model";
import PromoCode from "../models/promo-code.model";
import AddonService from "../models/addon-service.model";
import * as VehicleLifecycle from "../services/vehicle-lifecycle.service";
import { cache } from "../utils/redis.util";

const APPLY = process.argv[2] === "--apply";

const typeNamed = async (name: RegExp, categoryCode: string) => {
  const t: any = await VehicleType.findOne({ name, categoryCode, isDeleted: { $ne: true } });
  if (!t) throw new Error(`expected a ${categoryCode} type matching ${name}`);
  return t;
};

interface Retirement {
  category: string;
  retired: any;
  /** Where each of the retired type's vehicles goes. */
  targetFor: (vehicle: any) => any;
  /** Fix-ups on the vehicle beyond its type (2W bodies). */
  adjust?: (vehicle: any) => void;
  /** Types that replace it in goods types, promos and add-ons. */
  replacements: any[];
  newDefault: any;
}

const retire = async (r: Retirement) => {
  const label = `${r.category} "${r.retired.name}"`;
  const vehicles: any[] = await Vehicle.find({ vehicleTypeId: r.retired._id, isDeleted: { $ne: true } });
  const counts = new Map<string, number>();
  for (const v of vehicles) {
    const target = r.targetFor(v);
    counts.set(target.name, (counts.get(target.name) || 0) + 1);
    if (APPLY) {
      v.vehicleTypeId = target._id;
      v.vehicleType = r.category;
      r.adjust?.(v);
      await v.save();
      await VehicleLifecycle.syncDispatchRow(v);
    }
  }
  console.log(
    `${label}: ${vehicles.length} vehicles → ` +
      ([...counts].map(([n, c]) => `${c} ${n}`).join(", ") || "none") +
      "; approval unchanged",
  );

  const retiredId = String(r.retired._id);
  const swap = (ids: any[]) => {
    const s = (ids || []).map(String);
    if (!s.includes(retiredId)) return null;
    return [...new Set([...s.filter((x) => x !== retiredId), ...r.replacements.map((t) => String(t._id))])].map(
      (x) => new Types.ObjectId(x),
    );
  };
  for (const [what, Model, field] of [
    ["goods types", GoodsType, "allowedVehicleTypes"],
    ["promos", PromoCode, "applicableVehicleTypes"],
    ["add-ons", AddonService, "applicableVehicleTypes"],
  ] as const) {
    const docs: any[] = await (Model as any).find({ [field]: r.retired._id });
    for (const d of docs) {
      const next = swap(d[field]);
      if (APPLY && next) {
        d[field] = next;
        await d.save();
      }
    }
    if (docs.length) {
      console.log(`  ${what} listing it: ${docs.length} → ${r.replacements.map((t) => t.name).join(" + ")}`);
    }
  }

  console.log(`  "${r.retired.name}" → inactive, hidden, not default | ${r.newDefault.name} → ${r.category} default`);
  if (APPLY) {
    // Clear the old default first: one default per category is a unique index.
    await VehicleType.updateOne(
      { _id: r.retired._id },
      { $set: { isActive: false, showOnHomeScreen: false, isDefaultForCategory: false } },
    );
    await VehicleType.updateMany(
      { categoryCode: r.category, _id: { $ne: r.newDefault._id }, isDefaultForCategory: true },
      { $set: { isDefaultForCategory: false } },
    );
    await VehicleType.updateOne({ _id: r.newDefault._id }, { $set: { isDefaultForCategory: true } });
  }
};

(async () => {
  await connectDB();
  console.log(APPLY ? "APPLYING" : "DRY RUN (nothing written)");

  const isElectric = (v: any) => /electric|^ev$|battery/i.test(String(v.fuelType || ""));
  const scooter = await typeNamed(/^\s*scooter\s*$/i, "2W");
  const bike = await typeNamed(/^\s*bike\s*$/i, "2W");
  const mini3w = await typeNamed(/^\s*mini\s*3w\s*$/i, "3W");
  const eLoader = await typeNamed(/^\s*e[\s-]*loader\s*$/i, "3W");
  const pickup8 = await typeNamed(/^\s*pickup\s*8\s*ft\s*$/i, "4W");

  await retire({
    category: "2W",
    retired: await typeNamed(/^\s*2\s*wheeler\s*$/i, "2W"),
    targetFor: (v) => (v.vehicleBodyType === "Bike" ? bike : scooter),
    adjust: (v) => {
      if (!["Scooter", "Bike"].includes(v.vehicleBodyType)) v.vehicleBodyType = "Scooter";
    },
    replacements: [scooter, bike],
    newDefault: scooter,
  });
  await retire({
    category: "3W",
    retired: await typeNamed(/^\s*3\s*wheeler\s*$/i, "3W"),
    targetFor: (v) => (isElectric(v) ? eLoader : mini3w),
    replacements: [mini3w, eLoader],
    newDefault: mini3w,
  });
  await retire({
    category: "4W",
    retired: await typeNamed(/^\s*tata\s*ace\s*$/i, "4W"),
    targetFor: () => pickup8,
    replacements: [pickup8],
    newDefault: pickup8,
  });

  // Dispatch rows still on a retired type: their vehicle moved earlier but the
  // row was never re-derived, or the vehicle is gone.
  const retiredIds = (await VehicleType.find({ isActive: false }).select("_id").lean()).map((t: any) => t._id);
  // Only rows that can still receive bookings matter; switched-off duplicates
  // (an old, differently formatted registration number) are left as they are.
  const staleRows: any[] = await DriverVehicle.find({ vehicleTypeId: { $in: retiredIds }, isDeleted: { $ne: true }, isActive: true }).lean();
  let resynced = 0;
  let orphans = 0;
  for (const row of staleRows) {
    const all: any[] = await Vehicle.find({ driverId: row.driverId, isDeleted: { $ne: true } });
    const vehicle = all.find(
      (v) => VehicleLifecycle.normalizeVehicleNumber(v.vehicleNumber) === VehicleLifecycle.normalizeVehicleNumber(row.registrationNumber),
    );
    if (vehicle && retiredIds.every((id) => String(id) !== String(vehicle.vehicleTypeId))) {
      resynced++;
      if (APPLY) await VehicleLifecycle.syncDispatchRow(vehicle);
    } else {
      orphans++;
      if (APPLY) await DriverVehicle.updateOne({ _id: row._id }, { $set: { isActive: false } });
    }
  }
  console.log(`dispatch rows on retired types: ${staleRows.length} (${resynced} re-derived from their vehicle, ${orphans} with no current vehicle → switched off)`);

  // Home shows one card per category (2 Wheeler, 3 Wheeler, 4 Wheeler, Heavy
  // Vehicle), so every active vehicle is visible there; a category with only
  // one visible vehicle would show that vehicle's own card instead.
  const hidden: any[] = await VehicleType.find({ isActive: true, isDeleted: { $ne: true }, showOnHomeScreen: false }).select("name").lean();
  console.log(`active vehicles hidden from home: ${hidden.length}${hidden.length ? ` (${hidden.map((t) => t.name).join(", ")}) → shown, grouped under their category` : ""}`);
  if (APPLY && hidden.length) {
    await VehicleType.updateMany({ _id: { $in: hidden.map((t) => t._id) } }, { $set: { showOnHomeScreen: true } });
  }

  if (APPLY) {
    await cache.del("vehicleTypes:active");
    const after: any[] = await VehicleType.find({ isDeleted: { $ne: true } })
      .select("name categoryCode isActive isDefaultForCategory")
      .sort({ categoryCode: 1, maxWeightKg: 1 })
      .lean();
    for (const t of after) {
      const n = await Vehicle.countDocuments({ vehicleTypeId: t._id, isDeleted: { $ne: true } });
      console.log(`  ${t.categoryCode} ${String(t.name).padEnd(14)} ${t.isActive ? "active  " : "inactive"} ${t.isDefaultForCategory ? "default" : "       "} vehicles ${n}`);
    }
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  await mongoose.disconnect();
  process.exit(1);
});
