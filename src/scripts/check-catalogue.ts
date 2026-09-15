import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../models";
import VehicleType from "../models/vehicle-type.model";
import { AppConfig } from "../models/app-config.model";
import ChatQuickReply from "../models/chat-quick-reply.model";
import { City, FuelType, BodyType } from "../models/master-data.model";

/** Read-only snapshot of the catalogue + settings the client feedback depends on. */
(async () => {
  await connectDB();
  const types = await VehicleType.find({ isDeleted: { $ne: true } })
    .select("name categoryCode isActive showOnHomeScreen minRangeKm maxRangeKm allowIntraCity allowInterCity lengthFt breadthFt heightFt maxWeightKg cityOverrides sortOrder")
    .sort({ sortOrder: 1 })
    .lean();
  console.log("VEHICLE TYPES");
  for (const t of types as any[]) {
    console.log(
      `  ${t.name.padEnd(22)} cat=${(t.categoryCode || "MISSING").padEnd(7)} active=${t.isActive} home=${t.showOnHomeScreen} range=${t.minRangeKm ?? "-"}-${t.maxRangeKm ?? "-"}km intra=${t.allowIntraCity} inter=${t.allowInterCity} dims=${t.lengthFt || "-"}x${t.breadthFt || "-"}x${t.heightFt || "-"}ft cap=${t.maxWeightKg}kg cityCards=${(t.cityOverrides || []).length}`,
    );
  }
  const keys = ["SUPPORT_PHONE", "HIDE_CONTACT_NUMBERS", "CALL_MASKING_FALLBACK_DIRECT", "DISPATCH_OFFER_SECONDS", "DISPATCH_PARALLEL_OFFERS", "COMPANY_GSTIN", "COMPANY_STATE", "general.contact_email"];
  const rows = await AppConfig.find({ key: { $in: keys } }).select("key value").lean();
  console.log("\nSETTINGS");
  for (const k of keys) {
    const r = (rows as any[]).find((x) => x.key === k);
    console.log(`  ${k.padEnd(30)} ${r ? JSON.stringify(r.value) : "(not set)"}`);
  }
  console.log("\nQUICK REPLIES (active)");
  const qr = await ChatQuickReply.find({ isActive: true }).sort({ audience: 1, sortOrder: 1 }).lean();
  for (const q of qr as any[]) console.log(`  ${q.audience.padEnd(6)} ${q.text}`);
  console.log("\nMASTERS");
  console.log("  cities:", (await City.find({ isActive: true }).select("name").lean()).map((c: any) => c.name).join(", ") || "(none)");
  console.log("  fuel types:", (await FuelType.find({ isActive: true }).select("name").lean()).map((c: any) => c.name).join(", ") || "(none)");
  console.log("  body types:", (await BodyType.find({ isActive: true }).select("name").lean()).map((c: any) => c.name).join(", ") || "(none)");
  await mongoose.disconnect();
})().catch((e) => {
  console.error("CHECK FAILED", e);
  process.exit(1);
});
