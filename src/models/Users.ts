import mongoose, { Schema } from "mongoose";
import { IUser } from "../interfaces/users";

const UserSchema: Schema<IUser> = new Schema(
  {
    fullName: {
      type: String,
      default: "",
      trim: true,
    },
    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },
    profileImage: {
      type: String,
      default: "",
      trim: true,
    },
    gender: {
      type: String,
      default: "Male",
      enum: ["Male", "Female", "Other"],
    },
    dob: {
      type: String,
      default: "",
    },
    countryCode: {
      type: String,
      required: [true, "Country code is required!"],
      default: "+91",
    },
    mobileNumber: {
      type: String,
      required: [true, "Mobile number is required!"],
      unique: true,
      match: [/^[6-9]\d{9}$/, "Please enter a valid 10-digit mobile number!"],
    },
    /**
     * Whether the customer agreed to receive booking updates over WhatsApp.
     * The login screen has always shown this checkbox, but the value was only
     * ever held in widget state and thrown away — so an opt-in was never
     * recorded, and neither was an opt-out. Consent for marketing messages has
     * to be stored to be worth anything.
     */
    whatsappOptIn: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isBlocked: {
      type: Boolean,
      default: false,
      index: true,
    },
    blockedAt: {
      type: Date,
      default: null,
    },
    blockReason: {
      type: String,
      default: null,
      trim: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    notificationAllowed: {
      type: Boolean,
      default: true,
    },
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
    },
    referredBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    referralApplied: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// Compound indexes
UserSchema.index({ mobileNumber: 1, isDeleted: 1 });
UserSchema.index({ referralCode: 1 }, { sparse: true });

// Prevent overwrite error in dev / hot reload
const User = mongoose.models.User || mongoose.model<IUser>("User", UserSchema);

export default User;
