import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../models";
import Driver from "../models/driver.model";
import Vehicle from "../models/vehicle.model";
import DriverVehicle from "../models/driver-vehicle.model";
import VehicleType from "../models/vehicle-type.model";
import User from "../models/Users";

/**
 * Support lookup (read-only): who is "<name>" and what do they drive?
 * Usage: npx ts-node src/scripts/lookup-driver.ts "bhau patekar"
 */
const needle = process.argv.slice(2).join(" ").trim();
if (!needle) {
  console.error("usage: lookup-driver.ts <name or mobile>");
  process.exit(1);
}
const rx = new RegExp(needle.split(/\s+/).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"), "i");

(async () => {
  await connectDB();

  const drivers = await Driver.find({ $or: [{ fullName: rx }, { mobileNumber: rx }] })
    .select("fullName mobileNumber driverCode status isOnline city state createdAt")
    .lean();
  console.log(`drivers matching "${needle}": ${drivers.length}`);
  for (const d of drivers as any[]) {
    console.log(`\n— ${d.fullName} | mobile ${d.mobileNumber} | code ${d.driverCode || "-"} | status ${d.status} | online ${d.isOnline} | ${d.city || "-"}${d.state ? ", " + d.state : ""}`);
    const vehicles = await Vehicle.find({ driverId: d._id, isDeleted: { $ne: true } })
      .select("vehicleNumber vehicleType vehicleTypeId vehicleBodyType fuelType city isPrimary verificationStatus onboardingFeePaid dispatchBlock rcExpiryDate insuranceExpiryDate pucExpiryDate createdAt")
      .sort({ isPrimary: -1, createdAt: 1 })
      .lean();
    if (!vehicles.length) console.log("  no vehicle records");
    for (const v of vehicles as any[]) {
      const vt = v.vehicleTypeId ? await VehicleType.findById(v.vehicleTypeId).select("name categoryCode").lean() : null;
      console.log(
        `  • ${v.vehicleNumber} | catalog type: ${(vt as any)?.name || "-"} (${(vt as any)?.categoryCode || v.vehicleType || "-"}) | body ${v.vehicleBodyType || "-"} | fuel ${v.fuelType || "-"} | ${v.isPrimary ? "ACTIVE" : "idle"} | ${v.verificationStatus} | fee paid ${v.onboardingFeePaid ? "yes" : "no"}${v.dispatchBlock?.blocked ? " | BLOCKED: " + (v.dispatchBlock.reasons || []).join(", ") : ""}`,
      );
    }
    const rows = await DriverVehicle.find({ driverId: d._id, isDeleted: { $ne: true } }).select("registrationNumber isActive isOnline vehicleTypeId").lean();
    if (rows.length) {
      const parts = [];
      for (const r of rows as any[]) {
        const vt = await VehicleType.findById(r.vehicleTypeId).select("name").lean();
        parts.push(`${r.registrationNumber} → ${(vt as any)?.name || r.vehicleTypeId} (${r.isActive ? "dispatch ON" : "dispatch off"})`);
      }
      console.log(`  dispatch rows: ${parts.join("; ")}`);
    }
  }

  const users = await User.find({ $or: [{ fullName: rx }, { mobileNumber: rx }] }).select("fullName mobileNumber userCode createdAt").lean();
  console.log(`\ncustomer accounts matching "${needle}": ${users.length}`);
  for (const u of users as any[]) console.log(`— ${u.fullName} | mobile ${u.mobileNumber} | code ${u.userCode || "-"} | since ${new Date(u.createdAt).toISOString().slice(0, 10)}`);

  await mongoose.disconnect();
})().catch((e) => {
  console.error("LOOKUP FAILED", e);
  process.exit(1);
});
