import mongoose, { Schema } from "mongoose";
import { IDriver } from "../interfaces/driver";

const DriverSchema = new Schema<IDriver>(
  {
    mobileNumber: {
      type: String,
      required: true,
      match: [/^[6-9]\d{9}$/, "Please enter a valid 10-digit mobile number"],
    },

    countryCode: {
      type: String,
      default: "+91",
    },

    fullName: {
      type: String,
      // required: true,
      default: "",
      trim: true,
    },

    bloodGroup: {
      type: String,
      // required: true,
      default: "",
      trim: true,
    },

    email: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },

    gender: {
      type: String,
      default: "Male",
      enum: ["Male", "Female", "Other"],
    },

    dob: String,

    city: {
      type: String,
      // required: true,
      default: "",
    },

    state: {
      type: String,
      // required: true,
      default: "",
    },

    status: {
      type: String,
      enum: [
        "draft",
        "documents_uploaded",
        "vehicle_added",
        "under_verification",
        "approved",
        "rejected",
        "suspended",
      ],
      default: "draft",
      index: true,
    },

    rejectionReason: String,
    suspensionReason: String,

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isOnline: {
      type: Boolean,
      default: false,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: Date,
    currentBookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    totalRides: {
      type: Number,
      default: 0,
    },
    fcmToken: {
      type: String,
      default: null,
    },
    isNotificationEnabled: {
      type: Boolean,
      default: true,
    },

    // Profile photo
    profilePhoto: String,

    // Languages
    languages: [String],

    // Bank Details
    // Which onboarding-reminder stages (hours since signup) were already
    // sent, so the scheduler nudges once per stage across restarts.
    onboardingRemindersSent: [{ type: Number }],
    bankDetails: {
      accountHolderName: String,
      bankName: String,
      accountNumber: String,
      ifscCode: String,
      isVerified: { type: Boolean, default: false },
    },

    // Pending driver-requested change to bankDetails, held for an admin
    // decision. Every field is declared because the schema is strict — an
    // undeclared path would be silently dropped on save and the "pending"
    // request would vanish without an error.
    bankDetailsUpdateRequest: {
      accountHolderName: String,
      bankName: String,
      accountNumber: String,
      ifscCode: String,
      status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED"] },
      requestedAt: Date,
      decidedAt: Date,
      rejectionReason: String,
    },

    // Addresses
    addresses: [
      {
        type: { type: String, enum: ["current", "permanent"] },
        addressLine1: String,
        addressLine2: String,
        city: String,
        state: String,
        pincode: String,
        country: { type: String, default: "India" },
      },
    ],

    // Referral
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: Schema.Types.ObjectId, ref: "Driver" },

    // Training
    completedLessons: [String],
    trainingCompletedAt: Date,

    // Badges
    unlockedBadges: [String],

    // Onboarding Payment
    onboardingFeePaid: { type: Boolean, default: false },
    onboardingPaymentId: String,

    // Instructions
    instructionsAcknowledgedAt: Date,

    // Onboarding Reminders
    lastOnboardingReminder: Date,

    // Daily Checklist
    lastChecklistAt: Date,
    lastChecklistImages: [String],

    // Device Info (for battery & app version tracking)
    deviceInfo: {
      platform: { type: String, enum: ["android", "ios"] },
      osVersion: String,
      appVersion: String,
      deviceModel: String,
      batteryLevel: { type: Number, min: 0, max: 100 },
      isCharging: Boolean,
      lastUpdated: Date,
    },

    // Real-time location
    location: {
      lat: Number,
      lng: Number,
      heading: Number,
      speed: Number,
      updatedAt: Date,
    },
  },
  { timestamps: true },
);

// Compound indexes
DriverSchema.index({ isOnline: 1, status: 1, isActive: 1 });
DriverSchema.index({ mobileNumber: 1, countryCode: 1 });

export default mongoose.model<IDriver>("Driver", DriverSchema);
