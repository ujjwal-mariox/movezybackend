import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../models";
import { City } from "../models/master-data.model";
import { canonicalCityName, invalidateCityMasterCache } from "../services/vehicle-rate.service";

/**
 * Verifies that reported city names map onto the admin's city master.
 * Reads the live master and prints the mapping for typical geocoder
 * variants; asserts the aliases behaviour with a temporary alias that is
 * removed again. Run: npx ts-node src/scripts/verify-city-names.ts
 */
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " → " + JSON.stringify(detail) : ""}`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  await connectDB();
  const master = await City.find({ isActive: true }).select("name state aliases").lean();
  console.log("city master:", master.map((c: any) => `${c.name} (${c.state})${c.aliases?.length ? " ~" + c.aliases.join("/") : ""}`).join(", ") || "(empty)");

  const first: any = master[0];
  if (!first) {
    console.log("No cities in the master — nothing to map; unknown names pass through unchanged.");
    check("unknown name passes through", (await canonicalCityName("Atlantis")) === "Atlantis");
  } else {
    const n = String(first.name);
    check(`exact name maps to itself (${n})`, (await canonicalCityName(n)) === n);
    check(`lower-case maps (${n.toLowerCase()})`, (await canonicalCityName(n.toLowerCase())) === n);
    check(`"${n} City" maps by containment`, (await canonicalCityName(`${n} City`)) === n);
    check("unknown name passes through", (await canonicalCityName("Atlantis")) === "Atlantis");

    // Temporary alias round-trip on the first city, then restored.
    const before = Array.isArray(first.aliases) ? first.aliases : [];
    await City.updateOne({ _id: first._id }, { $set: { aliases: [...before, "zz-verify-alias"] } });
    invalidateCityMasterCache();
    check("alias maps to the master name", (await canonicalCityName("ZZ-Verify-Alias")) === n);
    await City.updateOne({ _id: first._id }, { $set: { aliases: before } });
    invalidateCityMasterCache();
    check("alias removed again", (await canonicalCityName("zz-verify-alias")) === "zz-verify-alias");
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error("VERIFY FAILED", e);
  process.exit(1);
});
