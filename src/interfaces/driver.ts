import { Types } from "mongoose";

export type DriverStatus =
  | "draft"
  | "documents_uploaded"
  | "vehicle_added"
  | "under_verification"
  | "approved"
  | "rejected"
  | "suspended";

export interface IDriverAddress {
  _id?: Types.ObjectId;
  type: "current" | "permanent";
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  pincode: string;
  country?: string;
}

export interface IDriverBankDetails {
  accountHolderName: string;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  isVerified?: boolean;
}

export interface IDriver {
  _id?: Types.ObjectId;

  mobileNumber: string;
  countryCode: string;
  userId?: Types.ObjectId;

  fullName: string;
  email?: string;
  gender?: "Male" | "Female" | "Other";
  dob?: string;
  bloodGroup?: string;
  profilePhoto?: string;
  languages?: string[];

  city: string;
  state: string;

  status: DriverStatus;
  rejectionReason?: string;
  suspensionReason?: string;

  isActive: boolean;
  isOnline: boolean;
  isDeleted: boolean;
  deletedAt?: Date;

  currentBookingId?: Types.ObjectId;
  rating?: number;
  totalRides?: number;

  // Bank Details
  bankDetails?: IDriverBankDetails;

  // Addresses
  addresses?: IDriverAddress[];

  // Referral
  referralCode?: string;
  referredBy?: Types.ObjectId;

  // Training
  completedLessons?: string[];
  trainingCompletedAt?: Date;

  // Badges
  unlockedBadges?: string[];

  // Onboarding Payment
  onboardingFeePaid?: boolean;
  onboardingPaymentId?: string;

  // Instructions
  instructionsAcknowledgedAt?: Date;

  // Onboarding Reminders
  lastOnboardingReminder?: Date;

  // Daily Checklist
  lastChecklistAt?: Date;
  lastChecklistImages?: string[];

  // Notification settings
  fcmToken?: string;
  isNotificationEnabled?: boolean;

  // Device Info (for battery & app version tracking)
  deviceInfo?: {
    platform: "android" | "ios";
    osVersion: string;
    appVersion: string;
    deviceModel: string;
    batteryLevel?: number;
    isCharging?: boolean;
    lastUpdated?: Date;
  };

  // Location (for real-time tracking)
  location?: {
    lat: number;
    lng: number;
    heading?: number;
    speed?: number;
    updatedAt?: Date;
  };

  createdAt?: Date;
  updatedAt?: Date;
}
