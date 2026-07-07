import mongoose, { Schema, Types } from "mongoose";

/**
 * Master Data – admin-managed lookup tables for:
 *   • Cities (operation areas)
 *   • Vehicle Body Types
 *   • Fuel Types
 *
 * Each collection follows the same shape so the admin can
 * create / update / toggle-active / soft-delete entries.
 */

// ──────────────────────── Interfaces ────────────────────────

export interface ICity {
  _id: Types.ObjectId;
  name: string;
  state: string;
  isActive: boolean;
  sortOrder: number;
}

export interface IBodyType {
  _id: Types.ObjectId;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

export interface IFuelType {
  _id: Types.ObjectId;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

// ──────────────────────── Schemas ────────────────────────

const CitySchema = new Schema<ICity>(
  {
    name: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
CitySchema.index({ name: 1, state: 1 }, { unique: true });
CitySchema.index({ isActive: 1 });

const BodyTypeSchema = new Schema<IBodyType>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
BodyTypeSchema.index({ isActive: 1 });

const FuelTypeSchema = new Schema<IFuelType>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
FuelTypeSchema.index({ isActive: 1 });

// ──────────────────────── Models ────────────────────────

export const City = mongoose.model<ICity>("City", CitySchema);
export const BodyType = mongoose.model<IBodyType>("BodyType", BodyTypeSchema);
export const FuelType = mongoose.model<IFuelType>("FuelType", FuelTypeSchema);
