import mongoose, { Schema, Types } from "mongoose";

/**
 * GST jurisdictions (Indian states and union territories with their two-digit
 * GST state codes). This is DATA, seeded once and editable by the admin —
 * the tax logic never hardcodes a state: it looks codes and names up here,
 * so a renamed state, a new alias, or a new territory is a row change.
 */
export interface ITaxJurisdiction {
  _id?: Types.ObjectId;
  code: string;
  name: string;
  aliases: string[];
  isUnionTerritory: boolean;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const TaxJurisdictionSchema = new Schema<ITaxJurisdiction>(
  {
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    aliases: { type: [String], default: [] },
    isUnionTerritory: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const TaxJurisdiction = mongoose.model<ITaxJurisdiction>("TaxJurisdiction", TaxJurisdictionSchema);
export default TaxJurisdiction;

/** [code, name, aliases, isUnionTerritory] — the seed list, not a runtime lookup table. */
export const INDIAN_GST_JURISDICTIONS: Array<[string, string, string[], boolean]> = [
  ["01", "Jammu and Kashmir", ["jammu & kashmir", "j&k", "jammu and kashmir"], true],
  ["02", "Himachal Pradesh", [], false],
  ["03", "Punjab", [], false],
  ["04", "Chandigarh", [], true],
  ["05", "Uttarakhand", ["uttaranchal"], false],
  ["06", "Haryana", [], false],
  ["07", "Delhi", ["new delhi", "nct of delhi", "national capital territory of delhi"], true],
  ["08", "Rajasthan", [], false],
  ["09", "Uttar Pradesh", ["up"], false],
  ["10", "Bihar", [], false],
  ["11", "Sikkim", [], false],
  ["12", "Arunachal Pradesh", [], false],
  ["13", "Nagaland", [], false],
  ["14", "Manipur", [], false],
  ["15", "Mizoram", [], false],
  ["16", "Tripura", [], false],
  ["17", "Meghalaya", [], false],
  ["18", "Assam", [], false],
  ["19", "West Bengal", ["bengal"], false],
  ["20", "Jharkhand", [], false],
  ["21", "Odisha", ["orissa"], false],
  ["22", "Chhattisgarh", ["chattisgarh"], false],
  ["23", "Madhya Pradesh", ["mp"], false],
  ["24", "Gujarat", [], false],
  ["26", "Dadra and Nagar Haveli and Daman and Diu", ["dadra & nagar haveli", "daman & diu", "daman and diu", "dadra and nagar haveli"], true],
  ["27", "Maharashtra", [], false],
  ["29", "Karnataka", [], false],
  ["30", "Goa", [], false],
  ["31", "Lakshadweep", [], true],
  ["32", "Kerala", [], false],
  ["33", "Tamil Nadu", ["tamilnadu"], false],
  ["34", "Puducherry", ["pondicherry"], true],
  ["35", "Andaman and Nicobar Islands", ["andaman & nicobar", "andaman and nicobar"], true],
  ["36", "Telangana", [], false],
  ["37", "Andhra Pradesh", [], false],
  ["38", "Ladakh", [], true],
  ["97", "Other Territory", [], true],
];

/** Idempotent: inserts missing codes; never touches an existing row's aliases or isActive. */
export const seedTaxJurisdictions = async (): Promise<number> => {
  let inserted = 0;
  for (const [code, name, aliases, isUT] of INDIAN_GST_JURISDICTIONS) {
    const r = await TaxJurisdiction.updateOne(
      { code },
      { $setOnInsert: { code, name, aliases, isUnionTerritory: isUT, isActive: true } },
      { upsert: true },
    );
    if (r.upsertedCount) inserted += r.upsertedCount;
  }
  return inserted;
};
