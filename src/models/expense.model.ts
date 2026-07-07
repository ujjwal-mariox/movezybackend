import mongoose, { Schema, Types } from "mongoose";

export interface IExpense {
  _id: Types.ObjectId;
  category: "DRIVER_PAYOUT" | "REFUND" | "MARKETING" | "OPERATIONS" | "SUPPORT" | "TECHNOLOGY" | "OTHER";
  subcategory?: string;
  amount: number;
  description: string;
  date: Date;
  driverId?: Types.ObjectId;
  bookingId?: Types.ObjectId;
  refundRequestId?: Types.ObjectId;
  paymentMethod?: string;
  transactionId?: string;
  invoiceNumber?: string;
  attachments?: string[];
  status: "PENDING" | "APPROVED" | "PAID" | "CANCELLED";
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  createdBy: Types.ObjectId;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExpenseSchema = new Schema<IExpense>(
  {
    category: {
      type: String,
      enum: ["DRIVER_PAYOUT", "REFUND", "MARKETING", "OPERATIONS", "SUPPORT", "TECHNOLOGY", "OTHER"],
      required: true,
      index: true,
    },
    subcategory: String,
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
    },
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
    },
    refundRequestId: {
      type: Schema.Types.ObjectId,
      ref: "RefundRequest",
    },
    paymentMethod: String,
    transactionId: String,
    invoiceNumber: String,
    attachments: [String],
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "PAID", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    approvedAt: Date,
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    notes: String,
  },
  { timestamps: true },
);

// Compound indexes
ExpenseSchema.index({ category: 1, date: -1 });
ExpenseSchema.index({ status: 1, date: -1 });
ExpenseSchema.index({ createdBy: 1, createdAt: -1 });

export const Expense = mongoose.model<IExpense>("Expense", ExpenseSchema);
