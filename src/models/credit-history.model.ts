import mongoose, { Schema, Types } from "mongoose";

export interface ICreditHistory {
  _id: Types.ObjectId;
  enterpriseId: Types.ObjectId;
  type: "CREDIT_USED" | "CREDIT_REPAID" | "LIMIT_INCREASED" | "LIMIT_DECREASED" | "ADJUSTMENT";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  limitBefore?: number;
  limitAfter?: number;
  bookingId?: Types.ObjectId;
  invoiceId?: Types.ObjectId;
  paymentId?: string;
  reason: string;
  /**
   * Admin who made the change. Absent for rows the platform writes itself —
   * credit consumed by a customer's credit booking, and credit released when
   * that booking is cancelled. `performedByType` says which.
   */
  performedBy?: Types.ObjectId;
  performedByType?: "ADMIN" | "CUSTOMER" | "SYSTEM";
  createdAt: Date;
}

const CreditHistorySchema = new Schema<ICreditHistory>(
  {
    enterpriseId: {
      type: Schema.Types.ObjectId,
      ref: "Enterprise",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["CREDIT_USED", "CREDIT_REPAID", "LIMIT_INCREASED", "LIMIT_DECREASED", "ADJUSTMENT"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    limitBefore: Number,
    limitAfter: Number,
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
    },
    invoiceId: {
      type: Schema.Types.ObjectId,
      ref: "Invoice",
    },
    paymentId: String,
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    // Not required: rows written by the platform itself (a customer's credit
    // booking, or the release when it is cancelled) have no admin actor. Making
    // it required meant those rows could not be written at all.
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    performedByType: {
      type: String,
      enum: ["ADMIN", "CUSTOMER", "SYSTEM"],
      default: "ADMIN",
    },
  },
  { timestamps: true },
);

// Indexes
CreditHistorySchema.index({ enterpriseId: 1, createdAt: -1 });
CreditHistorySchema.index({ type: 1, createdAt: -1 });

export const CreditHistory = mongoose.model<ICreditHistory>(
  "CreditHistory",
  CreditHistorySchema,
);
