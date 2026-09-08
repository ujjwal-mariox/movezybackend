import mongoose, { Schema } from "mongoose";
import { IVehicle } from "../interfaces/vehicle";
import {
  normalizeFuelType,
  normalizeVehicleNumber,
} from "../services/vehicle-lifecycle.service";

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
      // Stored without spaces/dashes so "MH 12 AC 1965" and "MH12AC1965" are
      // one vehicle — the duplicate check and the unique index rely on it.
      set: (v: unknown) => normalizeVehicleNumber(v) || String(v ?? ""),
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
      // "Electric" is what the admin's master data and the app say; the old
      // enum only knew "EV", so every electric vehicle failed validation. The
      // setter maps EV/ev/Electronic/... onto the canonical label.
      // Validated against the admin's Fuel Types master at registration
      // (vehicle-lifecycle.validateVehicleAttributes), not a fixed enum.
      set: (v: unknown) => normalizeFuelType(v) ?? v,
    },

    rcFrontImage: String,
    rcBackImage: String,
    vehicleImages: [String],
    city: String,

    // Document validity. Captured at registration (optional there) and
    // editable by the admin; a daily job reminds at 30/15/7 days and takes the
    // vehicle off dispatch once any of them lapses.
    rcExpiryDate: Date,
    insuranceExpiryDate: Date,
    pucExpiryDate: Date,
    dispatchBlock: {
      blocked: { type: Boolean, default: false },
      reasons: [String],
      blockedAt: Date,
    },
    // Which "N days left" reminders have gone out, keyed by document, so a
    // renewal (new date) restarts the sequence and a re-run never re-sends.
    expiryReminders: [
      {
        _id: false,
        doc: String,
        expiryDate: Date,
        daysSent: [Number],
      },
    ],

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
    // Admin-created onboarding coupon (OnboardingCoupon), separate from the
    // peer referral above. Both stack, capped at the fee. Declared because
    // strict mode silently drops undeclared writes.
    couponCodeApplied: String,
    couponDiscount: {
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
// One live registration per number, platform-wide. Partial so a sold vehicle
// (soft-deleted by its previous owner) can be registered by the next one.
VehicleSchema.index(
  { vehicleNumber: 1 },
  {
    name: "unique_live_vehicle_number",
    unique: true,
    // MongoDB partial indexes accept equality but not $ne/$not, so live rows
    // must carry an explicit isDeleted:false (schema default + migration).
    partialFilterExpression: { isDeleted: false },
  },
);

export default mongoose.model<IVehicle>("Vehicle", VehicleSchema);
