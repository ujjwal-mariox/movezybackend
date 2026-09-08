import mongoose, { Schema, Types } from "mongoose";

/**
 * One masked-call attempt between the two parties of a booking.
 *
 * Kept so support can answer "did the driver try to call?" without either
 * party's real number ever appearing in an app payload. The provider call id
 * lets an admin look the call up in the telephony console.
 */
export interface ICallLog {
  _id?: Types.ObjectId;
  bookingId: Types.ObjectId;
  initiatorType: "USER" | "DRIVER";
  initiatorId: Types.ObjectId;
  targetType: "USER" | "DRIVER";
  targetId: Types.ObjectId;
  mode: "BRIDGE" | "DIRECT" | "UNAVAILABLE";
  provider?: string;
  providerCallId?: string;
  error?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const CallLogSchema = new Schema<ICallLog>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    initiatorType: { type: String, enum: ["USER", "DRIVER"], required: true },
    initiatorId: { type: Schema.Types.ObjectId, required: true },
    targetType: { type: String, enum: ["USER", "DRIVER"], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    mode: { type: String, enum: ["BRIDGE", "DIRECT", "UNAVAILABLE"], required: true },
    provider: String,
    providerCallId: String,
    error: String,
  },
  { timestamps: true },
);

CallLogSchema.index({ bookingId: 1, initiatorId: 1, createdAt: -1 });

const CallLog = mongoose.model<ICallLog>("CallLog", CallLogSchema);
export default CallLog;
