import mongoose, { Schema, Types } from "mongoose";

export interface IDriverInstruction {
  _id: Types.ObjectId;
  text: string;
  icon: string;
  sortOrder: number;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DriverInstructionSchema = new Schema<IDriverInstruction>(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
    icon: {
      type: String,
      default: "📋",
      trim: true,
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

DriverInstructionSchema.index({ isActive: 1, sortOrder: 1 });

export default mongoose.model<IDriverInstruction>(
  "DriverInstruction",
  DriverInstructionSchema,
);
