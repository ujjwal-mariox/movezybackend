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
      enum: ["onboarding", "milestones", "performance"],
      default: "milestones",
    },
    unlockType: {
      type: String,
      enum: ["kyc_verified", "trips", "rating", "zero_cancellation", "manual"],
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
