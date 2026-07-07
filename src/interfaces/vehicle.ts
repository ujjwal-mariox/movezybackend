import { Types } from "mongoose";

export type VehicleType = "2W" | "3W" | "4W";

export interface IVehicle {
  driverId: Types.ObjectId;

  vehicleNumber: string;
  vehicleType: VehicleType;
  vehicleBodyType?: string;
  fuelType?: "Petrol" | "Diesel" | "CNG" | "EV";

  rcFrontImage?: string;
  rcBackImage?: string;
  vehicleImages?: string[];
  city?: string;

  // Assigned driver info (who physically drives this vehicle)
  assignedDriverName?: string;
  assignedDriverPhone?: string;
  assignedDriverLicenseFrontImage?: string;
  assignedDriverLicenseBackImage?: string;

  // Per-vehicle onboarding payment
  onboardingFeePaid: boolean;
  onboardingPaymentId?: string;
  onboardingOrderId?: string;
  referralCodeApplied?: string;
  referralDiscount: number;

  // Verification
  verificationStatus: "pending" | "under_verification" | "approved" | "rejected";
  rejectionReason?: string;

  isPrimary: boolean;
  isActive: boolean;
  isDeleted: boolean;
  deletedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}
