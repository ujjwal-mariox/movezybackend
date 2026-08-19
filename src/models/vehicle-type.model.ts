import mongoose, { Schema } from "mongoose";
import { IVehicleType } from "../interfaces/vehicle-type";

const VehicleTypeSchema = new Schema<IVehicleType>(
  {
    name: { type: String, required: true, unique: true },
    description: { type: String },
    // The category this type belongs to. Without it, mapping a vehicle's coarse
    // "2W"/"3W"/"4W" onto a bookable type meant guessing from the name.
    categoryCode: {
      type: String,
      enum: ["2W", "3W", "4W", "HV"],
      index: true,
    },
    // The canonical type for that category, used when only the category is
    // known. Enforced as one-per-category by the partial unique index below.
    isDefaultForCategory: { type: Boolean, default: false },
    maxWeightKg: { type: Number, required: true },
    // Cargo area dimensions (feet)
    lengthFt: { type: Number, default: 0, min: 0 },
    breadthFt: { type: Number, default: 0, min: 0 },
    heightFt: { type: Number, default: 0, min: 0 },
    baseFare: { type: Number, required: true, min: 0 },
    perKmRate: { type: Number, required: true, min: 0 },
    perMinuteRate: { type: Number, required: true, min: 0 },
    minDistanceKm: { type: Number, default: 1, min: 0 },
    surgeMultiplier: { type: Number, default: 1, min: 1 },
    cancellationFee: { type: Number, default: 0, min: 0 },
    // Booking range limits
    minRangeKm: { type: Number, default: 1, min: 0 },
    maxRangeKm: { type: Number, default: 100, min: 0 },
    // Service area settings
    allowIntraCity: { type: Boolean, default: true },
    allowInterCity: { type: Boolean, default: false },
    image: { type: String },
    icon: { type: String },
    sortOrder: { type: Number, default: 0 },
    // ETA factor for DISPLAY only. Billing time deliberately stays on the
    // 25 km/h city model (routing.service CITY_SPEED_KMPH) — this scales the
    // per-vehicle ETA a customer sees (a bike beats a truck), never the fare.
    avgSpeedKmph: { type: Number, default: 25, min: 5, max: 80 },
    // What this vehicle is fit to carry. Informational for dispatch/admin —
    // declared here so strict mode doesn't drop it.
    loadTypes: [{ type: String, enum: ["FRAGILE", "HEAVY", "LIQUID"] }],
    showOnHomeScreen: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

VehicleTypeSchema.index({ isDeleted: 1, isActive: 1 });
VehicleTypeSchema.index({ sortOrder: 1 });

// Exactly one default per category — enforced here rather than by convention,
// because two defaults would put the ambiguity straight back: resolving a "2W"
// vehicle would once again be a coin-flip between "2 Wheeler" and "Scooter".
// Named explicitly: without a distinct name this collides with the plain
// `categoryCode` index above (same key, different options -> IndexKeySpecsConflict).
VehicleTypeSchema.index(
  { categoryCode: 1 },
  {
    name: "one_default_per_category",
    unique: true,
    partialFilterExpression: { isDefaultForCategory: true },
  },
);

export default mongoose.model<IVehicleType>("VehicleType", VehicleTypeSchema);
