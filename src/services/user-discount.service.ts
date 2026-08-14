import { Types } from "mongoose";
import UserDiscount from "../models/user-discount.model";

export interface AppliedUserDiscount {
  discountId: Types.ObjectId;
  name: string;
  percent: number;
  /** Rupees off this particular fare, cap already applied. */
  amount: number;
}

/**
 * The best automatic discount this customer qualifies for right now, or null.
 *
 * "Best" = highest percent among active rows whose validity window covers now
 * and whose audience includes the user (a USERS row naming them, or an ALL
 * row). One discount applies per booking — they do not stack, exactly like
 * promo codes, so two overlapping campaigns can never compound into a fare
 * below what either admin intended.
 */
export const activeDiscountFor = async (
  userId: string | Types.ObjectId | null,
): Promise<{ discountId: Types.ObjectId; name: string; percent: number; maxDiscountAmount: number } | null> => {
  const now = new Date();
  const audience: any[] = [{ appliesTo: "ALL" }];
  if (userId && Types.ObjectId.isValid(String(userId))) {
    audience.push({
      appliesTo: "USERS",
      userIds: new Types.ObjectId(String(userId)),
    });
  }

  const rows = await UserDiscount.find({
    isActive: true,
    validFrom: { $lte: now },
    validTo: { $gte: now },
    $or: audience,
  })
    .sort({ percent: -1 })
    .limit(1)
    .lean();

  const best = rows[0];
  if (!best) return null;
  return {
    discountId: best._id,
    name: best.name,
    percent: best.percent,
    maxDiscountAmount: best.maxDiscountAmount || 0,
  };
};

/**
 * Rupees off a given GST-inclusive fare under the customer's best discount.
 * Returns null when no discount applies. Never throws — pricing must not fail
 * because the discount lookup did.
 */
export const discountAmountFor = async (
  userId: string | Types.ObjectId | null,
  fare: number,
): Promise<AppliedUserDiscount | null> => {
  try {
    if (!fare || fare <= 0) return null;
    const best = await activeDiscountFor(userId);
    if (!best) return null;
    let amount = (fare * best.percent) / 100;
    if (best.maxDiscountAmount > 0) {
      amount = Math.min(amount, best.maxDiscountAmount);
    }
    amount = Math.round(amount * 100) / 100;
    if (amount <= 0) return null;
    return {
      discountId: best.discountId,
      name: best.name,
      percent: best.percent,
      amount,
    };
  } catch (err) {
    console.error("User-discount lookup failed:", err);
    return null;
  }
};
