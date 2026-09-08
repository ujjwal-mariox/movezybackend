import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../models";
import { splitTax, computeBookingTax, resolveStateCode, getJurisdictions } from "../services/tax.service";

/**
 * Verification for the GST split — pure math first, then the jurisdiction
 * lookups against the database (self-seeds the state codes on first run).
 * Read-only apart from that seed. Run: npx ts-node src/scripts/verify-tax-split.ts
 */
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " → " + JSON.stringify(detail) : ""}`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  // ── pure ──
  const intra = splitTax({ taxableAmount: 1000, gstPercentage: 5, placeOfSupplyCode: "27", supplierCode: "27" });
  check("intra-state splits 5% into 2.5 + 2.5", intra.supplyType === "INTRA_STATE" && intra.cgstAmount === 25 && intra.sgstAmount === 25 && intra.totalTax === 50, intra);
  const odd = splitTax({ taxableAmount: 333.33, gstPercentage: 18, placeOfSupplyCode: "27", supplierCode: "27" });
  check("rounding remainder lands on SGST and sums exactly", Math.abs(odd.cgstAmount + odd.sgstAmount - odd.totalTax) < 1e-9, odd);
  const inter = splitTax({ taxableAmount: 1000, gstPercentage: 5, placeOfSupplyCode: "29", supplierCode: "27" });
  check("inter-state is IGST 5%", inter.supplyType === "INTER_STATE" && inter.igstAmount === 50 && inter.cgstAmount === 0, inter);
  const unknown = splitTax({ taxableAmount: 1000, gstPercentage: 5, placeOfSupplyCode: null, supplierCode: "27" });
  check("unknown place of supply is a single GST line", unknown.supplyType === "UNKNOWN" && unknown.totalTax === 50, unknown);

  // ── data ──
  await connectDB();
  const rows = await getJurisdictions();
  check("jurisdictions available (>= 37)", rows.length >= 37, rows.length);
  check("GSTIN → state code", (await resolveStateCode({ gstin: "27ABCDE1234F1Z5" })) === "27");
  check("name → code (Maharashtra)", (await resolveStateCode({ stateName: "Maharashtra" })) === "27");
  check("alias → code (orissa)", (await resolveStateCode({ stateName: "Orissa" })) === "21");
  check("messy name → code (State of Kerala)", (await resolveStateCode({ stateName: "State of Kerala" })) === "32");
  check("unknown name → null", (await resolveStateCode({ stateName: "Atlantis" })) === null);

  const booking = await computeBookingTax({
    taxableAmount: 500,
    gstPercentage: 5,
    pickup: { state: "Maharashtra" },
    customerGstin: null,
  });
  check("booking tax uses pickup state when no GSTIN", booking.basis === "PICKUP" && booking.placeOfSupplyCode === "27", booking);
  const b2b = await computeBookingTax({
    taxableAmount: 500,
    gstPercentage: 5,
    pickup: { state: "Maharashtra" },
    customerGstin: "29ABCDE1234F1Z5",
  });
  check("booking tax uses recipient GSTIN state when present", b2b.basis === "RECIPIENT_GSTIN" && b2b.placeOfSupplyCode === "29", b2b);

  await mongoose.disconnect();
})().catch((e) => {
  console.error("VERIFY FAILED", e);
  process.exit(1);
});
