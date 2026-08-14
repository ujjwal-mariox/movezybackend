import mongoose, { Schema, Types } from "mongoose";

/**
 * Admin-created coupon codes for the DRIVER onboarding/joining fee.
 *
 * Distinct from PromoCode (customer booking discounts) and from driver
 * referral codes (peer codes, hardcoded 50%). A coupon can waive the fee
 * entirely: a FLAT value >= the fee, or PERCENT 100, produces a ₹0 payable
 * and the payment flow skips Razorpay for it (Razorpay rejects zero-amount
 * orders).
 *
 * Usage is recorded at PAYMENT COMPLETION (or waiver), not at apply — an
 * abandoned checkout must not burn a use. One redemption per driver.
 */
export interface IOnboardingCoupon {
  _id?: Types.ObjectId;
  code: string;
  description?: string;
  discountType: "PERCENT" | "FLAT";
  /** PERCENT: 1–100. FLAT: rupees. */
  value: number;
  /** -1 = unlimited. */
  maxUses: number;
  usedCount: number;
  usedByDrivers: Types.ObjectId[];
  validFrom: Date;
  validTo: Date;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const OnboardingCouponSchema = new Schema<IOnboardingCoupon>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    description: String,
    discountType: {
      type: String,
      enum: ["PERCENT", "FLAT"],
      required: true,
    },
    value: { type: Number, required: true, min: 1 },
    maxUses: { type: Number, default: -1 },
    usedCount: { type: Number, default: 0 },
    usedByDrivers: [{ type: Schema.Types.ObjectId, ref: "Driver" }],
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true },
);

const OnboardingCoupon = mongoose.model<IOnboardingCoupon>(
  "OnboardingCoupon",
  OnboardingCouponSchema,
);

export default OnboardingCoupon;
