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
  performedBy: Types.ObjectId; // Admin who made the change
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
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
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
