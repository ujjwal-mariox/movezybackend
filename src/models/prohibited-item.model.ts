import mongoose, { Schema, Types } from "mongoose";

export interface IProhibitedItem {
  _id: Types.ObjectId;
  name: string;
  icon: string; // emoji or icon name
  image: string; // optional image URL (uploaded via admin)
  bgColor: string; // background color hex e.g. "#FFF3E0"
  description: string;
  /// Admin-declared severity. Display/triage only — there is no automated
  /// detection anywhere, so this drives ordering and badges, not enforcement.
  riskLevel: "HIGH" | "MEDIUM" | "LOW";
  isActive: boolean;
  sortOrder: number;
}

const ProhibitedItemSchema = new Schema<IProhibitedItem>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    icon: {
      type: String,
      default: "",
    },
    image: {
      type: String,
      default: "",
    },
    bgColor: {
      type: String,
      default: "#FFF3E0",
    },
    description: {
      type: String,
      default: "",
    },
    riskLevel: {
      type: String,
      enum: ["HIGH", "MEDIUM", "LOW"],
      default: "MEDIUM",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

export default mongoose.model<IProhibitedItem>(
  "ProhibitedItem",
  ProhibitedItemSchema,
);
