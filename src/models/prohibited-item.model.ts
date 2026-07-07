import mongoose, { Schema, Types } from "mongoose";

export interface IProhibitedItem {
  _id: Types.ObjectId;
  name: string;
  icon: string; // emoji or icon name
  image: string; // optional image URL (uploaded via admin)
  bgColor: string; // background color hex e.g. "#FFF3E0"
  description: string;
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
