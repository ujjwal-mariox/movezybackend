import mongoose, { Schema, Types } from "mongoose";

export interface IEnterpriseInquiry {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  companyName?: string;
  message?: string;
  source: "GET_IN_TOUCH" | "ENTERPRISE_ENTRY";
  status: "NEW" | "CONTACTED" | "CONVERTED" | "CLOSED";
  adminNotes?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const EnterpriseInquirySchema = new Schema<IEnterpriseInquiry>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    companyName: {
      type: String,
      trim: true,
    },
    message: {
      type: String,
      trim: true,
    },
    source: {
      type: String,
      enum: ["GET_IN_TOUCH", "ENTERPRISE_ENTRY"],
      default: "GET_IN_TOUCH",
    },
    status: {
      type: String,
      enum: ["NEW", "CONTACTED", "CONVERTED", "CLOSED"],
      default: "NEW",
      index: true,
    },
    adminNotes: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

export const EnterpriseInquiry = mongoose.model<IEnterpriseInquiry>(
  "EnterpriseInquiry",
  EnterpriseInquirySchema,
);
