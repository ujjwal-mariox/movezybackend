import mongoose, { Schema, Types } from "mongoose";

export interface IRefundRequest {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  requestedBy: Types.ObjectId; // Admin who requested
  amount: number;
  reason: string;
  status: "PENDING_L1" | "PENDING_L2" | "APPROVED" | "REJECTED" | "PROCESSED";
  
  // Level 1 approval
  level1ApprovedBy?: Types.ObjectId;
  level1ApprovedAt?: Date;
  level1Comment?: string;
  
  // Level 2 approval
  level2ApprovedBy?: Types.ObjectId;
  level2ApprovedAt?: Date;
  level2Comment?: string;
  
  // Rejection
  rejectedBy?: Types.ObjectId;
  rejectedAt?: Date;
  rejectionReason?: string;
  
  // Processing
  processedAt?: Date;
  transactionId?: string;
  processedBy?: Types.ObjectId;
  
  // Auto-approve threshold (if amount <= threshold, skip L2)
  autoApproveThreshold?: number;
  
  createdAt: Date;
  updatedAt: Date;
}

const RefundRequestSchema = new Schema<IRefundRequest>(
  {
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["PENDING_L1", "PENDING_L2", "APPROVED", "REJECTED", "PROCESSED"],
      default: "PENDING_L1",
      index: true,
    },
    
    // Level 1
    level1ApprovedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    level1ApprovedAt: Date,
    level1Comment: String,
    
    // Level 2
    level2ApprovedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    level2ApprovedAt: Date,
    level2Comment: String,
    
    // Rejection
    rejectedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    rejectedAt: Date,
    rejectionReason: String,
    
    // Processing
    processedAt: Date,
    transactionId: String,
    processedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
    
    autoApproveThreshold: {
      type: Number,
      default: 500, // Auto-approve L2 if amount <= 500
    },
  },
  { timestamps: true },
);

// Compound indexes
RefundRequestSchema.index({ status: 1, createdAt: -1 });
RefundRequestSchema.index({ bookingId: 1, status: 1 });

export const RefundRequest = mongoose.model<IRefundRequest>(
  "RefundRequest",
  RefundRequestSchema,
);
