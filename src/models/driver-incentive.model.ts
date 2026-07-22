import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * A bonus a driver has actually earned and is owed.
 *
 * Incentives used to be computed on the fly from the driver's trip counts and
 * shown as "Incentives Unlocked" next to "Total (Earnings + Bonus)" — but
 * nothing ever credited them, so the driver was promised money that reached
 * neither their payout balance nor their wallet. Awarding writes a row here,
 * and payouts sum it.
 *
 * `periodKey` scopes the award to the window it was earned in (a day for daily
 * and peak, an ISO week for weekly). With the unique index below, awarding is
 * idempotent: re-running after every trip on the same day cannot pay twice.
 */
export type IncentiveType = "daily" | "weekly" | "peak";

export interface IDriverIncentive extends Document {
  driverId: Types.ObjectId;
  type: IncentiveType;
  /** "2026-07-17" for daily/peak, "2026-W29" for weekly. */
  periodKey: string;
  title: string;
  amount: number;
  /** Trips completed in the window when this was awarded — for auditability. */
  progressAtAward: number;
  target: number;
  awardedAt: Date;
}

const DriverIncentiveSchema = new Schema<IDriverIncentive>(
  {
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["daily", "weekly", "peak"],
      required: true,
    },
    periodKey: { type: String, required: true },
    title: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    progressAtAward: { type: Number, default: 0 },
    target: { type: Number, default: 0 },
    awardedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// The guarantee that a bonus can only ever be paid once per window.
DriverIncentiveSchema.index(
  { driverId: 1, type: 1, periodKey: 1 },
  { unique: true },
);

export default mongoose.model<IDriverIncentive>(
  "DriverIncentive",
  DriverIncentiveSchema,
);
