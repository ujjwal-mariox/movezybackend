/**
 * 2 Wheeler becomes a category with Scooter and Bike as its sub-categories
 * (client request, decided 2026-10-26).
 *
 *  - The generic "2 Wheeler" vehicle type is retired (inactive, off the home
 *    screen, no longer the category default). Past bookings keep it.
 *  - Its vehicles move by body type: Bike → Bike, everything else → Scooter
 *    (old "Open" bodies are set to Scooter). Approval is unchanged and each
 *    vehicle's dispatch row is re-derived, so drivers keep receiving jobs.
 *  - Goods types, promos and add-ons that listed the old type list Scooter
 *    and Bike instead. Scooter becomes the 2W default; both show on home,
 *    where the API merges them into one "2 Wheeler" card.
 *
 * Dry run by default (reads only):
 *   npx ts-node src/scripts/migrate-2w-subcategories.ts
 * Write the changes:
 *   npx ts-node src/scripts/migrate-2w-subcategories.ts --apply
 */
import "dotenv/config";
import mongoose, { Types } from "mongoose";
import connectDB from "../models";
import VehicleType from "../models/vehicle-type.model";
import Vehicle from "../models/vehicle.model";
import GoodsType from "../models/goods-type.model";
import PromoCode from "../models/promo-code.model";
import AddonService from "../models/addon-service.model";
import * as VehicleLifecycle from "../services/vehicle-lifecycle.service";
import { cache } from "../utils/redis.util";
const APPLY = process.argv[2] === "--apply";
(async () => {
  await connectDB();
  const generic: any = await VehicleType.findOne({ name: "2 Wheeler", categoryCode: "2W", isDeleted: { $ne: true } });
  const scooter: any = await VehicleType.findOne({ name: "Scooter", categoryCode: "2W", isDeleted: { $ne: true } });
  const bike: any = await VehicleType.findOne({ name: /^\s*bike\s*$/i, categoryCode: "2W", isDeleted: { $ne: true } });
  if (!generic || !scooter || !bike) throw new Error("expected 2 Wheeler, Scooter and Bike types");
  console.log(APPLY ? "APPLYING" : "DRY RUN (nothing written)");

  const vehicles: any[] = await Vehicle.find({ vehicleTypeId: generic._id, isDeleted: { $ne: true } });
  const moves = { Scooter: 0, Bike: 0, OpenToScooter: 0 };
  for (const v of vehicles) {
    const isBike = v.vehicleBodyType === "Bike";
    const target = isBike ? bike : scooter;
    if (isBike) moves.Bike++; else if (v.vehicleBodyType === "Scooter") moves.Scooter++; else moves.OpenToScooter++;
    if (APPLY) {
      v.vehicleTypeId = target._id;
      v.vehicleType = "2W";
      if (!["Scooter", "Bike"].includes(v.vehicleBodyType)) v.vehicleBodyType = "Scooter";
      await v.save();
      await VehicleLifecycle.syncDispatchRow(v);
    }
  }
  console.log(`vehicles: ${moves.Scooter} Scooter-body → Scooter, ${moves.Bike} Bike-body → Bike, ${moves.OpenToScooter} other-body → Scooter (body set to Scooter); approval unchanged`);

  const swap = (ids: any[]) => {
    const s = ids.map(String);
    if (!s.includes(String(generic._id))) return null;
    return [...new Set([...s.filter((x) => x !== String(generic._id)), String(scooter._id), String(bike._id)])].map((x) => new Types.ObjectId(x));
  };
  for (const [label, Model, field] of [["goods types", GoodsType, "allowedVehicleTypes"], ["promos", PromoCode, "applicableVehicleTypes"], ["add-ons", AddonService, "applicableVehicleTypes"]] as const) {
    const docs: any[] = await (Model as any).find({ [field]: generic._id });
    for (const d of docs) { const next = swap(d[field] || []); if (APPLY && next) { d[field] = next; await d.save(); } }
    console.log(`${label} listing the old type: ${docs.length} → will list Scooter + Bike instead`);
  }

  console.log(`types: "2 Wheeler" → inactive, hidden, not default | Scooter → default for 2W, on home | Bike → on home (name trimmed from "Bike ")`);
  if (APPLY) {
    await VehicleType.updateOne({ _id: generic._id }, { $set: { isActive: false, showOnHomeScreen: false, isDefaultForCategory: false } });
    await VehicleType.updateOne({ _id: scooter._id }, { $set: { isDefaultForCategory: true, showOnHomeScreen: true } });
    await VehicleType.updateOne({ _id: bike._id }, { $set: { showOnHomeScreen: true, name: "Bike" } });
    await cache.del("vehicleTypes:active");
    const after: any[] = await VehicleType.find({ categoryCode: "2W", isDeleted: { $ne: true } }).select("name isActive showOnHomeScreen isDefaultForCategory").lean();
    console.log("2W types now:", JSON.stringify(after.map((t) => [t.name, { active: t.isActive, home: t.showOnHomeScreen, default: t.isDefaultForCategory }])));
    const left = await Vehicle.countDocuments({ vehicleTypeId: generic._id, isDeleted: { $ne: true } });
    console.log(`vehicles still on old type: ${left}`);
  }
  await mongoose.disconnect(); process.exit(0);
})().catch(async (e) => { console.error("FAILED:", e.message); await mongoose.disconnect(); process.exit(1); });
