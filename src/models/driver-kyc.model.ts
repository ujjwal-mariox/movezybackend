import mongoose, { Schema } from "mongoose";
import { IDriverKyc } from "../interfaces/driver-kyc";

/**
 * One review verdict per document. Without this the whole KYC set shared a
 * single `isVerified` flag, so the admin's per-document "Approve" had nothing
 * granular to write to and approved every document at once.
 */
const DocumentReviewSchema = new Schema(
  {
    status: {
      type: String,
      enum: ["PENDING", "VERIFIED", "REJECTED"],
      default: "PENDING",
    },
    reviewedAt: Date,
    reviewedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    rejectionReason: String,
  },
  { _id: false },
);

const DriverKycSchema = new Schema<IDriverKyc>(
  {
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      unique: true,
    },

    aadhaar: {
      number: String,
      frontImage: String,
      backImage: String,
    },

    pan: {
      number: String,
      frontImage: String,
      backImage: String,
    },

    drivingLicense: {
      number: String,
      frontImage: String,
      backImage: String,
      expiryDate: String,
    },

    selfie: String,

    vehicleRc: {
      image: String,
      vehicleNumber: String,
    },

    vehicleImages: [String],
    city: String,
    bodyType: String,
    fuelType: String,

    documentStatus: {
      aadhaar: { type: DocumentReviewSchema, default: () => ({}) },
      pan: { type: DocumentReviewSchema, default: () => ({}) },
      drivingLicense: { type: DocumentReviewSchema, default: () => ({}) },
      selfie: { type: DocumentReviewSchema, default: () => ({}) },
      vehicleRc: { type: DocumentReviewSchema, default: () => ({}) },
    },

    /** Derived: true only when every SUBMITTED document is VERIFIED. */
    isVerified: {
      type: Boolean,
      default: false,
    },

    verifiedAt: Date,
  },
  { timestamps: true },
);

export default mongoose.model<IDriverKyc>("DriverKyc", DriverKycSchema);
