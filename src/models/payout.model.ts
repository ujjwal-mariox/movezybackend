import mongoose, { Schema, Types } from "mongoose";

/**
 * Manual driver payout.
 *
 * Driver earnings are computed from completed bookings (not a mutable balance),
 * so a payout is an admin-managed record of money paid out to a driver, moving
 * through an approval queue: PENDING → APPROVED → PAID, or REJECTED. There is no
 * gateway call — an operator settles it out-of-band (bank transfer / UPI / cash)
 * and marks it PAID. The Payout record IS the ledger of what was disbursed.
 */
export type PayoutMethod = "BANK" | "UPI" | "CASH";
export type PayoutStatus = "PENDING" | "APPROVED" | "PAID" | "REJECTED";

export interface IPayout {
  _id: Types.ObjectId;
  driverId: Types.ObjectId;
  amount: number;
  method: PayoutMethod;
  status: PayoutStatus;
  notes?: string;
  // Snapshot of the driver's bank details at request time (immutable audit).
  bankSnapshot?: {
    accountHolderName?: string;
    bankName?: string;
    accountNumber?: string;
    ifscCode?: string;
  };
  reference?: string; // external UTR / transaction ref, filled when paid
  // Who created the request. Either an admin (manual queue) or the driver
  // themselves (app "Withdraw"). requestedByType records which, since the
  // ObjectId alone is ambiguous.
  requestedBy?: Types.ObjectId;
  requestedByType?: "Admin" | "Driver";
  approvedBy?: Types.ObjectId;
  paidBy?: Types.ObjectId;
  rejectedBy?: Types.ObjectId;
  rejectionReason?: string;
  approvedAt?: Date;
  paidAt?: Date;
  rejectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PayoutSchema = new Schema<IPayout>(
  {
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 1 },
    method: {
      type: String,
      enum: ["BANK", "UPI", "CASH"],
      default: "BANK",
    },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "PAID", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    notes: String,
    bankSnapshot: {
      accountHolderName: String,
      bankName: String,
      accountNumber: String,
      ifscCode: String,
    },
    reference: String,
    // No ref: requestedBy may be an Admin or a Driver; requestedByType says which.
    requestedBy: { type: Schema.Types.ObjectId },
    requestedByType: { type: String, enum: ["Admin", "Driver"] },
    approvedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    paidBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    rejectedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    rejectionReason: String,
    approvedAt: Date,
    paidAt: Date,
    rejectedAt: Date,
  },
  { timestamps: true },
);

PayoutSchema.index({ status: 1, createdAt: -1 });

// Model name "Payout" → collection "payouts" (matches the existing read side).
export default mongoose.model<IPayout>("Payout", PayoutSchema);
