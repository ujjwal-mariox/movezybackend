import mongoose, { Schema, Types } from "mongoose";

/**
 * An admin-managed customer discount, applied automatically at pricing time —
 * no code to type. This is the "discounted price with the original struck
 * through" the client asked for, made configurable per user or for everyone.
 *
 * Deliberately mirrors how promo codes settle: the discount reduces what the
 * CUSTOMER pays (folded into booking.totalDiscount and finalFare) and never
 * touches subtotal, so driver earnings (subtotal − commission) are unaffected.
 */
export interface IUserDiscount {
  _id: Types.ObjectId;
  /** Admin-facing label, e.g. "Diwali 10% for new users". */
  name: string;
  /** Percent off the GST-inclusive fare, 1–90. */
  percent: number;
  /** Rupee cap per booking; 0 = uncapped. */
  maxDiscountAmount: number;
  /** ALL = every customer; USERS = only the ids listed below. */
  appliesTo: "ALL" | "USERS";
  userIds: Types.ObjectId[];
  validFrom: Date;
  validTo: Date;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const UserDiscountSchema = new Schema<IUserDiscount>(
  {
    name: { type: String, required: true, trim: true },
    percent: { type: Number, required: true, min: 1, max: 90 },
    maxDiscountAmount: { type: Number, default: 0, min: 0 },
    appliesTo: {
      type: String,
      enum: ["ALL", "USERS"],
      required: true,
      index: true,
    },
    userIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true },
);

// The lookup every priced request makes: active rows whose window covers now.
UserDiscountSchema.index({ isActive: 1, validFrom: 1, validTo: 1 });

export default mongoose.model<IUserDiscount>(
  "UserDiscount",
  UserDiscountSchema,
);
