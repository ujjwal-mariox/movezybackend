import { Types } from "mongoose";

export interface IVehicleType {
  _id?: Types.ObjectId;

  name: string;
  description?: string;
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
