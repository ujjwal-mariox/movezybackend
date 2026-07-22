import mongoose, { Schema, Types } from "mongoose";

export interface IBadge {
  _id: Types.ObjectId;
  name: string;
  description: string;
  icon: string;
  category: string;
  unlockType: string;
  unlockValue: number;
  sortOrder: number;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const BadgeSchema = new Schema<IBadge>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    icon: {
      type: String,
      default: "🏆",
      trim: true,
    },
    category: {
      type: String,
      // The five categories the My Badge design filters by: Onboarding &
      // Training, Trip Milestones, Performance & Quality, Engagement &
      // Community, Earnings & Growth. "engagement" and "earnings" were absent,
      // so no badge in those tabs could ever exist.
      enum: [
        "onboarding",
        "milestones",
        "performance",
        "engagement",
        "earnings",
      ],
      default: "milestones",
    },
    unlockType: {
      type: String,
      // Every type here is evaluated against REAL driver data in getBadges.
      // "manual" is for badges only an admin can award (e.g. Community
      // Helper) — they stay locked until awarded, never fake-unlocked.
      enum: [
        "kyc_verified",
        "trips",
        "rating",
        "zero_cancellation",
        "manual",
        "training_completed",
        "earnings",
        "monthly_earnings",
        "long_distance",
        "consistency",
        "on_time",
        "peak_hours",
        "safety",
        "feedback",
        "referrals",
      ],
      default: "manual",
    },
    unlockValue: {
      type: Number,
      default: 0,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
    },
  },
  { timestamps: true },
);

BadgeSchema.index({ isActive: 1, sortOrder: 1 });

export default mongoose.model<IBadge>("Badge", BadgeSchema);
