import mongoose, { Schema, Types } from "mongoose";

export interface IDriverInstruction {
  _id: Types.ObjectId;
  text: string;
  icon: string;
  sortOrder: number;
  /// Mandatory = the driver must follow it; Advisory = guidance. Display
  /// semantics — no enforcement pipeline exists, and the panel says so.
  instructionType: "MANDATORY" | "ADVISORY";
  /// Bumped on every edit, so staff can tell which revision drivers saw.
  version: number;
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
    instructionType: {
      type: String,
      enum: ["MANDATORY", "ADVISORY"],
      default: "ADVISORY",
    },
    version: { type: Number, default: 1 },
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
