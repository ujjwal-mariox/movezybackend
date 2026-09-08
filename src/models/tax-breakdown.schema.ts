import { Schema } from "mongoose";

/**
 * How one amount of GST was split — stored on the booking at creation,
 * refreshed whenever the fare changes, and copied onto the invoice.
 *
 *  INTRA_STATE: supplier and place of supply in the same state → CGST + SGST
 *  INTER_STATE: different states → IGST
 *  UNKNOWN:     one side could not be resolved → a single GST line (the
 *               invoice says "GST", never a guessed split)
 */
export interface ITaxBreakdown {
  supplyType: "INTRA_STATE" | "INTER_STATE" | "UNKNOWN";
  placeOfSupplyCode: string | null;
  placeOfSupplyName: string | null;
  supplierStateCode: string | null;
  gstPercentage: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalTax: number;
  /** Where the place of supply came from: the customer's GSTIN or the pickup. */
  basis?: "RECIPIENT_GSTIN" | "PICKUP" | "NONE";
}

export const TaxBreakdownSchema = new Schema<ITaxBreakdown>(
  {
    supplyType: {
      type: String,
      enum: ["INTRA_STATE", "INTER_STATE", "UNKNOWN"],
      default: "UNKNOWN",
    },
    placeOfSupplyCode: { type: String, default: null },
    placeOfSupplyName: { type: String, default: null },
    supplierStateCode: { type: String, default: null },
    gstPercentage: { type: Number, default: 0 },
    cgstRate: { type: Number, default: 0 },
    sgstRate: { type: Number, default: 0 },
    igstRate: { type: Number, default: 0 },
    cgstAmount: { type: Number, default: 0 },
    sgstAmount: { type: Number, default: 0 },
    igstAmount: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    basis: { type: String, enum: ["RECIPIENT_GSTIN", "PICKUP", "NONE"], default: "NONE" },
  },
  { _id: false },
);
