import mongoose, { Schema, Types } from "mongoose";

export interface IAddonService {
  _id: Types.ObjectId;
  name: string;
  code: string;
  description: string;
  icon: string;
  /**
   * How `price` is interpreted:
   *  - FIXED      → price × quantity (a flat fee)
   *  - PERCENTAGE → price is a PERCENT of the trip value (e.g. Insurance = 2%)
   *  - PER_FLOOR  → price × number of floors
   *  - PER_KG     → price × weight in kg
   *
   * PERCENTAGE was missing here while the seed wrote `pricingType: "PERCENTAGE"`
   * for Insurance — a field this schema didn't have, so Mongoose strict mode
   * silently dropped it and Insurance billed ₹2 flat instead of 2% of the order.
   */
  priceType: "FIXED" | "PERCENTAGE" | "PER_FLOOR" | "PER_KG";
  price: number;
  /** Grouping for the add-ons list (LOADING, PACKING, INSURANCE, …). */
  category?: string;
  isActive: boolean;
  applicableVehicleTypes?: Types.ObjectId[];
  sortOrder: number;
}

const AddonServiceSchema = new Schema<IAddonService>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },
    description: {
      type: String,
      default: "",
    },
    icon: {
      type: String,
      default: "",
    },
    priceType: {
      type: String,
      enum: ["FIXED", "PERCENTAGE", "PER_FLOOR", "PER_KG"],
      default: "FIXED",
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    applicableVehicleTypes: [
      {
        type: Schema.Types.ObjectId,
        ref: "VehicleType",
      },
    ],
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

export default mongoose.model<IAddonService>(
  "AddonService",
  AddonServiceSchema,
);
