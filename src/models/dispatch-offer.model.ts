import mongoose, { Schema, Types } from "mongoose";

/**
 * One booking offer to one driver, persisted at dispatch time.
 *
 * Until this existed, offers lived only in an ephemeral Redis set, so
 * acceptance rate was structurally unknowable — the admin driver cards had to
 * say "cannot be shown" instead of a number. Rows accrue from this deploy
 * onward, so anything derived from them is labeled "since tracking began".
 *
 * Lifecycle: PENDING at emit → ACCEPTED / SKIPPED by the driver's own action,
 * or EXPIRED when the offer window lapses or the booking is taken by someone
 * else. EXPIRED counts against acceptance the same way ignoring a ring does.
 */
export interface IDispatchOffer {
  _id?: Types.ObjectId;
  bookingId: Types.ObjectId;
  driverId: Types.ObjectId;
  offeredAt: Date;
  expiresAt: Date;
  response: "PENDING" | "ACCEPTED" | "SKIPPED" | "EXPIRED";
  respondedAt?: Date;
}

const DispatchOfferSchema = new Schema<IDispatchOffer>(
  {
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    offeredAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    response: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "SKIPPED", "EXPIRED"],
      default: "PENDING",
      index: true,
    },
    respondedAt: Date,
  },
  { timestamps: true },
);

// Acceptance-rate aggregation scans by driver; offer expiry scans by state.
DispatchOfferSchema.index({ driverId: 1, offeredAt: -1 });
DispatchOfferSchema.index({ response: 1, expiresAt: 1 });
// One offer per driver per booking — re-dispatch refreshes rather than
// duplicating, so a twice-notified driver is not counted twice.
DispatchOfferSchema.index({ bookingId: 1, driverId: 1 }, { unique: true });

const DispatchOffer = mongoose.model<IDispatchOffer>(
  "DispatchOffer",
  DispatchOfferSchema,
);

export default DispatchOffer;
