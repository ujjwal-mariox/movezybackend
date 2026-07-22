import { Types } from "mongoose";

export interface IVehicleType {
  _id?: Types.ObjectId;

  name: string;
  description?: string;

  /**
   * Which broad category this type belongs to ("2W" | "3W" | "4W" | "HV").
   * Nothing linked a VehicleType to a category before, so the only way to map a
   * vehicle's coarse "2W" to a bookable type was to guess from its name — and
   * "2 Wheeler" and "Scooter" are both 2W, so it was a coin-flip.
   */
  categoryCode?: string;

  /**
   * The type to use when all that is known is the category. Exactly one type per
   * category should carry this, which is what makes a category-only vehicle
   * resolvable without guessing.
   */
  isDefaultForCategory?: boolean;

  maxWeightKg: number;

  // Cargo area dimensions (feet)
  lengthFt?: number;
  breadthFt?: number;
  heightFt?: number;

  baseFare: number;
  perKmRate: number;
  perMinuteRate: number;
  minDistanceKm: number;

  surgeMultiplier?: number;
  cancellationFee?: number;

  // Booking range limits
  minRangeKm: number;
  maxRangeKm: number;

  // Service area settings
  allowIntraCity: boolean;
  allowInterCity: boolean;

  image?: string;
  icon?: string;
  sortOrder?: number;
  showOnHomeScreen: boolean;
  isActive: boolean;
  isDeleted: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}
