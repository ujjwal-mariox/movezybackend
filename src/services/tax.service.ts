import { AppConfig } from "../models/app-config.model";
import TaxJurisdiction, { ITaxJurisdiction, seedTaxJurisdictions } from "../models/tax-jurisdiction.model";
import type { ITaxBreakdown } from "../models/tax-breakdown.schema";
import { resolveStateFromCoords } from "./vehicle-rate.service";

/**
 * Automated GST split.
 *
 * Every trip is taxed at the platform GST rate (FareConfig.gstPercentage).
 * This service decides HOW that tax is labelled:
 *   - place of supply in the same state as the supplier  → CGST + SGST (½ each)
 *   - a different state                                   → IGST
 *   - either side unknown                                 → a single "GST" line
 *
 * Place of supply for transport-of-goods services: the recipient's registered
 * state when the customer has a GSTIN, otherwise the state where the goods are
 * handed over (the pickup). The supplier state is the company's GSTIN
 * (COMPANY_GSTIN) or COMPANY_STATE from settings.
 *
 * No state names or codes live in this file — they are rows in
 * TaxJurisdiction (seeded, admin-editable) and cached here for 10 minutes.
 */

export type TaxBreakdown = ITaxBreakdown;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// ── Jurisdiction lookup (cached) ────────────────────────────────────────────
let jurisCache: { rows: ITaxJurisdiction[]; at: number } | null = null;
const JURIS_TTL_MS = 10 * 60 * 1000;

const norm = (s: string): string =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const invalidateJurisdictionCache = (): void => {
  jurisCache = null;
};

export const getJurisdictions = async (): Promise<ITaxJurisdiction[]> => {
  if (jurisCache && Date.now() - jurisCache.at < JURIS_TTL_MS) return jurisCache.rows;
  let rows = await TaxJurisdiction.find({ isActive: true }).lean();
  if (rows.length === 0) {
    await seedTaxJurisdictions();
    rows = await TaxJurisdiction.find({ isActive: true }).lean();
  }
  jurisCache = { rows: rows as ITaxJurisdiction[], at: Date.now() };
  return jurisCache.rows;
};

export const findJurisdictionByCode = async (code: string | null | undefined) => {
  const c = String(code || "").trim();
  if (!/^\d{2}$/.test(c)) return null;
  return (await getJurisdictions()).find((r) => r.code === c) || null;
};

export const findJurisdictionByName = async (name: string | null | undefined) => {
  const n = norm(String(name || ""));
  if (!n) return null;
  const rows = await getJurisdictions();
  return (
    rows.find((r) => norm(r.name) === n) ||
    rows.find((r) => (r.aliases || []).some((a) => norm(a) === n)) ||
    // "Maharashtra, India" / "State of Kerala"
    rows.find((r) => n.includes(norm(r.name))) ||
    null
  );
};

/** First two digits of a syntactically plausible GSTIN, if they are a known code. */
export const stateCodeFromGstin = async (gstin: string | null | undefined): Promise<string | null> => {
  const g = String(gstin || "").trim().toUpperCase();
  if (g.length < 2 || !/^\d{2}/.test(g)) return null;
  const j = await findJurisdictionByCode(g.slice(0, 2));
  return j ? j.code : null;
};

/**
 * Resolve a state code from whatever is known, most reliable source first:
 * GSTIN → state name → coordinates (reverse geocode, cached).
 */
export const resolveStateCode = async (input: {
  stateName?: string | null;
  gstin?: string | null;
  lat?: number | null;
  lng?: number | null;
}): Promise<string | null> => {
  const fromGstin = await stateCodeFromGstin(input.gstin);
  if (fromGstin) return fromGstin;

  const byName = await findJurisdictionByName(input.stateName);
  if (byName) return byName.code;

  if (typeof input.lat === "number" && typeof input.lng === "number") {
    const geo = await resolveStateFromCoords(input.lat, input.lng);
    const byGeo = await findJurisdictionByName(geo);
    if (byGeo) return byGeo.code;
  }
  return null;
};

// ── Supplier (the platform) ─────────────────────────────────────────────────
export const getSupplierState = async (): Promise<{ code: string | null; gstin: string | null; stateName: string | null }> => {
  const rows = await AppConfig.find({ key: { $in: ["COMPANY_GSTIN", "COMPANY_STATE"] } })
    .select("key value")
    .lean();
  const byKey: Record<string, string> = {};
  for (const r of rows as any[]) byKey[r.key] = String(r.value || "").trim();
  const gstin = byKey.COMPANY_GSTIN && byKey.COMPANY_GSTIN !== "GSTIN-NOT-SET" ? byKey.COMPANY_GSTIN : null;
  const stateName = byKey.COMPANY_STATE || null;
  const code = (await stateCodeFromGstin(gstin)) || (await findJurisdictionByName(stateName))?.code || null;
  return { code, gstin, stateName };
};

// ── The split itself (pure) ─────────────────────────────────────────────────
export const splitTax = (input: {
  taxableAmount: number;
  gstPercentage: number;
  placeOfSupplyCode: string | null;
  supplierCode: string | null;
  placeOfSupplyName?: string | null;
  basis?: TaxBreakdown["basis"];
}): TaxBreakdown => {
  const pct = Math.max(0, Number(input.gstPercentage) || 0);
  const taxable = Math.max(0, Number(input.taxableAmount) || 0);
  const totalTax = round2((taxable * pct) / 100);
  const base: TaxBreakdown = {
    supplyType: "UNKNOWN",
    placeOfSupplyCode: input.placeOfSupplyCode || null,
    placeOfSupplyName: input.placeOfSupplyName || null,
    supplierStateCode: input.supplierCode || null,
    gstPercentage: pct,
    cgstRate: 0,
    sgstRate: 0,
    igstRate: 0,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0,
    totalTax,
    basis: input.basis || "NONE",
  };

  if (!input.placeOfSupplyCode || !input.supplierCode) {
    // Cannot tell intra from inter: one GST line, labelled as such.
    return { ...base, igstRate: pct, igstAmount: totalTax };
  }
  if (input.placeOfSupplyCode === input.supplierCode) {
    const half = round2(pct / 2);
    const cgst = round2(totalTax / 2);
    const sgst = round2(totalTax - cgst); // rounding remainder lands on SGST
    return { ...base, supplyType: "INTRA_STATE", cgstRate: half, sgstRate: round2(pct - half), cgstAmount: cgst, sgstAmount: sgst };
  }
  return { ...base, supplyType: "INTER_STATE", igstRate: pct, igstAmount: totalTax };
};

// ── Per-booking entry point ─────────────────────────────────────────────────
export const computeBookingTax = async (params: {
  taxableAmount: number;
  gstPercentage: number;
  pickup?: { lat?: number | null; lng?: number | null; city?: string | null; state?: string | null } | null;
  customerGstin?: string | null;
}): Promise<TaxBreakdown> => {
  const supplier = await getSupplierState();

  let placeCode: string | null = null;
  let basis: TaxBreakdown["basis"] = "NONE";
  const fromGstin = await stateCodeFromGstin(params.customerGstin);
  if (fromGstin) {
    placeCode = fromGstin;
    basis = "RECIPIENT_GSTIN";
  } else if (params.pickup) {
    placeCode = await resolveStateCode({
      stateName: params.pickup.state,
      lat: params.pickup.lat ?? undefined,
      lng: params.pickup.lng ?? undefined,
    });
    if (placeCode) basis = "PICKUP";
  }
  const place = placeCode ? await findJurisdictionByCode(placeCode) : null;

  return splitTax({
    taxableAmount: params.taxableAmount,
    gstPercentage: params.gstPercentage,
    placeOfSupplyCode: placeCode,
    supplierCode: supplier.code,
    placeOfSupplyName: place?.name || null,
    basis,
  });
};
