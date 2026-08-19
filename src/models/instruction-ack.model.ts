import mongoose, { Schema, Types } from "mongoose";

/**
 * A driver's tap-through acknowledgment of the mandatory instructions for one
 * trip. This is the enforcement tier the client asked for: instructions stop
 * being a page nobody is known to have read and become a per-trip checklist
 * with a record. Per-instruction usage stats read from these rows.
 */
export interface IInstructionAck {
  _id?: Types.ObjectId;
  driverId: Types.ObjectId;
  bookingId: Types.ObjectId;
  instructionIds: Types.ObjectId[];
  acknowledgedAt: Date;
}

const InstructionAckSchema = new Schema<IInstructionAck>(
  {
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    instructionIds: [
      { type: Schema.Types.ObjectId, ref: "DriverInstruction" },
    ],
    acknowledgedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One acknowledgment per driver per trip.
InstructionAckSchema.index({ driverId: 1, bookingId: 1 }, { unique: true });
InstructionAckSchema.index({ instructionIds: 1 });

const InstructionAck = mongoose.model<IInstructionAck>(
  "InstructionAck",
  InstructionAckSchema,
);

export default InstructionAck;
