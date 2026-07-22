import mongoose, { Schema } from "mongoose";
import { IVehicle } from "../interfaces/vehicle";

const VehicleSchema = new Schema<IVehicle>(
  {
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },

    vehicleNumber: {
      type: String,
      required: true,
      uppercase: true,
    },

    vehicleType: {
      type: String,
      enum: ["2W", "3W", "4W"],
    },
    // The catalog type the driver actually registered. `vehicleType` above is
    // only a category, and dispatch matches on a specific VehicleType id — so a
    // vehicle without this can never receive a booking no matter how approved
    // it is.
    vehicleTypeId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleType",
      index: true,
    },

    vehicleBodyType: String,

    fuelType: {
      type: String,
      enum: ["Petrol", "Diesel", "CNG", "EV"],
    },

    rcFrontImage: String,
    rcBackImage: String,
    vehicleImages: [String],
    city: String,

    // Assigned driver info
    assignedDriverName: String,
    assignedDriverPhone: String,
    assignedDriverLicenseFrontImage: String,
    assignedDriverLicenseBackImage: String,

    // Per-vehicle onboarding payment
    onboardingFeePaid: {
      type: Boolean,
      default: false,
    },
    onboardingPaymentId: String,
    onboardingOrderId: String,
    referralCodeApplied: String,
    referralDiscount: {
      type: Number,
      default: 0,
    },

    // Verification
    verificationStatus: {
      type: String,
      enum: ["pending", "under_verification", "approved", "rejected"],
      default: "pending",
    },
    rejectionReason: String,

    isPrimary: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: Date,
  },
  { timestamps: true }
);

VehicleSchema.index({ driverId: 1, isDeleted: 1 });
VehicleSchema.index({ vehicleNumber: 1 });

export default mongoose.model<IVehicle>("Vehicle", VehicleSchema);
