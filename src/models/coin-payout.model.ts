import mongoose, { Schema, Types } from "mongoose";

/**
 * A customer's request to cash coins out to their bank account.
 *
 * Mirrors the manual driver Payout queue: there is no gateway call, so an
 * operator settles out-of-band and marks the request PAID with the UTR. This
 * record IS the ledger of what was disbursed.
 *
 * Why this exists as its own collection rather than a CoinTransaction field:
 * CoinTransaction has no schema path for bank details, and Mongoose strict mode
 * silently DROPS unknown paths — the previous implementation accepted
 * `bankDetails` and threw it away, so an operator had no account number to pay.
 *
 * The coins are debited when the request is created (atomically, via
 * debitCoins) so the customer cannot spend the same coins twice while a payout
 * is in flight. REJECTED refunds them. PAID is terminal.
 */
export type CoinPayoutStatus = "PENDING" | "APPROVED" | "PAID" | "REJECTED";

export interface ICoinPayout {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  coins: number;
  /** Rupee value at request time — the bank rate can change, this cannot. */
  amount: number;
  rateApplied: number;
  status: CoinPayoutStatus;
  // Snapshot of the details the customer typed (immutable audit).
  bankSnapshot: {
    accountName: string;
    accountNumber: string;
    ifsc: string;
  };
  /** The debit that locked the coins — lets a refund be traced to its request. */
  debitTransactionId?: Types.ObjectId;
  reference?: string; // external UTR, filled when paid
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

const CoinPayoutSchema = new Schema<ICoinPayout>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    coins: { type: Number, required: true, min: 1 },
    amount: { type: Number, required: true, min: 0 },
    rateApplied: { type: Number, required: true },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "PAID", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    bankSnapshot: {
      accountName: { type: String, required: true },
      accountNumber: { type: String, required: true },
      ifsc: { type: String, required: true },
    },
    debitTransactionId: { type: Schema.Types.ObjectId, ref: "CoinTransaction" },
    reference: { type: String },
    approvedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    paidBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    rejectedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    rejectionReason: { type: String },
    approvedAt: { type: Date },
    paidAt: { type: Date },
    rejectedAt: { type: Date },
  },
  { timestamps: true },
);

// The queue is read as "oldest pending first".
CoinPayoutSchema.index({ status: 1, createdAt: 1 });

export const CoinPayout = mongoose.model<ICoinPayout>(
  "CoinPayout",
  CoinPayoutSchema,
);

export default CoinPayout;
